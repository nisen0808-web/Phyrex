'use strict';
const assert = require('assert');
const { captureCheckpoint, restoreSave, restoreReadView, digest } = require('../storage/postgres/codec');
const { fixture } = require('./helpers/service-fixture');

function record(world) {
  const captured = captureCheckpoint(world, { requestId: 'read-codec', expectedRevision: 0 });
  return { world_id: world.id, request_id: 'read-codec', sequence: '1', revision: '1', tick: world.tick,
    save_schema: captured.envelope.schemaVersion, saved_at: captured.envelope.savedAt, envelope: captured.envelope,
    request_hash: captured.requestHash, payload_digest: captured.checksum, archived_at: null, archived_metadata: null };
}
function textRow(row) {
  const { envelope, ...headers } = row;
  return { ...headers, envelope_json: JSON.stringify(envelope) };
}
const row = record(fixture().state.world);
row.envelope.metadata.edge = JSON.parse('{"__proto__":{"value":1},"10":"十","2":"二","escaped":"\\n\\\"\\u0000","array":[null,true,0,-1.5]}');
// Legacy/transient repairs must be identical and run after checksum validation.
row.envelope.world.entities.character._cacheSet = ['transient'];
row.payload_digest = digest(row.envelope);
const sql = textRow(row), before = JSON.stringify(row);
const normal = restoreSave(row), first = restoreReadView(sql), second = restoreReadView(sql);
assert.deepStrictEqual(first, normal);
assert.equal(first.world.entities.character._cacheSet, undefined);
first.world.entities.character.name = 'private'; first.metadata.edge.array.push(4);
assert.deepStrictEqual(second, normal);
assert.equal(JSON.stringify(row), before, 'mutable restoration must still leave the input untouched');
assert.equal(sql.envelope_json, textRow(row).envelope_json);
assert.equal({}.value, undefined);

for (const patch of [{ envelope_json: undefined }, { envelope_json: {} }, { envelope_json: '{' },
  { envelope_json: sql.envelope_json.replace('"tick":0', '"tick":1') }, { payload_digest: '0'.repeat(64) },
  { revision: -1 }, { world_id: 'wrong-world' }, { tick: row.tick + 1 }, { save_schema: 999 }]) {
  assert.throws(() => restoreReadView({ ...sql, ...patch }), { code: 'WORLD_DB_CORRUPT_RECORD' });
}
const future = structuredClone(row); future.envelope.schemaVersion = future.save_schema = 999;
future.payload_digest = digest(future.envelope);
assert.throws(() => restoreReadView(textRow(future)), { code: 'WORLD_DB_CORRUPT_RECORD' });
// Even a matching digest of the JS-overflow value must not make it admissible.
for (const literal of ['1e400','-1e400']) {
  const overflow = structuredClone(row); overflow.envelope.metadata.bad = Number(literal);
  const envelope_json = JSON.stringify({ ...overflow.envelope, metadata: { ...overflow.envelope.metadata, bad: '__number__' } }).replace('"__number__"',literal);
  assert.throws(() => restoreReadView({ ...sql, envelope_json, payload_digest: digest(overflow.envelope) }), { code: 'WORLD_DB_CORRUPT_RECORD' });
}
const archived = { ...sql, envelope_json: 'null', archived_at: '2026-10-10T00:00:00Z', archived_metadata: {} };
assert.throws(() => restoreReadView(archived), { code: 'WORLD_DB_CHECKPOINT_ARCHIVED' });
const negativeZero = structuredClone(row); negativeZero.envelope.metadata.zero = -0;
negativeZero.payload_digest = digest(negativeZero.envelope);
const zeroSql = textRow(negativeZero); zeroSql.envelope_json = zeroSql.envelope_json.replace('"zero":0','"zero":-1e-400');
assert.deepStrictEqual(restoreReadView(zeroSql), restoreSave(negativeZero));
console.log('PostgreSQL read codec passed: exact legacy results, private ownership, headers, checksums, finite JSON and archived receipts');
