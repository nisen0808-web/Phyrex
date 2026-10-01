'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const { createWorld } = require('../../core/world-engine');
const { createPlayer } = require('../../core/player-engine');
const { createAccount, createSession, validateSession } = require('../../core/account-session-engine');
const { createPostgresDatabaseStore } = require('../../storage/postgres/store');
const { createPostgresCommandApiAuditStore } = require('../../storage/postgres/command-api-audit-store');
const { exportBackupFile, readBackupFile, verifyBackupFile, TABLES } = require('../../storage/postgres/backup');
const { createDurableWorldRuntime, executeDurableCommands, advanceDeterministicBatch } = require('../../runtime/durable-world-runtime');
const { digest } = require('../../storage/postgres/codec');
const { repairLoadedWorld } = require('../../core/persistence-engine');

async function main() {
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  if (!connectionString || !/_(ci|test)$/.test(new URL(connectionString).pathname)) throw new Error('Isolated test database required; no silent skip');
  const prefix = `test_backup_${crypto.randomBytes(7).toString('hex')}`;
  const schemas = [prefix, `${prefix}_restored`, `${prefix}_bad`, `${prefix}_fault`];
  const stores = schemas.map(schema => createPostgresDatabaseStore({ connectionString, schema }));
  const [source, restored, bad, fault] = stores;
  const audit = createPostgresCommandApiAuditStore({ connectionString, schema: schemas[0] });
  const restoredAudit = createPostgresCommandApiAuditStore({ connectionString, schema: schemas[1] });
  const raw = new Pool({ connectionString, max: 2 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-sql-backup-'));
  let runtime, groups = 0;
  const pass = label => { groups++; console.log(`PASS ${label}`); };
  try {
    for (const store of stores) await store.migrate();
    const world = createWorld({ id: 'backup-world', seed: 'backup' });
    createPlayer(world, { id: 'observer', controlMode: 'observer' });
    createAccount(world, { id: 'admin', roles: ['admin'], playerIds: ['observer'] });
    const token = 'backup-test-session-token';
    createSession(world, 'admin', { token });
    await source.saveWorld(world, { expectedRevision: 0, requestId: 'seed' });
    const command = { worldId: world.id, id: 'applied', playerId: 'observer', input: { type: 'wait', payload: { ticks: 1 } } };
    await source.enqueueCommand(command);
    runtime = await createDurableWorldRuntime({ worldId: world.id, store: source });
    await runtime.step(1); await runtime.close(); runtime = null;
    await source.enqueueCommand({ ...command, id: 'pending' });
    await source.saveWorld(createWorld({ id: 'second-world', seed: 2 }), { expectedRevision: 0, requestId: 'second-seed' });
    await audit.append({ requestId: 'audit-1', worldId: world.id, accountId: 'admin', playerId: 'observer', commandId: 'applied', method: 'POST', route: 'durable.commands.submit', statusCode: 202 });
    await raw.query(`SELECT nextval('"${schemas[0]}".world_commands_sequence_seq') FROM generate_series(1,7)`);
    const expected = (await source.loadWorld(world.id)).world;
    const file = path.join(directory, 'snapshot.ndjson');
    const records = [];
    await exportBackupFile({ exportSnapshot: write => source.exportSnapshot(async record => {
      records.push(record); await write(record);
      if (record.type === 'header') await source.enqueueCommand({ ...command, id: 'after-snapshot' });
    }) }, file);
    const checked = await verifyBackupFile(file);
    assert.strictEqual(checked.counts.worlds, 2);
    assert.strictEqual(checked.counts.world_commands, 2, 'concurrent post-snapshot command excluded');
    assert.strictEqual(checked.counts.command_api_audit, 1);
    pass('consistent streaming snapshot includes two worlds, checkpoints, pending/applied inbox, events and audit');

    await restored.restoreSnapshot(readBackupFile(file));
    for (const table of Object.keys(TABLES)) {
      const result = await raw.query(`SELECT to_jsonb(t) AS data FROM "${schemas[1]}".${table} t ORDER BY ${table === 'worlds' ? 'world_id' : 'sequence'}`);
      assert.deepStrictEqual(result.rows.map(row => row.data), records.filter(record => record.type === 'row' && record.table === table).map(record => record.values));
    }
    assert.strictEqual(digest((await restored.loadWorld(world.id)).world), digest(expected));
    assert.ok(validateSession((await restored.loadWorld(world.id)).world, token));
    assert.strictEqual((await restoredAudit.list({ worldId: world.id })).length, 1);
    pass('fresh-schema restoration preserves all row values, timestamps, checksum and session hashes');

    const newRow = await restored.enqueueCommand({ ...command, id: 'new-after-restore' });
    const sequence = records.find(record => record.type === 'sequences').values.world_commands;
    assert.strictEqual(newRow.sequence, Number(sequence.lastValue) + 1, 'sequence gaps/high-water mark preserved');
    assert.strictEqual((await restored.enqueueCommand(command)).idempotent, true);
    assert.strictEqual((await restored.getCommand(world.id, 'applied')).status, 'applied');
    pass('sequence high-water marks and command idempotency survive complete restoration');

    const pending = await restored.listPendingCommands(world.id);
    executeDurableCommands(expected, pending); advanceDeterministicBatch(expected, 1); repairLoadedWorld(expected);
    runtime = await createDurableWorldRuntime({ worldId: world.id, store: restored });
    await runtime.step(1);
    assert.strictEqual(digest(runtime.getWorld()), digest(expected));
    assert.strictEqual((await restored.listPendingCommands(world.id)).length, 0);
    await runtime.close(); runtime = null;
    pass('restored runtime consumes pending commands once and resumes the identical world');

    const occupied = await restored.summary();
    await assert.rejects(restored.restoreSnapshot(readBackupFile(file)), error => error.code === 'WORLD_DB_RESTORE_TARGET_NOT_EMPTY');
    assert.strictEqual((await restored.summary()).records, occupied.records);
    const corrupt = path.join(directory, 'corrupt.ndjson');
    fs.writeFileSync(corrupt, fs.readFileSync(file).subarray(0, fs.statSync(file).size - 2));
    await assert.rejects(bad.restoreSnapshot(readBackupFile(corrupt)), error => error.code === 'WORLD_DB_INVALID_BACKUP');
    for (const table of Object.keys(TABLES)) assert.strictEqual((await raw.query(`SELECT count(*)::integer AS count FROM "${schemas[2]}".${table}`)).rows[0].count, 0);
    pass('occupied targets are refused and truncated imports roll back every table');

    await raw.query(`CREATE FUNCTION "${schemas[3]}".fail_restore() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected restore failure' USING ERRCODE='40001'; END $$`);
    await raw.query(`CREATE TRIGGER fail_restore BEFORE INSERT ON "${schemas[3]}".world_commands FOR EACH ROW EXECUTE FUNCTION "${schemas[3]}".fail_restore()`);
    await assert.rejects(fault.restoreSnapshot(readBackupFile(file)), error => error.sqlState === '40001');
    assert.strictEqual((await fault.summary()).worlds, 0);
    await raw.query(`DROP TRIGGER fail_restore ON "${schemas[3]}".world_commands`);
    await fault.restoreSnapshot(readBackupFile(file));
    assert.strictEqual((await fault.summary()).pendingCommands, 1);
    pass('SQL failure is atomic and a retry into the same empty schema succeeds');
    console.log(`postgres backup completed ${groups} scenario groups: ${groups} passed, 0 failed`);
  } finally {
    if (runtime) await runtime.close({ flush: false }).catch(() => {});
    await audit.close(); await restoredAudit.close();
    for (const store of stores) await store.close();
    for (const schema of schemas) await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await raw.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
