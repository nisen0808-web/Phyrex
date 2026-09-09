'use strict';
const assert = require('assert');
const { createWorld } = require('../core/world-engine');
const { normalizePostgresConfig, safePostgresConfig } = require('../storage/postgres/config');
const { captureCheckpoint, captureEvent, canonicalJson, digest, restoreSave } = require('../storage/postgres/codec');
const { MIGRATIONS, checkMigrationHistory } = require('../storage/postgres/migrations');
const { createPostgresDatabaseStore, sanitizeError } = require('../storage/postgres/store');
const { parseArgs } = require('../demo/database-postgres-cli');

function testConnectionPolicy() {
  const local = normalizePostgresConfig({ connectionString: 'postgresql://test:secret@127.0.0.1:5432/world_engine_test' }, {});
  assert.strictEqual(local.ssl, false);
  const remote = normalizePostgresConfig({ connectionString: 'postgres://test:secret@db.example.org/world_engine', sslCa: 'test-ca' }, {});
  assert.deepStrictEqual(remote.ssl, { rejectUnauthorized: true, ca: 'test-ca' });
  assert.ok(!JSON.stringify(safePostgresConfig(remote)).includes('secret'));
  assert.ok(!JSON.stringify(safePostgresConfig(remote)).includes('db.example.org'));
  const base = { connectionString: 'postgres://test@127.0.0.1/world_engine_test' };
  for (const schema of ['public', 'pg_catalog', 'abc;DROP', 'x'.repeat(64)]) {
    assert.throws(() => normalizePostgresConfig({ ...base, schema }, {}), /schema/);
  }
  for (const patch of [{ maxConnections: 0 }, { maxConnections: NaN }, { lockTimeoutMillis: -1 }, { sslMode: 'no-verify' }]) {
    assert.throws(() => normalizePostgresConfig({ ...base, ...patch }, {}));
  }
  assert.throws(() => normalizePostgresConfig({ connectionString: 'https://db.example.org/world' }, {}));
  assert.throws(() => normalizePostgresConfig({ connectionString: 'postgres://db.example.org/world?sslmode=disable' }, {}));
  assert.throws(() => normalizePostgresConfig({ connectionString: `${base.connectionString}?sslcert=unsafe` }, {}));
}
function testCapturedCheckpoints() {
  const world = createWorld({ id: 'pg_contract', seed: 'pg_contract' });
  world.tick = 7;
  const original = JSON.stringify(world);
  const options = { requestId: 'request-1', expectedRevision: 0, events: [{ type: 'test.event', payload: { ok: true } }] };
  const first = captureCheckpoint(world, options), second = captureCheckpoint(world, options);
  assert.strictEqual(first.requestHash, second.requestHash);
  assert.strictEqual(JSON.stringify(world), original);
  world.tick = 8;
  assert.strictEqual(first.envelope.world.tick, 7);
  assert.strictEqual(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.throws(() => captureCheckpoint(world, { expectedRevision: 0 }), /requestId/);
  assert.throws(() => captureCheckpoint(world, { requestId: 'missing-revision' }), /expectedRevision/);
  assert.throws(() => captureCheckpoint(world, { ...options, events: {} }), /array/);
  assert.throws(() => captureCheckpoint(world, { ...options, metadata: [] }), /object/);
  assert.throws(() => captureCheckpoint({ ...world, bad: NaN }, options), /finite/);
  assert.throws(() => captureCheckpoint(world, options, 10), /size limit/);
  assert.throws(() => captureEvent({ id: 'x', worldId: 'w', tick: 0, type: 't', payload: [] }), /object/);
}
function testStoredCheckpointValidation() {
  const world = createWorld({ id: 'stored', seed: 'stored' });
  const captured = captureCheckpoint(world, { requestId: 'saved', expectedRevision: 0 });
  const row = { request_id: 'saved', world_id: world.id, revision: '1', sequence: '1', tick: '0', save_schema: 1,
    saved_at: captured.envelope.savedAt, envelope: captured.envelope, payload_digest: captured.checksum };
  assert.strictEqual(restoreSave(row).world.id, 'stored');
  assert.throws(() => restoreSave({ ...row, payload_digest: '0'.repeat(64) }), /checksum/);
  const future = JSON.parse(JSON.stringify(row));
  future.envelope.schemaVersion = 99; future.save_schema = 99; future.payload_digest = digest(future.envelope);
  assert.throws(() => restoreSave(future), /schema or headers/);
}
function testMigrationHistory() {
  assert.strictEqual(checkMigrationHistory([]), 0);
  const history = MIGRATIONS.map(({ version, name, checksum }) => ({ version, name, checksum }));
  assert.strictEqual(checkMigrationHistory(history), MIGRATIONS.length);
  assert.throws(() => checkMigrationHistory([{ ...history[0], checksum: '0'.repeat(64) }]), /incompatible/);
  assert.throws(() => checkMigrationHistory([{ ...history[0], version: 2 }]), /incompatible/);
  assert.throws(() => checkMigrationHistory([...history, { version: 99 }]), /Unsupported/);
}
function testErrorRedaction() {
  const raw = Object.assign(new Error('password=must-not-leak'), { code: '23505', detail: 'secret SQL data' });
  const safe = sanitizeError(raw);
  assert.strictEqual(safe.code, 'WORLD_DB_SQL_ERROR');
  assert.ok(!safe.message.includes('must-not-leak'));
  assert.strictEqual(safe.detail, undefined);
  assert.strictEqual(sanitizeError({ code: 'ECONNREFUSED' }).code, 'WORLD_DB_UNAVAILABLE');
  assert.strictEqual(sanitizeError({ code: '55P03' }).code, 'WORLD_DB_TIMEOUT');
}
async function testCloseAndCliContracts() {
  let ends = 0;
  class PoolStub {
    on(type, handler) { assert.strictEqual(type, 'error'); this.handler = handler; }
    end() { ends += 1; return Promise.resolve(); }
  }
  const store = createPostgresDatabaseStore({ connectionString: 'postgres://test:secret@127.0.0.1/world_engine_test', Pool: PoolStub });
  assert.ok(!JSON.stringify(store.config).includes('secret'));
  await Promise.all([store.close(), store.close()]);
  assert.strictEqual(ends, 1);
  await assert.rejects(store.summary(), e => e.code === 'WORLD_DB_CLOSED');
  assert.strictEqual(parseArgs(['import','--input','world.json','--request-id','test','--expected-revision','0']).expectedRevision, '0');
  assert.throws(() => parseArgs(['status','--url','postgres://secret']), /option/);
  assert.throws(() => parseArgs(['unknown']), /Unknown/);
}
async function main() {
  for (const test of [testConnectionPolicy, testCapturedCheckpoints, testStoredCheckpointValidation, testMigrationHistory, testErrorRedaction, testCloseAndCliContracts]) {
    await test(); console.log(`PASS ${test.name}`);
  }
  console.log('postgres database contract test passed (6 scenario groups)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
