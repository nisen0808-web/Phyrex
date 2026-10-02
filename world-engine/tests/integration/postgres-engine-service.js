'use strict';
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { setTimeout: delay } = require('timers/promises');
const { Pool } = require('pg');
const { createPostgresDatabaseStore } = require('../../storage/postgres/store');
const { createPostgresCommandApiAuditStore } = require('../../storage/postgres/command-api-audit-store');
const { createEngineService } = require('../../service/engine-service');
const { digest } = require('../../storage/postgres/codec');
const { fixture, request } = require('../helpers/service-fixture');
const execute = promisify(execFile);
async function until(action, label) {
  const deadline = Date.now() + 30000;
  do { const value = await action(); if (value) return value; await delay(40); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
function launch(env) {
  const child = spawn(process.execPath, [path.join(__dirname, '../../demo/engine-serve-cli.js'), '--world-id', 'service-world', '--port', '0', '--interval', '200'],
    { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const state = { stdout: '', stderr: '', ended: false, address: null };
  child.stdout.on('data', data => {
    state.stdout += data; assert.ok(state.stdout.length < 128 * 1024);
    for (const line of state.stdout.split('\n')) { try { const record = JSON.parse(line); if (record.address) state.address = record.address; } catch (_) {} }
  });
  child.stderr.on('data', data => { state.stderr += data; });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { state.ended = true; resolve({ code, signal }); }); });
  return { child, state, exit };
}
async function stop(processState) {
  processState.child.kill('SIGTERM');
  let timer, result;
  try { result = await Promise.race([processState.exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Service did not stop')), 35000); })]); }
  finally { clearTimeout(timer); }
  assert.strictEqual(result.code, 0); assert.ok(processState.state.stdout.includes('"stopped":"SIGTERM"'));
}
async function main() {
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  if (!connectionString || !/_(ci|test)$/.test(new URL(connectionString).pathname)) throw new Error('Isolated PostgreSQL _ci/_test database required; no silent skip');
  // POSIX signals are essential to this test, which is mandatory on Linux CI.
  if (process.platform === 'win32') throw new Error('Run the real process signal suite on Linux (mandatory Node 20/22 CI)');
  const schema = `test_service_${crypto.randomBytes(7).toString('hex')}`;
  const env = { ...process.env, WORLD_ENGINE_DATABASE_URL: connectionString, WORLD_ENGINE_DB_SCHEMA: schema,
    WORLD_ENGINE_COMMAND_API_SOURCE_RATE_LIMIT: '10000', WORLD_ENGINE_COMMAND_API_ACCOUNT_READ_RATE_LIMIT: '10000' };
  const database = { connectionString, schema };
  const store = createPostgresDatabaseStore(database), audits = createPostgresCommandApiAuditStore(database), raw = new Pool({ connectionString });
  const base = '/durable/worlds/service-world';
  let child, service, renamed = false, groups = 0;
  const pass = label => { groups++; console.log(`PASS ${label}`); };
  try {
    await store.migrate();
    const world = fixture().state.world;
    await store.saveWorld(world, { expectedRevision: 0, requestId: 'bootstrap' });
    assert.deepStrictEqual(await store.getWorldHead(world.id), { worldId: world.id, revision: 1, tick: 0 });
    assert.strictEqual(await store.getWorldHead('absent'), null);
    await store.saveWorld({ ...world, id: 'other-world' }, { expectedRevision: 0, requestId: 'other' });
    pass('lightweight head reads return only committed world ID, revision and tick');

    child = launch(env);
    await until(() => { assert.strictEqual(child.state.ended, false, child.state.stderr); return child.state.address; }, 'CLI startup');
    let port = child.state.address.port;
    assert.strictEqual((await request(port, '/health/live', { token: null })).status, 200);
    assert.strictEqual((await request(port, '/health/ready', { token: null })).status, 200);
    const state = await request(port, `${base}/players/one/state`);
    assert.strictEqual(state.status, 200); assert.ok(state.body.data.revision >= 1);
    assert.strictEqual(state.body.data.character.id, 'character');
    pass('one CLI process starts HTTP and an isolated durable runtime worker');

    assert.strictEqual((await request(port, `${base}/players/two/state`)).status, 403);
    assert.strictEqual((await request(port, `${base}/admin/summary`)).status, 403);
    assert.strictEqual((await request(port, '/durable/worlds/other-world/admin/summary', { token: 'admin-secret-token' })).status, 404);
    const summary = await request(port, `${base}/admin/summary`, { token: 'admin-secret-token' });
    assert.strictEqual(summary.status, 200); assert.strictEqual(summary.body.data.counts.players, 2);
    assert.ok(!JSON.stringify(state.body).includes('secret')); assert.ok(!JSON.stringify(summary.body).includes('accounts'));
    pass('committed views enforce ownership, administrator roles, redaction and one-world binding');

    const submit = (id, selectedPort = port) => request(selectedPort, `${base}/players/one/commands`, { method: 'POST', body: { id, type: 'wait' } });
    assert.strictEqual((await submit('first')).status, 202);
    const applied = await until(async () => { const row = await store.getCommand(world.id, 'first'); return row?.status === 'applied' ? row : null; }, 'command applied');
    const result = await request(port, `${base}/commands/first`);
    assert.strictEqual(result.body.data.status, 'applied');
    assert.deepStrictEqual(result.body.data.result, applied.result);
    pass('authenticated submission is consumed and observed only after its SQL checkpoint commits');

    await stop(child); const logs = [child.state.stdout, child.state.stderr]; child = null;
    const stopped = await store.getWorldHead(world.id); await delay(350);
    assert.deepStrictEqual(await store.getWorldHead(world.id), stopped);
    await store.enqueueCommand({ worldId: world.id, playerId: 'one', id: 'after-restart', input: { id: 'after-restart', type: 'wait' } }, { expectedWorldRevision: stopped.revision });
    child = launch(env); await until(() => { assert.strictEqual(child.state.ended, false, child.state.stderr); return child.state.address; }, 'CLI restart');
    port = child.state.address.port;
    const repeated = await submit('first'); assert.strictEqual(repeated.status, 200); assert.strictEqual(repeated.body.data.idempotent, true);
    assert.deepStrictEqual(repeated.body.data.result, applied.result);
    await until(async () => (await store.getCommand(world.id, 'after-restart'))?.status === 'applied', 'restart consumption');
    assert.strictEqual((await store.getCommand(world.id, 'first')).sequence, applied.sequence);
    pass('SIGTERM drains the service, restart consumes pending work and terminal commands never replay');

    const beforeCollision = await store.getWorldHead(world.id);
    for (const [name, args, code] of [
      ['engine-serve-cli.js', ['--world-id', world.id], 'WORLD_SERVICE_FAILED'],
      ['durable-command-api-server.js', [], 'COMMAND_API_FAILED'],
    ]) await assert.rejects(execute(process.execPath, [path.join(__dirname, '../../demo', name), ...args, '--port', String(port)], { env, timeout: 10000 }), error => {
      logs.push(error.stdout, error.stderr); return error.code === 1 && error.stderr.includes(code);
    });
    assert.ok((await store.getWorldHead(world.id)).revision >= beforeCollision.revision);
    await stop(child); logs.push(child.state.stdout, child.state.stderr); child = null;
    for (const log of logs) for (const secret of [connectionString, 'owner-secret-token', 'admin-secret-token']) assert.ok(!log.includes(secret));
    pass('listener failure exits promptly and operational output contains no connection string or tokens');

    service = await createEngineService({ worldId: world.id, port: 0, database, intervalMs: 5000 });
    port = service.address().port;
    await raw.query(`ALTER TABLE "${schema}".world_saves RENAME TO unavailable_saves`); renamed = true;
    assert.strictEqual((await request(port, '/health/ready')).status, 503);
    assert.strictEqual((await request(port, '/health/live')).status, 200);
    await raw.query(`ALTER TABLE "${schema}".unavailable_saves RENAME TO world_saves`); renamed = false;
    assert.strictEqual((await request(port, '/health/ready')).status, 200);
    const loaded = await store.loadWorld(world.id);
    loaded.world.name = 'External administrative change';
    await store.saveWorld(loaded.world, { expectedRevision: loaded.revision, requestId: 'external-change', metadata: loaded.metadata });
    await until(() => service.summary().runtime.status === 'blocked', 'revision fence blocks stale writer');
    assert.strictEqual((await request(port, '/health/ready')).status, 503);
    assert.strictEqual((await submit('must-not-enter')).status, 503);
    assert.strictEqual(await store.getCommand(world.id, 'must-not-enter'), null);
    assert.strictEqual(digest((await store.loadWorld(world.id)).world), digest(loaded.world));
    await assert.rejects(service.close(), { code: 'WORLD_SERVICE_WORKER_EXITED' }); service = null;
    pass('database loss fails readiness; revision conflicts block intake and unconfirmed shutdown fails visibly');

    const rows = await audits.list({ worldId: world.id, limit: 1000 });
    assert.ok(rows.some(row => row.route === 'state' && row.statusCode === 200));
    assert.ok(rows.some(row => row.route === 'summary' && row.statusCode === 403));
    assert.ok(rows.some(row => row.commandId === 'must-not-enter' && row.statusCode === 503));
    assert.ok(!JSON.stringify(rows).includes('secret-token'));
    assert.ok(!rows.some(row => row.route === 'health'));
    const onlyState = await audits.list({ worldId: world.id, route: 'state', limit: 100 });
    assert.ok(onlyState.length > 0 && onlyState.every(row => row.route === 'state'));
    pass('new routes are durably audited with safe fields, while probes do not accumulate audit rows');
    console.log(`postgres service completed ${groups} scenario groups: ${groups} passed, 0 failed`);
  } finally {
    if (child) { child.child.kill('SIGKILL'); await child.exit; }
    if (renamed) await raw.query(`ALTER TABLE "${schema}".unavailable_saves RENAME TO world_saves`);
    if (service) await service.close().catch(() => {});
    await store.close(); await audits.close(); await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await raw.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
