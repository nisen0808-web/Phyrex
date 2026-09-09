'use strict';
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { fork, spawn } = require('child_process');
const { Pool } = require('pg');
const { createWorld } = require('../../core/world-engine');
const { buildDemoWorld } = require('../../demo/run-demo');
const { repairLoadedWorld } = require('../../core/persistence-engine');
const { createPostgresDatabaseStore } = require('../../core/postgres-database-engine');
const { createDurableWorldRuntime, advanceDeterministicBatch } = require('../../core/durable-runtime-engine');
const { digest } = require('../../storage/postgres/codec');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function error(code) { const e = new Error(code); e.code = code; return e; }
function childCli(args, env, stopAfterCommit = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../../demo/durable-runtime-cli.js'), ...args], {
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', stopped = false;
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stopAfterCommit && !stopped && stdout.includes('"type":"committed"')) { stopped = true; child.kill('SIGTERM'); }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Runtime CLI timed out')); }, 20000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
function competingWorker(schema, worldId, ticks) {
  const ready = deferred(); let receipt;
  const child = fork(path.join(__dirname, 'durable-runtime-worker.js'), [schema, worldId, String(ticks)], { silent: true });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Runtime worker timed out')); }, 20000);
    child.on('message', message => { if (message.type === 'ready') ready.resolve(message); else receipt = message; });
    child.on('error', e => { clearTimeout(timer); ready.resolve(null); reject(e); });
    child.on('exit', code => { clearTimeout(timer); ready.resolve(null); resolve({ code, receipt }); });
  });
  return { ready: ready.promise, done, go: () => child.send('go') };
}
async function main() {
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  if (!connectionString) throw new Error('WORLD_ENGINE_TEST_DATABASE_URL is required; no silent skips');
  assert.ok(/_(ci|test)$/.test(new URL(connectionString).pathname));
  const schema = `test_runtime_${crypto.randomBytes(8).toString('hex')}`, quoted = `"${schema}"`;
  const database = { connectionString, schema };
  const store = createPostgresDatabaseStore(database), raw = new Pool({ connectionString, max: 2 });
  const runtimes = [];
  const create = async (worldId, extra = {}) => { const r = await createDurableWorldRuntime({ worldId, store, ...extra }); runtimes.push(r); return r; };
  const seed = async id => store.saveWorld(createWorld({ id, seed: id }), { requestId: `seed:${id}`, expectedRevision: 0 });
  let groups = 0;
  const pass = name => { groups += 1; console.log(`PASS ${name}`); };
  try {
    await store.migrate();
    await assert.rejects(create('absent'), e => e.code === 'WORLD_RUNTIME_MISSING_WORLD');
    await seed('gate');
    const gate = deferred(), entered = deferred();
    const gated = { ...store, saveWorld: async (...args) => { entered.resolve(); await gate.promise; return store.saveWorld(...args); } };
    const r = await create('gate', { store: gated });
    const flight = r.step(2); await entered.promise;
    assert.strictEqual(r.getWorld().tick, 0); assert.strictEqual((await store.loadWorld('gate')).tick, 0);
    await assert.rejects(r.step(), e => e.code === 'WORLD_RUNTIME_BUSY');
    gate.resolve(); await flight;
    assert.strictEqual(r.getWorld().tick, 2); assert.strictEqual((await store.loadWorld('gate')).tick, 2);
    const events = await store.listEvents({ worldId: 'gate', type: 'runtime.batch_committed' });
    assert.strictEqual(events.length, 1); assert.strictEqual(events[0].payload.ticks, 2);
    pass('SQL commit precedes publication and audit event, overlapping steps are refused');

    await seed('lost_ack'); let first = true, simulations = 0;
    const ackLost = { ...store, saveWorld: async (...args) => {
      const receipt = await store.saveWorld(...args);
      if (first) { first = false; throw error('WORLD_DB_UNAVAILABLE'); } return receipt;
    } };
    const lost = await create('lost_ack', { store: ackLost, simulationId: 'counted-default',
      advance: (...args) => { simulations += 1; return advanceDeterministicBatch(...args); } });
    await assert.rejects(lost.step()); assert.strictEqual(lost.getWorld().tick, 0);
    assert.strictEqual((await store.loadWorld('lost_ack')).tick, 1);
    const requestId = lost.summary().pending.requestId;
    const ack = await lost.retry(); assert.strictEqual(ack.requestId, requestId); assert.strictEqual(ack.idempotent, true);
    assert.strictEqual(simulations, 1); assert.strictEqual(lost.summary().revision, 2);
    assert.strictEqual((await store.listEvents({ worldId: 'lost_ack' })).length, 3);
    pass('actual committed transaction with injected lost acknowledgement retries without duplicate records');

    await seed('rollback'); const rollback = await create('rollback'); const before = await store.summary();
    await raw.query(`CREATE FUNCTION ${quoted}.fail_runtime() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.type='runtime.batch_committed' AND NEW.world_id='rollback' THEN
        RAISE EXCEPTION 'test retryable failure' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`);
    await raw.query(`CREATE TRIGGER fail_runtime BEFORE INSERT ON ${quoted}.world_events FOR EACH ROW EXECUTE FUNCTION ${quoted}.fail_runtime()`);
    await assert.rejects(rollback.step(3), e => e.sqlState === '40001');
    assert.strictEqual(rollback.getWorld().tick, 0); assert.strictEqual((await store.loadWorld('rollback')).revision, 1);
    const after = await store.summary(); for (const key of ['records', 'events']) assert.strictEqual(after[key], before[key]);
    const pendingId = rollback.summary().pending.requestId;
    await raw.query(`DROP TRIGGER fail_runtime ON ${quoted}.world_events`);
    assert.strictEqual((await rollback.retry()).requestId, pendingId); assert.strictEqual(rollback.getWorld().tick, 3);
    pass('SQL-trigger failure rolls back snapshot, head and events; retained batch retries unchanged');

    await seed('race'); const one = await create('race'), two = await create('race');
    const race = await Promise.allSettled([one.step(1), two.step(2)]);
    assert.strictEqual(race.filter(v => v.status === 'fulfilled').length, 1);
    assert.strictEqual(race.find(v => v.status === 'rejected').reason.code, 'WORLD_DB_REVISION_CONFLICT');
    assert.strictEqual((await store.loadWorld('race')).revision, 2);
    const stale = one.summary().status === 'blocked' ? one : two;
    await assert.rejects(stale.step(), e => e.code === 'WORLD_RUNTIME_BLOCKED');
    pass('two live runtimes cannot overwrite a competing committed revision');

    await seed('process_race'); const workers = [competingWorker(schema, 'process_race', 1), competingWorker(schema, 'process_race', 2)];
    const ready = await Promise.all(workers.map(w => w.ready)); assert.ok(ready.every(v => v?.revision === 1));
    workers.forEach(w => w.go()); const results = await Promise.all(workers.map(w => w.done));
    assert.deepStrictEqual(results.map(v => v.code).sort(), [0, 2]);
    assert.strictEqual(results.find(v => v.code === 2).receipt.error, 'WORLD_DB_REVISION_CONFLICT');
    assert.strictEqual((await store.loadWorld('process_race')).revision, 2);
    pass('independent runtime processes starting at the same revision have only one winner');

    await seed('cli_restart');
    const expected = (await store.loadWorld('cli_restart')).world;
    for (let n = 0; n < 2; n += 1) { advanceDeterministicBatch(expected, 2); repairLoadedWorld(expected); }
    const env = { WORLD_ENGINE_DATABASE_URL: connectionString, WORLD_ENGINE_DB_SCHEMA: schema };
    const args = ['--world-id', 'cli_restart', '--ticks-per-batch', '2'];
    const firstProcess = await childCli(args, env), secondProcess = await childCli(args, env);
    assert.strictEqual(firstProcess.code, 0, firstProcess.stderr); assert.strictEqual(secondProcess.code, 0, secondProcess.stderr);
    assert.ok(secondProcess.stdout.includes('"type":"ready"'));
    const resumed = await store.loadWorld('cli_restart'); assert.strictEqual(resumed.revision, 3); assert.strictEqual(resumed.tick, 4);
    assert.strictEqual(digest(resumed.world), digest(expected));
    pass('two actual CLI processes resume identical full world, random and ID state without reseeding');

    await seed('shutdown');
    const continuous = await childCli(['--world-id', 'shutdown', '--continuous', '--interval', '5000'], env, true);
    assert.strictEqual(continuous.code, 0, continuous.stderr); assert.ok(continuous.stdout.includes('"type":"stopped"'));
    assert.strictEqual((await store.loadWorld('shutdown')).revision, 2);
    pass('SIGTERM interrupts idle delay, drains storage, and creates no extra batch');

    const missing = await childCli(['--world-id', 'not_created'], env);
    assert.strictEqual(missing.code, 1); assert.ok(!missing.stdout.includes('"type":"ready"'));
    assert.strictEqual(await store.loadWorld('not_created'), null);
    const url = new URL(connectionString); if (url.password) assert.ok(!missing.stderr.includes(url.password));
    pass('missing world fails before ready and never creates a replacement or prints credentials');

    await seed('flush'); let unavailable = true;
    const flushing = await create('flush', { store: { ...store, saveWorld: (...a) => {
      if (unavailable) { unavailable = false; return Promise.reject(error('WORLD_DB_UNAVAILABLE')); } return store.saveWorld(...a);
    } } });
    await assert.rejects(flushing.step()); await flushing.close();
    assert.strictEqual((await store.loadWorld('flush')).revision, 2); assert.strictEqual(flushing.summary().tick, 1);
    pass('shutdown resolves a retained SQL batch without simulating it twice');

    await assert.rejects(create('cli_restart', { simulation: { autoNovel: false } }), e => e.code === 'WORLD_RUNTIME_CONFIG_MISMATCH');
    pass('restart refuses a different persisted simulation configuration');
    const populated = buildDemoWorld(); populated.id = 'populated';
    await store.saveWorld(populated, { requestId: 'seed:populated', expectedRevision: 0 });
    const populatedExpected = (await store.loadWorld('populated')).world;
    for (let n = 0; n < 2; n += 1) { advanceDeterministicBatch(populatedExpected, 2); repairLoadedWorld(populatedExpected); }
    for (let n = 0; n < 2; n += 1) {
      const processResult = await childCli(['--world-id', 'populated', '--ticks-per-batch', '2'], env);
      assert.strictEqual(processResult.code, 0, processResult.stderr);
    }
    const populatedRestored = await store.loadWorld('populated');
    assert.strictEqual(populatedRestored.revision, 3);
    assert.strictEqual(digest(populatedRestored.world), digest(populatedExpected));
    assert.ok(Object.keys(populatedRestored.world.entities).length >= 36);
    pass('populated 36-entity world survives real JSONB and process restart with identical full state');
    console.log(`postgres durable runtime completed ${groups} scenario groups: ${groups} passed, 0 failed`);
  } finally {
    await Promise.all(runtimes.map(r => r.close({ flush: false }).catch(() => {})));
    await store.close();
    await raw.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await raw.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
