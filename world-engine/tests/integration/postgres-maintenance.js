'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const { createWorld } = require('../../core/world-engine');
const { createPostgresDatabaseStore } = require('../../storage/postgres/store');
const { createPostgresCommandApiAuditStore } = require('../../storage/postgres/command-api-audit-store');
const { exportBackupFile, readBackupFile } = require('../../storage/postgres/backup');
const { detachedJson, digest } = require('../../storage/postgres/codec');
const { main: maintain } = require('../../demo/database-maintenance-cli');

async function main() {
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  if (!connectionString || !/_(ci|test)$/.test(new URL(connectionString).pathname)) throw new Error('Isolated test database required; no silent skip');
  const prefix = `test_maint_${crypto.randomBytes(7).toString('hex')}`;
  const schemas = [prefix, `${prefix}_before`, `${prefix}_after`];
  const stores = schemas.map(schema => createPostgresDatabaseStore({ connectionString, schema }));
  const [store, before, after] = stores;
  const audit = createPostgresCommandApiAuditStore({ connectionString, schema: prefix });
  const restoredAudit = createPostgresCommandApiAuditStore({ connectionString, schema: schemas[2] });
  const raw = new Pool({ connectionString, max: 3 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-maintenance-'));
  const env = { WORLD_ENGINE_DATABASE_URL: connectionString, WORLD_ENGINE_DB_SCHEMA: prefix };
  const q = `"${prefix}"`;
  const file = name => path.join(directory, name + '.ndjson');
  const retained = async worldId => (await raw.query(`SELECT count(*)::integer AS n FROM ${q}.world_saves WHERE world_id=$1 AND envelope IS NOT NULL`, [worldId])).rows[0].n;
  const auditRows = async () => (await raw.query(`SELECT to_jsonb(t) AS data FROM ${q}.command_api_audit t ORDER BY sequence`)).rows.map(row => row.data);
  let groups = 0, held;
  const pass = label => { groups++; console.log(`PASS ${label}`); };
  try {
    for (const target of stores) await target.migrate();
    const world = createWorld({ id: 'retained-world', seed: 'maintenance' });
    const original = detachedJson(world);
    const seedOptions = { expectedRevision: 0, requestId: 'seed', metadata: { fixture: 'original' } };
    await store.saveWorld(world, seedOptions);
    const command = await store.enqueueCommand({ worldId: world.id, id: 'once', playerId: 'observer', input: { type: 'wait' } });
    for (let revision = 2; revision <= 6; revision++) {
      world.tick++;
      await store.saveWorld(world, { expectedRevision: revision - 1, requestId: `checkpoint-${revision}`,
        commandResults: revision === 2 ? [{ ...command, result: { ok: true } }] : [] });
    }
    const preview = await maintain(['checkpoints', '--world-id', world.id, '--keep', '2'], env);
    assert.strictEqual(preview.eligible, 4); assert.strictEqual(preview.applied, false);
    assert.strictEqual(await retained(world.id), 6);
    pass('preview reports four eligible payloads without changing the six checkpoints');

    const result = await maintain(['checkpoints', '--world-id', world.id, '--keep', '2', '--limit', '2', '--expected-revision', '6', '--apply', '--backup', file('before')], env);
    assert.strictEqual(result.compacted, 2); assert.strictEqual(result.remaining, 2);
    assert.strictEqual(await retained(world.id), 4);
    await before.restoreSnapshot(readBackupFile(file('before')));
    assert.strictEqual((await before.loadWorld(world.id, { revision: 3 })).revision, 3);
    const rest = await maintain(['checkpoints', '--world-id', world.id, '--keep', '2', '--expected-revision', '6', '--apply', '--backup', file('second')], env);
    assert.strictEqual(rest.compacted, 2); assert.strictEqual(await retained(world.id), 2);
    assert.strictEqual((await store.loadWorld(world.id)).revision, 6);
    assert.strictEqual((await store.loadWorld(world.id, { revision: 5 })).revision, 5);
    await assert.rejects(store.loadWorld(world.id, { revision: 1 }), e => e.code === 'WORLD_DB_CHECKPOINT_ARCHIVED');
    assert.strictEqual((await store.getCommand(world.id, 'once')).status, 'applied');
    pass('backed-up bounded compaction retains the latest payloads and command foreign keys');

    const replay = await store.saveWorld(original, seedOptions);
    assert.strictEqual(replay.idempotent, true); assert.strictEqual(replay.revision, 1);
    assert.strictEqual((await store.loadWorld(world.id)).revision, 6);
    assert.strictEqual(await retained(world.id), 2);
    await assert.rejects(store.saveWorld(original, { ...seedOptions, metadata: { fixture: 'different' } }), e => e.code === 'WORLD_DB_IDEMPOTENCY_CONFLICT');
    const receipt = await store.getCheckpointRequest(world.id, 'seed');
    assert.strictEqual(receipt.archived, true); assert.deepStrictEqual(receipt.metadata, seedOptions.metadata);
    pass('archived checkpoint receipts acknowledge identical retries and reject changed input without replay');

    await assert.rejects(store.compactCheckpoints(world.id, { keep: 1, apply: true, expectedRevision: 5 }), e => e.code === 'WORLD_DB_REVISION_CONFLICT');
    await assert.rejects(maintain(['checkpoints', '--world-id', world.id, '--keep', '1', '--expected-revision', '5', '--apply', '--backup', file('stale')], env), e => e.code === 'WORLD_DB_REVISION_CONFLICT');
    await assert.rejects(maintain(['checkpoints', '--world-id', world.id, '--keep', '1', '--expected-revision', '6', '--apply', '--backup', file('before')], env), e => e.code === 'EEXIST');
    assert.strictEqual(await retained(world.id), 2);
    pass('stale revision and backup publication failure cannot delete checkpoint payloads');

    const corrupt = createWorld({ id: 'corrupt-world', seed: 9 });
    for (let revision = 1; revision <= 3; revision++) await store.saveWorld(corrupt, { expectedRevision: revision - 1, requestId: `c-${revision}` });
    const saved = (await raw.query(`SELECT envelope FROM ${q}.world_saves WHERE world_id=$1 AND revision=1`, [corrupt.id])).rows[0].envelope;
    await raw.query(`UPDATE ${q}.world_saves SET envelope=jsonb_set(envelope,'{world,tick}','999'::jsonb) WHERE world_id=$1 AND revision=1`, [corrupt.id]);
    await assert.rejects(store.compactCheckpoints(corrupt.id, { keep: 1, apply: true, expectedRevision: 3 }), e => e.code === 'WORLD_DB_CORRUPT_RECORD');
    assert.strictEqual(await retained(corrupt.id), 3, 'earlier successful updates in the failed batch roll back');
    await raw.query(`UPDATE ${q}.world_saves SET envelope=$2::jsonb WHERE world_id=$1 AND revision=1`, [corrupt.id, JSON.stringify(saved)]);
    pass('corrupt historical payload aborts the whole compaction transaction');

    const input = { requestId: 'retire-me', worldId: world.id, method: 'GET', route: 'durable.audit.list', statusCode: 200 };
    const first = await audit.append(input);
    held = await raw.connect(); await held.query('BEGIN');
    await held.query(`INSERT INTO ${q}.command_api_audit(request_id,world_id,method,route,status_code) VALUES ('late-commit',$1,'GET','durable.audit.list',200)`, [world.id]);
    const captured = [];
    await exportBackupFile({ exportSnapshot: write => store.exportSnapshot(async record => {
      await write(record); if (record.type === 'row' && record.table === 'command_api_audit') captured.push(record.values);
    }) }, file('audit-before'));
    await held.query('COMMIT'); held.release(); held = null;
    assert.strictEqual(captured.length, 1);
    assert.deepStrictEqual(await store.retireAuditRecords(captured), { retired: 1, missing: 0 });
    assert.deepStrictEqual((await audit.list()).map(row => row.requestId), ['late-commit']);
    const retry = await audit.append(input);
    assert.strictEqual(retry.idempotent, true); assert.strictEqual(retry.retained, false); assert.strictEqual(retry.sequence, first.sequence);
    await assert.rejects(audit.append({ ...input, statusCode: 403 }), e => e.code === 'WORLD_DB_IDEMPOTENCY_CONFLICT');
    assert.deepStrictEqual(await store.retireAuditRecords(captured), { retired: 0, missing: 1 });
    pass('audit retirement uses exact backed-up rows, preserves late commits and permanent retry receipts');

    const concurrent = { ...input, requestId: 'concurrent-retire' }; await audit.append(concurrent);
    const capturedConcurrent = (await auditRows()).filter(row => row.request_id === concurrent.requestId);
    await Promise.all([store.retireAuditRecords(capturedConcurrent), audit.append(concurrent)]);
    assert.strictEqual((await audit.list()).some(row => row.requestId === concurrent.requestId), false);
    const remaining = await auditRows();
    await assert.rejects(store.retireAuditRecords([{ ...remaining[0], status_code: 503 }]), e => e.code === 'WORLD_DB_AUDIT_RETENTION_CONFLICT');
    assert.strictEqual((await auditRows()).length, 1);
    const auditPreview = await maintain(['audit', '--before-sequence', '9999'], env);
    assert.strictEqual(auditPreview.eligibleInBatch, 1);
    const retired = await maintain(['audit', '--before-sequence', '9999', '--limit', '1', '--apply', '--backup', file('audit-cli')], env);
    assert.strictEqual(retired.retired, 1);
    pass('concurrent retries do not resurrect retired audit and CLI requires a successful full backup');

    await exportBackupFile(store, file('after'));
    await after.restoreSnapshot(readBackupFile(file('after')));
    assert.strictEqual(digest((await after.loadWorld(world.id)).world), digest((await store.loadWorld(world.id)).world));
    assert.strictEqual((await after.saveWorld(original, seedOptions)).idempotent, true);
    assert.strictEqual((await restoredAudit.append(input)).retained, false);
    const high = (await raw.query(`SELECT max(sequence)::integer AS n FROM ${q}.command_api_audit_receipts`)).rows[0].n;
    assert.ok((await restoredAudit.append({ ...input, requestId: 'after-restore' })).sequence > high);
    await assert.rejects(after.loadWorld(world.id, { revision: 1 }), e => e.code === 'WORLD_DB_CHECKPOINT_ARCHIVED');
    pass('complete backup restores archived receipts, current world, audit deduplication and sequence high-water marks');
    console.log(`postgres maintenance completed ${groups} scenario groups: ${groups} passed, 0 failed`);
  } finally {
    if (held) { await held.query('ROLLBACK'); held.release(); }
    await audit.close(); await restoredAudit.close();
    for (const target of stores) await target.close();
    for (const schema of schemas) await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await raw.end(); fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
