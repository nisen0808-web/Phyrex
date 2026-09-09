'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { createWorld } = require('../core/world-engine');
const { randomFloat } = require('../core/random-engine');
const { nextWorldId } = require('../core/world-id-engine');
const { loadDatabaseConfig } = require('../core/database-config-engine');
const { saveWorldToDatabase, loadWorldFromDatabase, listDatabaseWorlds } = require('../core/database-engine');
const { prepareDatabaseStartup } = require('../core/database-startup-engine');
const { parseArgs, buildStartupOptions, createApiServerFromArgs } = require('../demo/api-server');

const entrypoint = path.join(__dirname, '..', 'demo', 'api-server.js');

async function withDatabase(test) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-startup-recovery-'));
  const database = { provider: 'jsonl', directory: dir, name: 'recovery' };
  try {
    await test(database, loadDatabaseConfig(database, {}));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function world(id = 'checkpoint', tick = 17) {
  const value = createWorld({ id, seed: 'startup-replay-seed' });
  value.tick = tick;
  return value;
}

function recover(database, patch = {}) {
  return prepareDatabaseStartup({ database, mode: 'required', ...patch }, {});
}

function readRecords(config) {
  return fs.readFileSync(config.worldsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

function writeRecords(config, records) {
  fs.writeFileSync(config.worldsFile, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
}

function expectCode(fn, code) {
  assert.throws(fn, error => error.code === code, `expected ${code}`);
}

async function testEmptyAndDisabled() {
  await withDatabase((database, config) => {
    assert.strictEqual(recover(database, { mode: 'off' }).summary.status, 'off');
    assert.strictEqual(recover(database, { mode: 'if-present' }).summary.status, 'new');
    assert.strictEqual(fs.existsSync(config.worldsFile), false, 'recovery must not create data files');
    expectCode(() => recover(database), 'DATABASE_STARTUP_MISSING');
    expectCode(() => recover(database, { mode: 'if-present', worldId: 'missing' }), 'DATABASE_STARTUP_MISSING');
    for (const provider of ['disabled', 'sqlite', 'postgres']) {
      expectCode(() => recover({ ...database, provider }), 'DATABASE_STARTUP_PROVIDER');
    }
  });
}

async function testWorldSelection() {
  await withDatabase(database => {
    saveWorldToDatabase(world('first', 30), { database });
    assert.strictEqual(recover(database).world.id, 'first');
    saveWorldToDatabase(world('second', 2), { database });
    expectCode(() => recover(database), 'DATABASE_STARTUP_AMBIGUOUS');
    expectCode(() => recover(database, { mode: 'if-present' }), 'DATABASE_STARTUP_AMBIGUOUS');
    assert.strictEqual(recover(database, { worldId: 'first' }).world.tick, 30);
    assert.strictEqual(recover(database, { worldId: 'second' }).world.tick, 2);
    expectCode(() => recover(database, { worldId: 'missing' }), 'DATABASE_STARTUP_MISSING');
  });
}

async function testLatestMeansAppendOrder() {
  await withDatabase((database, config) => {
    const value = world('checkpoint', 100);
    saveWorldToDatabase(value, { database });
    value.tick = 5;
    value.marker = 'rollback';
    saveWorldToDatabase(value, { database });
    value.marker = 'same_tick_latest';
    saveWorldToDatabase(value, { database });
    const before = fs.readFileSync(config.worldsFile);
    const restored = recover(database);
    assert.strictEqual(restored.world.tick, 5);
    assert.strictEqual(restored.world.marker, 'same_tick_latest');
    assert.strictEqual(restored.summary.sequence, 3);
    assert.strictEqual(loadWorldFromDatabase('checkpoint', { database }).world.marker, 'same_tick_latest');
    assert.strictEqual(listDatabaseWorlds({ database })[0].sequence, 3);
    assert.deepStrictEqual(fs.readFileSync(config.worldsFile), before, 'recovery must leave source bytes unchanged');
  });
}

async function testRandomAndIdContinuation() {
  await withDatabase(database => {
    const value = world();
    randomFloat(value, 'startup.test');
    nextWorldId(value, 'fixture', 'startup.test');
    saveWorldToDatabase(value, { database });
    const restored = recover(database).world;
    assert.deepStrictEqual(restored.random, value.random);
    for (let i = 0; i < 12; i += 1) {
      assert.strictEqual(randomFloat(restored, 'startup.test'), randomFloat(value, 'startup.test'));
      assert.strictEqual(nextWorldId(restored, 'fixture', 'startup.test'), nextWorldId(value, 'fixture', 'startup.test'));
    }
    assert.strictEqual(restored.tick, 17, 'restoration must not simulate extra ticks');
  });
}

async function testCorruptJsonAndPhysicalLine() {
  await withDatabase((database, config) => {
    saveWorldToDatabase(world(), { database });
    fs.appendFileSync(config.worldsFile, '\n{secret-broken-tail');
    const before = fs.readFileSync(config.worldsFile);
    assert.throws(() => recover(database, { mode: 'if-present' }), error => (
      error.code === 'DATABASE_INVALID_RECORD' && error.line === 3 && !error.message.includes('secret-broken-tail')
    ));
    expectCode(() => saveWorldToDatabase(world(), { database }), 'DATABASE_INVALID_RECORD');
    assert.deepStrictEqual(fs.readFileSync(config.worldsFile), before);
  });
}

async function testInvalidRecordsFailClosed() {
  const mutations = [
    record => { record.sequence = 0; },
    record => { record.recordType = 'world_event'; },
    record => { record.envelope.world.tick += 1; },
    record => { record.envelope.worldId = 'different'; },
    record => { record.envelope.world.entities = []; },
    record => { record.envelope.world.locations = null; },
    record => { record.schemaVersion = 0; },
    record => { record.tick = -1; },
  ];
  for (const mutate of mutations) {
    await withDatabase((database, config) => {
      saveWorldToDatabase(world(), { database });
      const records = readRecords(config);
      mutate(records[0]);
      writeRecords(config, records);
      expectCode(() => recover(database, { mode: 'if-present' }), 'DATABASE_INVALID_RECORD');
    });
  }
  for (const payload of ['null', '[]', '42', '"text"']) {
    await withDatabase((database, config) => {
      fs.writeFileSync(config.worldsFile, `${payload}\n`);
      expectCode(() => recover(database, { mode: 'if-present' }), 'DATABASE_INVALID_RECORD');
    });
  }
}

async function testSequenceAndFutureSchema() {
  await withDatabase((database, config) => {
    saveWorldToDatabase(world(), { database });
    const records = readRecords(config);
    writeRecords(config, [records[0], records[0]]);
    expectCode(() => recover(database), 'DATABASE_INVALID_RECORD');
    records[0].sequence = 10;
    writeRecords(config, records);
    assert.strictEqual(saveWorldToDatabase(world(), { database }).sequence, 11, 'sequence must not be based on row count');
    const future = readRecords(config);
    future[1].schemaVersion = 999;
    future[1].envelope.schemaVersion = 999;
    writeRecords(config, future);
    const before = fs.readFileSync(config.worldsFile);
    assert.throws(() => recover(database, { mode: 'if-present' }), /Unsupported future save schema/);
    assert.deepStrictEqual(fs.readFileSync(config.worldsFile), before);
  });
}

async function testOptionsAndEnvironment() {
  assert.strictEqual(buildStartupOptions({}, {}).mode, 'off');
  assert.strictEqual(buildStartupOptions({ resumeWorld: 'selected' }, {}).mode, 'required');
  const args = parseArgs(['--resume-mode', 'required', '--resume-world', 'checkpoint', '--port', '0']);
  assert.deepStrictEqual(buildStartupOptions(args, {}), { mode: 'required', worldId: 'checkpoint' });
  assert.deepStrictEqual(buildStartupOptions({}, {
    WORLD_ENGINE_DB_RESUME_MODE: 'if-present', WORLD_ENGINE_DB_RESUME_WORLD: 'env-world',
  }), { mode: 'if-present', worldId: 'env-world' });
  assert.strictEqual(buildStartupOptions({ resumeMode: 'required' }, { WORLD_ENGINE_DB_RESUME_MODE: 'off' }).mode, 'required');
  assert.throws(() => parseArgs(['--resume-world']), /Missing value/);
  assert.throws(() => parseArgs(['--resume-mode', '--auto-loop']), /Missing value/);
  assert.throws(() => parseArgs(['--resuem-mode', 'required']), /Unknown API option/);
  expectCode(() => prepareDatabaseStartup({ mode: 'off', worldId: 'checkpoint' }), 'DATABASE_STARTUP_CONFIG');
  expectCode(() => prepareDatabaseStartup({ mode: 'invalid' }), 'DATABASE_STARTUP_CONFIG');
  await withDatabase(database => {
    saveWorldToDatabase(world(), { database });
    const app = createApiServerFromArgs({ resumeMode: 'required', port: '0', seedTicks: '100' }, {
      WORLD_ENGINE_DB_PROVIDER: 'jsonl', WORLD_ENGINE_DB_DIR: database.directory, WORLD_ENGINE_DB_NAME: database.name,
    });
    assert.strictEqual(app.server.listening, false);
    assert.strictEqual(app.startup.status, 'restored');
    assert.strictEqual(app.api.getWorld().tick, 17);
    assert.strictEqual(app.api.runtimeLoop.timer, null);
    assert.strictEqual(app.api.runtimeLoop.lastAutosaveTick, 17);
  });
}

function databaseArgs(database) {
  return ['--db-provider', 'jsonl', '--db-dir', database.directory, '--db-name', database.name];
}

function childEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('WORLD_ENGINE_')) delete env[key];
  return env;
}

async function testCliRejectsBeforeListening() {
  await withDatabase(database => {
    const result = spawnSync(process.execPath, [entrypoint, '--port', '0', '--resume-mode', 'required', ...databaseArgs(database)], {
      encoding: 'utf8', timeout: 15000, env: childEnvironment(),
    });
    assert.strictEqual(result.status, 1, result.stderr || String(result.error));
    assert.ok(result.stderr.includes('DATABASE_STARTUP_MISSING'));
    assert.ok(!result.stdout.includes('world-engine-api'));
    const help = spawnSync(process.execPath, [entrypoint, '--help'], { encoding: 'utf8', timeout: 15000, env: childEnvironment() });
    assert.strictEqual(help.status, 0);
    assert.ok(help.stdout.includes('--resume-mode'));
  });
}

async function testRealProcessRestart() {
  await withDatabase(async database => {
    saveWorldToDatabase(world(), { database });
    const args = ['--port', '0', '--seed-ticks', '100', '--resume-mode', 'required', '--resume-world', 'checkpoint',
      '--autosave-mode', 'database', '--autosave-every', '1', ...databaseArgs(database)];
    let first;
    let second;
    try {
      first = await startProcess(args);
      assert.strictEqual(first.startup.startup.status, 'restored');
      assert.strictEqual(first.startup.tick, 17);
      const response = await requestJson(first.startup.port, '/admin/loop/step', { ticks: 1 });
      assert.strictEqual(response.ok, true, JSON.stringify(response));
      assert.strictEqual(loadWorldFromDatabase('checkpoint', { database }).world.tick, 18);
      await stopProcess(first.child);
      second = await startProcess(args);
      assert.strictEqual(second.startup.worldId, 'checkpoint');
      assert.strictEqual(second.startup.tick, 18);
      assert.strictEqual(second.startup.startup.sequence, 2);
      assert.strictEqual(second.startup.runtimeLoop.lastAutosaveTick, 18);
    } finally {
      if (first) await stopProcess(first.child);
      if (second) await stopProcess(second.child);
    }
  });
}

function startProcess(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...args], { env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`API startup timeout: ${stderr}`)); }, 15000);
    child.stderr.on('data', data => { stderr += data; });
    child.stdout.on('data', data => {
      stdout += data;
      let startup;
      try { startup = JSON.parse(stdout); } catch (_) { return; }
      clearTimeout(timer);
      resolve({ child, startup });
    });
    child.once('error', error => { clearTimeout(timer); child.kill(); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`API exited ${code}: ${stderr}`)); });
  });
}

function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

function requestJson(port, route, body) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('API request timeout')));
    req.on('error', reject);
    req.end(text);
  });
}

async function main() {
  const tests = [testEmptyAndDisabled, testWorldSelection, testLatestMeansAppendOrder, testRandomAndIdContinuation,
    testCorruptJsonAndPhysicalLine, testInvalidRecordsFailClosed, testSequenceAndFutureSchema, testOptionsAndEnvironment,
    testCliRejectsBeforeListening, testRealProcessRestart];
  for (const test of tests) {
    await test();
    console.log(`PASS ${test.name}`);
  }
  console.log(`database startup recovery test passed (${tests.length} scenario groups)`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
