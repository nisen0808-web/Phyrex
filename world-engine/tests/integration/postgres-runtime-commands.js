'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createWorld } = require('../../core/world-engine');
const { createPlayer } = require('../../core/player-engine');
const { createPostgresDatabaseStore } = require('../../storage/postgres/store');
const { createDurableWorldRuntime } = require('../../runtime/durable-world-runtime');

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function unavailable() { const error = new Error('private'); error.code = 'WORLD_DB_UNAVAILABLE'; return error; }
function worldFixture(id) {
  const world = createWorld({ id, seed: id });
  createPlayer(world, { id: 'player-1', name: 'Player One' });
  return world;
}
async function main() {
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  if (!connectionString) throw new Error('WORLD_ENGINE_TEST_DATABASE_URL is required; integration tests never silently skip');
  assert.ok(/_(ci|test)$/.test(new URL(connectionString).pathname));
  const schema = `test_runtime_commands_${crypto.randomBytes(8).toString('hex')}`;
  const quoted = `"${schema}"`;
  const store = createPostgresDatabaseStore({ connectionString, schema });
  const raw = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
  const runtimes = [];
  const create = async (worldId, extra = {}) => {
    const runtime = await createDurableWorldRuntime({ worldId, store, ...extra });
    runtimes.push(runtime); return runtime;
  };
  const seed = async id => store.saveWorld(worldFixture(id), { expectedRevision: 0, requestId: `seed:${id}` });
  const enqueueWait = (worldId, id, playerId = 'player-1') => store.enqueueCommand({ worldId, id, playerId, input: { type: 'wait', ticks: 1 } });
  let groups = 0;
  const pass = name => { groups += 1; console.log(`PASS ${name}`); };
  try {
    await store.migrate();

    await seed('consume');
    const command = await enqueueWait('consume', 'wait-1');
    const runtime = await create('consume');
    const result = await runtime.step();
    assert.strictEqual(result.commands, 1);
    assert.strictEqual(runtime.getWorld().commands.byId['wait-1'].status, 'completed');
    const applied = await store.getCommand('consume', 'wait-1');
    assert.strictEqual(applied.status, 'applied');
    assert.strictEqual(applied.result.status, 'completed');
    assert.strictEqual(applied.appliedSaveSequence, (await store.loadWorld('consume')).sequence);
    assert.strictEqual(command.sequence, applied.sequence);
    pass('runtime consumes FIFO SQL command and acknowledges it with the committed world revision');

    await seed('rejected');
    await enqueueWait('rejected', 'missing-player', 'missing-player');
    const rejected = await create('rejected'); await rejected.step();
    const rejectedRow = await store.getCommand('rejected', 'missing-player');
    assert.strictEqual(rejectedRow.status, 'applied');
    assert.strictEqual(rejectedRow.result.status, 'rejected');
    assert.strictEqual(rejectedRow.result.outcome.reason, 'missing_player');
    pass('deterministic command rejection is durably terminal and does not poison the queue');

    await seed('lost_ack_command');
    await enqueueWait('lost_ack_command', 'wait-lost');
    let first = true;
    const ackLostStore = { ...store, saveWorld: async (...args) => {
      const receipt = await store.saveWorld(...args);
      if (first) { first = false; throw unavailable(); }
      return receipt;
    } };
    const lost = await create('lost_ack_command', { store: ackLostStore });
    await assert.rejects(lost.step());
    assert.strictEqual(lost.getWorld().commands?.byId?.['wait-lost'], undefined);
    assert.strictEqual((await store.getCommand('lost_ack_command', 'wait-lost')).status, 'applied');
    const requestId = lost.summary().pending.requestId;
    const replay = await lost.retry();
    assert.strictEqual(replay.requestId, requestId); assert.strictEqual(replay.idempotent, true);
    assert.strictEqual(lost.getWorld().commands.stats.submitted, 1);
    assert.strictEqual((await store.listCommands({ worldId: 'lost_ack_command' })).length, 1);
    pass('lost commit acknowledgement retries the exact candidate without executing a command twice');

    await seed('command_rollback');
    await enqueueWait('command_rollback', 'wait-rollback');
    const rollback = await create('command_rollback');
    await raw.query(`CREATE FUNCTION ${quoted}.reject_runtime_command() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.world_id='command_rollback' AND NEW.status='applied' THEN RAISE EXCEPTION 'intentional command rollback'; END IF; RETURN NEW; END $$`);
    await raw.query(`CREATE TRIGGER reject_runtime_command BEFORE UPDATE ON ${quoted}.world_commands FOR EACH ROW EXECUTE FUNCTION ${quoted}.reject_runtime_command()`);
    await assert.rejects(rollback.step(), error => error.code === 'WORLD_DB_SQL_ERROR');
    assert.strictEqual(rollback.getWorld().commands?.byId?.['wait-rollback'], undefined);
    assert.strictEqual((await store.getCommand('command_rollback', 'wait-rollback')).status, 'pending');
    assert.strictEqual((await store.loadWorld('command_rollback')).revision, 1);
    assert.strictEqual(rollback.summary().pending.commands, 1);
    await raw.query(`DROP TRIGGER reject_runtime_command ON ${quoted}.world_commands`);
    await rollback.retry();
    assert.strictEqual((await store.getCommand('command_rollback', 'wait-rollback')).status, 'applied');
    assert.strictEqual(rollback.getWorld().commands.stats.submitted, 1);
    pass('SQL command acknowledgement failure rolls back world and command, then retries without re-execution');

    await seed('command_race');
    await enqueueWait('command_race', 'wait-race');
    const one = await create('command_race'), two = await create('command_race');
    const raced = await Promise.allSettled([one.step(), two.step()]);
    assert.strictEqual(raced.filter(item => item.status === 'fulfilled').length, 1);
    assert.strictEqual(raced.filter(item => item.status === 'rejected').length, 1);
    assert.strictEqual(raced.find(item => item.status === 'rejected').reason.code, 'WORLD_DB_REVISION_CONFLICT');
    const raceWorld = await store.loadWorld('command_race');
    assert.strictEqual(raceWorld.world.commands.stats.submitted, 1);
    assert.strictEqual((await store.getCommand('command_race', 'wait-race')).status, 'applied');
    pass('two runtimes may read one pending command but only one revision can consume it');

    await seed('late_command');
    await enqueueWait('late_command', 'first');
    const gate = deferred(), entered = deferred();
    const gatedStore = { ...store, saveWorld: async (...args) => { entered.resolve(); await gate.promise; return store.saveWorld(...args); } };
    const late = await create('late_command', { store: gatedStore });
    const flight = late.step(); await entered.promise;
    await enqueueWait('late_command', 'second');
    gate.resolve(); await flight;
    assert.strictEqual(late.getWorld().commands.byId.second, undefined);
    assert.strictEqual((await store.getCommand('late_command', 'second')).status, 'pending');
    await late.step();
    assert.strictEqual(late.getWorld().commands.byId.second.status, 'completed');
    pass('command submitted after candidate capture is deferred to the next revision');

    await seed('command_restart');
    await enqueueWait('command_restart', 'once');
    const firstRuntime = await create('command_restart'); await firstRuntime.step(); await firstRuntime.close();
    const afterFirst = await store.loadWorld('command_restart');
    assert.strictEqual(afterFirst.world.commands.stats.submitted, 1);
    const secondRuntime = await create('command_restart'); await secondRuntime.step();
    assert.strictEqual(secondRuntime.getWorld().commands.stats.submitted, 1);
    assert.strictEqual((await store.getCommand('command_restart', 'once')).status, 'applied');
    pass('process-style runtime restart never re-executes an already applied command');

    console.log(`postgres runtime commands completed ${groups} scenario groups: ${groups} passed, 0 failed`);
  } finally {
    await Promise.all(runtimes.map(runtime => runtime.close({ flush: false }).catch(() => {})));
    await store.close();
    await raw.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await raw.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
