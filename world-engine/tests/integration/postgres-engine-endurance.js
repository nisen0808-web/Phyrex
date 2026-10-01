'use strict';
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');
const { createPostgresDatabaseStore } = require('../../storage/postgres/store');
const { advanceDeterministicBatch, executeDurableCommands, createDurableWorldRuntime } = require('../../runtime/durable-world-runtime');
const { repairLoadedWorld } = require('../../core/persistence-engine');
const { auditWorldConsistency } = require('../../core/world-consistency-engine');
const { digest } = require('../../storage/postgres/codec');
const { createEnduranceWorld } = require('../fixtures/engine-endurance-world');

const children = new Set();
function worker(schema, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'engine-endurance-worker.js'), schema, mode],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    // Functional recovery gate, not a 250-tick latency benchmark. Later quarters
    // carry a larger full-world checkpoint; the whole CI job remains capped at 25m.
    const timer = setTimeout(() => { child.kill(); reject(new Error('Endurance worker timed out')); }, 600000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      children.delete(child);
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Endurance worker failed: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
}

async function main() {
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  if (!connectionString) throw new Error('WORLD_ENGINE_TEST_DATABASE_URL is required; no silent skips');
  assert.ok(/_(ci|test)$/.test(new URL(connectionString).pathname));
  const schema = `test_endurance_${crypto.randomBytes(8).toString('hex')}`;
  const restoredSchema = `${schema}_restore`;
  const store = createPostgresDatabaseStore({ connectionString, schema });
  const restoredStore = createPostgresDatabaseStore({ connectionString, schema: restoredSchema });
  const raw = new Pool({ connectionString, max: 2 });
  let resumed;
  let groups = 0;
  const pass = label => { groups++; console.log(`PASS ${label}`); };
  try {
    await store.migrate(); await restoredStore.migrate();
    await store.saveWorld(createEnduranceWorld(), { expectedRevision: 0, requestId: 'endurance-seed' });
    const expected = (await store.loadWorld('engine-endurance')).world;
    for (let quarter = 0; quarter < 4; quarter++) {
      const commands = [];
      for (const [suffix, playerId, type] of [['wait', 'observer', 'wait'], ['reject', 'missing', 'wait']]) {
        const input = { worldId: expected.id, id: `q${quarter}-${suffix}`, playerId, input: { type, payload: { ticks: 1 } } };
        const row = await store.enqueueCommand(input); commands.push(row);
        const again = await store.enqueueCommand(input);
        assert.strictEqual(again.sequence, row.sequence); assert.strictEqual(again.idempotent, true);
      }
      const mode = ['normal', 'rollback', 'lost-ack', 'normal'][quarter];
      const childResult = worker(schema, mode).then(result => ({ result }), error => ({ error }));
      // The reference has no storage, no restart and no retry. Only the SQL path
      // below experiences commit boundaries, process loss and injected faults.
      executeDurableCommands(expected, commands);
      for (let batch = 0; batch < 25; batch++) {
        advanceDeterministicBatch(expected, 10);
        await new Promise(resolve => setImmediate(resolve));
      }
      repairLoadedWorld(expected);
      const outcome = await childResult;
      if (outcome.error) throw outcome.error;
      const result = outcome.result;
      assert.strictEqual(result.startedAt, quarter * 250);
      assert.strictEqual(result.observedFailure, mode !== 'normal');
      const loaded = await store.loadWorld(expected.id);
      assert.strictEqual(loaded.tick, (quarter + 1) * 250);
      assert.strictEqual(loaded.revision, 1 + (quarter + 1) * 25);
      assert.strictEqual(digest(loaded.world), digest(expected), `full state diverged at tick ${loaded.tick}`);
      assert.strictEqual(result.digest, digest(expected));
      assert.deepStrictEqual(auditWorldConsistency(loaded.world).issues, []);
      assert.strictEqual((await store.listPendingCommands(expected.id)).length, 0);
      for (const command of commands) {
        const row = await store.getCommand(expected.id, command.id);
        assert.strictEqual(row.status, 'applied');
        assert.strictEqual(row.result.status, command.playerId === 'missing' ? 'rejected' : 'completed');
      }
      assert.ok(loaded.world.history.globalTimeline.length <= 500);
      assert.ok(Object.values(loaded.world.history.lifeEventsByEntity).every(events => events.length <= 100));
      assert.ok(Object.keys(loaded.world.processes.byId).length <= 100);
      assert.ok(loaded.world.simulation.reports.length <= 200);
      assert.ok(loaded.world.kernel.history.length <= 100);
      assert.ok(Buffer.byteLength(JSON.stringify(loaded.world)) < 32 * 1024 * 1024);
      pass(`tick ${loaded.tick}: full-state equality, process restart, FIFO commands and ${mode}`);
    }
    assert.ok(expected.population.births > 0, 'endurance must exercise actual births');
    assert.ok(expected.population.deaths > 0, 'endurance must exercise actual deaths');
    assert.ok(Object.values(expected.entities).some(entity => entity.demographics.generation > 1));
    assert.ok(expected.infoFlow && expected.cultureBeliefFlow && expected.natural && expected.ecology);
    const batches = await store.listEvents({ worldId: expected.id, type: 'runtime.batch_committed', limit: 1000 });
    assert.strictEqual(batches.length, 100, 'rollback/lost ack never duplicate a committed batch');
    pass('1000 ticks, 100 atomic checkpoints, 8 terminal commands and active population lifecycle');

    const source = await store.loadWorld(expected.id);
    // This restores a checkpoint, not a full database backup: pending inbox and
    // external audit history deliberately stay outside this assertion.
    await restoredStore.saveWorld(source.world, { expectedRevision: 0, requestId: 'restore-checkpoint', metadata: source.metadata });
    resumed = await createDurableWorldRuntime({ worldId: expected.id, store: restoredStore });
    advanceDeterministicBatch(expected, 10); repairLoadedWorld(expected);
    await resumed.step(10);
    assert.strictEqual(digest(resumed.getWorld()), digest(expected));
    await assert.rejects(createDurableWorldRuntime({ worldId: expected.id, store: restoredStore, simulation: { autoHistory: false } }),
      error => error.code === 'WORLD_RUNTIME_CONFIG_MISMATCH');
    pass('checkpoint restore into a fresh schema continues identical world and rejects changed configuration');
    console.log(`postgres engine endurance completed ${groups} scenario groups: ${groups} passed, 0 failed`);
  } finally {
    await Promise.all([...children].map(child => new Promise(resolve => { child.once('close', resolve); child.kill(); })));
    if (resumed) await resumed.close({ flush: false });
    await store.close(); await restoredStore.close();
    await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await raw.query(`DROP SCHEMA IF EXISTS "${restoredSchema}" CASCADE`);
    await raw.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
