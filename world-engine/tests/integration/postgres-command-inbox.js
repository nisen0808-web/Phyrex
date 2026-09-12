'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createWorld } = require('../../core/world-engine');
const { createPostgresDatabaseStore } = require('../../storage/postgres/store');
const { MIGRATIONS } = require('../../storage/postgres/migrations');

async function main() {
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  if (!connectionString) throw new Error('WORLD_ENGINE_TEST_DATABASE_URL is required; integration tests never silently skip');
  const url = new URL(connectionString);
  assert.ok(/_(ci|test)$/.test(url.pathname), 'Tests require an explicitly named _ci or _test database');
  const schema = `test_command_${crypto.randomBytes(8).toString('hex')}`;
  const quoted = `"${schema}"`;
  const options = { connectionString, schema };
  const raw = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
  const a = createPostgresDatabaseStore(options), b = createPostgresDatabaseStore(options);
  let groups = 0;
  const pass = name => { groups += 1; console.log(`PASS ${name}`); };
  try {
    const migrated = await a.migrate();
    assert.strictEqual(migrated.version, MIGRATIONS.length);
    assert.strictEqual(migrated.applied, MIGRATIONS.length);
    assert.strictEqual((await b.migrate()).applied, 0);
    pass('command inbox migration applies after immutable checkpoint schema');

    const world = createWorld({ id: 'command_world', seed: 'command-world' });
    const initial = await a.saveWorld(world, { expectedRevision: 0, requestId: 'initial-world' });
    assert.strictEqual(initial.revision, 1);

    const move = { worldId: world.id, id: 'cmd-1', playerId: 'player-1', input: { type: 'move', locationId: 'town' } };
    const first = await a.enqueueCommand(move);
    const duplicate = await b.enqueueCommand(move);
    assert.strictEqual(first.status, 'pending');
    assert.strictEqual(duplicate.idempotent, true);
    assert.strictEqual(first.sequence, duplicate.sequence);
    await assert.rejects(a.enqueueCommand({ ...move, input: { type: 'move', locationId: 'other' } }), e => e.code === 'WORLD_DB_IDEMPOTENCY_CONFLICT');
    await assert.rejects(a.enqueueCommand({ ...move, id: 'missing-world', worldId: 'absent' }), e => e.code === 'WORLD_DB_MISSING_WORLD');
    pass('external command submission is idempotent and requires a committed world');

    const wait = await a.enqueueCommand({ worldId: world.id, id: 'cmd-2', playerId: 'player-2', input: { type: 'wait', ticks: 1 } });
    const pending = await b.listPendingCommands(world.id, { limit: 10 });
    assert.deepStrictEqual(pending.map(item => item.id), ['cmd-1', 'cmd-2']);
    assert.strictEqual((await a.getCommand(world.id, 'cmd-1')).input.locationId, 'town');
    assert.deepStrictEqual((await a.listCommands({ worldId: world.id, playerId: 'player-2' })).map(item => item.id), ['cmd-2']);
    assert.ok(wait.sequence > first.sequence);
    pass('pending commands are stable FIFO rows with bounded filtering and polling');

    world.tick = 1;
    const applied1 = await a.saveWorld(world, {
      expectedRevision: 1,
      requestId: 'apply-one',
      commandResults: [{ sequence: first.sequence, id: first.id, playerId: first.playerId,
        inputDigest: first.inputDigest, result: { ok: true, completed: false, actionId: 'move-action' } }],
    });
    assert.strictEqual(applied1.revision, 2);
    const completed = await b.getCommand(world.id, first.id);
    assert.strictEqual(completed.status, 'applied');
    assert.strictEqual(completed.result.actionId, 'move-action');
    assert.strictEqual(completed.appliedSaveSequence, applied1.sequence);
    assert.deepStrictEqual((await b.listPendingCommands(world.id)).map(item => item.id), ['cmd-2']);
    const replay = await b.saveWorld(world, {
      expectedRevision: 1,
      requestId: 'apply-one',
      commandResults: [{ sequence: first.sequence, id: first.id, playerId: first.playerId,
        inputDigest: first.inputDigest, result: { ok: true, completed: false, actionId: 'move-action' } }],
    });
    assert.strictEqual(replay.idempotent, true);
    pass('command result and world checkpoint commit atomically and replay idempotently');

    const beforeConflict = await a.summary();
    world.tick = 2;
    await assert.rejects(a.saveWorld(world, {
      expectedRevision: 2,
      requestId: 'forged-command-result',
      commandResults: [{ sequence: wait.sequence, id: wait.id, playerId: wait.playerId,
        inputDigest: '0'.repeat(64), result: { ok: true } }],
    }), e => e.code === 'WORLD_DB_COMMAND_CONFLICT');
    const afterConflict = await a.summary();
    assert.strictEqual(afterConflict.records, beforeConflict.records);
    assert.strictEqual((await a.loadWorld(world.id)).revision, 2);
    assert.strictEqual((await a.getCommand(world.id, wait.id)).status, 'pending');
    pass('forged or stale command receipt rolls back the checkpoint and leaves command pending');

    const rollback = await a.enqueueCommand({ worldId: world.id, id: 'cmd-rollback', playerId: 'player-3', input: { type: 'wait' } });
    await raw.query(`CREATE FUNCTION ${quoted}.reject_command_apply() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.command_id = 'cmd-rollback' AND NEW.status = 'applied' THEN RAISE EXCEPTION 'intentional command apply failure'; END IF; RETURN NEW; END $$`);
    await raw.query(`CREATE TRIGGER reject_command_apply BEFORE UPDATE ON ${quoted}.world_commands FOR EACH ROW EXECUTE FUNCTION ${quoted}.reject_command_apply()`);
    const beforeSqlFailure = await a.summary();
    await assert.rejects(a.saveWorld(world, {
      expectedRevision: 2,
      requestId: 'sql-command-rollback',
      commandResults: [{ sequence: rollback.sequence, id: rollback.id, playerId: rollback.playerId,
        inputDigest: rollback.inputDigest, result: { ok: false, reason: 'rejected' } }],
    }), e => e.code === 'WORLD_DB_SQL_ERROR');
    const afterSqlFailure = await a.summary();
    assert.strictEqual(afterSqlFailure.records, beforeSqlFailure.records);
    assert.strictEqual((await a.getCommand(world.id, rollback.id)).status, 'pending');
    await raw.query(`DROP TRIGGER reject_command_apply ON ${quoted}.world_commands`);
    pass('SQL failure while acknowledging a command rolls back checkpoint and command state together');

    const race = await a.enqueueCommand({ worldId: world.id, id: 'cmd-race', playerId: 'player-4', input: { type: 'wait' } });
    const baseRevision = (await a.loadWorld(world.id)).revision;
    const candidateA = JSON.parse(JSON.stringify(world)); candidateA.tick = 3;
    const candidateB = JSON.parse(JSON.stringify(world)); candidateB.tick = 4;
    const optionsA = { expectedRevision: baseRevision, requestId: 'race-a', commandResults: [{ sequence: race.sequence,
      id: race.id, playerId: race.playerId, inputDigest: race.inputDigest, result: { ok: true, source: 'a' } }] };
    const optionsB = { expectedRevision: baseRevision, requestId: 'race-b', commandResults: [{ sequence: race.sequence,
      id: race.id, playerId: race.playerId, inputDigest: race.inputDigest, result: { ok: true, source: 'b' } }] };
    const raced = await Promise.allSettled([a.saveWorld(candidateA, optionsA), b.saveWorld(candidateB, optionsB)]);
    assert.strictEqual(raced.filter(item => item.status === 'fulfilled').length, 1);
    assert.strictEqual(raced.filter(item => item.status === 'rejected').length, 1);
    const finalRace = await a.getCommand(world.id, race.id);
    assert.strictEqual(finalRace.status, 'applied');
    assert.ok(['a', 'b'].includes(finalRace.result.source));
    pass('competing consumers cannot apply one command to two world revisions');

    const summary = await a.summary();
    assert.ok(summary.commands >= 4);
    assert.ok(summary.pendingCommands >= 1);
    await assert.rejects(a.listCommands({ worldId: world.id, status: 'bad' }), e => e.code === 'WORLD_DB_INVALID_INPUT');
    await assert.rejects(a.listCommands({ worldId: world.id, limit: 0 }), e => e.code === 'WORLD_DB_INVALID_CONFIG');
    pass('database summary exposes bounded command backlog without unbounded reads');

    console.log(`postgres command inbox completed ${groups} scenario groups: ${groups} passed, 0 failed`);
  } finally {
    await Promise.all([a.close(), b.close()]);
    await raw.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await raw.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
