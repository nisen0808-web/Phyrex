'use strict';
const assert = require('assert');
const { MIGRATIONS } = require('../storage/postgres/migrations');
const { parseArguments } = require('../demo/database-maintenance-cli');
const { captureCheckpoint, restoreSave, validateArchivedSave } = require('../storage/postgres/codec');
const { createWorld } = require('../core/world-engine');

assert.deepStrictEqual(MIGRATIONS.slice(0, 3).map(({ version, name, checksum }) => ({ version, name, checksum })), [
  { version: 1, name: 'transactional_world_checkpoints', checksum: '137f0bd0d7e9fa464121b50e1d575ae86c7a9ce4156dab8be2605aa7d267dbc4' },
  { version: 2, name: 'durable_command_inbox', checksum: '0c3651b742847888d53aa04323be6c5bd6c3e2483e99167709f6f3edd6a17ed9' },
  { version: 3, name: 'durable_command_api_audit', checksum: 'c7ebd62c4ef65c8426858702f6bd90d9098abde40016e1833d93ce9853fc1874' },
]);
assert.strictEqual(MIGRATIONS[3].name, 'checkpoint_and_audit_retention_receipts');
assert.ok(!parseArguments(['checkpoints', '--world-id', '世界']).options.apply);
assert.strictEqual(parseArguments(['audit', '--before-sequence', '123', '--limit', '3']).options.limit, 3);
for (const args of [[], ['audit'], ['checkpoints'], ['audit', '--before-sequence', '1e3'],
  ['audit', '--before-sequence', '0'], ['audit', '--before-sequence', '10', '--limit', '1001'],
  ['checkpoints', '--world-id', 'w', '--apply'], ['checkpoints', '--world-id', 'w', '--apply', '--backup', 'backup'],
  ['audit', '--before-sequence', '10', '--backup', 'backup'], ['audit', '--before-sequence', '10', '--apply', '--apply'],
  ['audit', '--before-sequence', '10', '--unknown', 'x']]) {
  assert.throws(() => parseArguments(args), error => error.code === 'WORLD_DB_INVALID_INPUT');
}
const captured = captureCheckpoint(createWorld({ id: 'archive-unit', seed: 4 }), { requestId: 'seed', expectedRevision: 0 });
const row = { world_id: 'archive-unit', request_id: 'seed', revision: 1, sequence: 1, tick: 0,
  save_schema: captured.envelope.schemaVersion, saved_at: captured.envelope.savedAt,
  request_hash: captured.requestHash, payload_digest: captured.checksum, envelope: null,
  archived_at: '2026-10-02T00:00:00Z', archived_metadata: {} };
assert.strictEqual(validateArchivedSave(row), true);
assert.throws(() => restoreSave(row), error => error.code === 'WORLD_DB_CHECKPOINT_ARCHIVED');
for (const patch of [{ archived_metadata: null }, { archived_metadata: [] }, { archived_at: null }, { request_hash: 'invalid' }]) {
  assert.throws(() => validateArchivedSave({ ...row, ...patch }), error => error.code === 'WORLD_DB_CORRUPT_RECORD');
}
console.log('database maintenance passed: immutable migrations, explicit apply/backup/fence and archived receipt validation');
