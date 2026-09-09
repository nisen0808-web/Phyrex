'use strict';
const assert = require('assert');
const { createWorld } = require('../core/world-engine');
const { captureInboxCommand, captureCommandResult, captureCheckpoint, digest } = require('../storage/postgres/codec');
const { MIGRATIONS } = require('../storage/postgres/migrations');

function main() {
  let groups = 0;
  const pass = name => { groups += 1; console.log(`PASS ${name}`); };

  const command = captureInboxCommand({
    worldId: 'command_world',
    id: 'external-command-1',
    playerId: 'player-1',
    input: { id: 'ignored-client-id', type: 'move', locationId: 'town', payload: { priority: 80 } },
  });
  assert.strictEqual(command.id, 'external-command-1');
  assert.strictEqual(command.playerId, 'player-1');
  assert.strictEqual(command.input.id, undefined);
  assert.strictEqual(command.input.type, 'move');
  assert.strictEqual(command.inputDigest, digest(command.input));
  pass('command capture owns the durable id and hashes finite input');

  assert.throws(() => captureInboxCommand({ worldId: 'w', id: 'c', playerId: 'p', input: {} }), /command type/);
  assert.throws(() => captureInboxCommand({ worldId: 'w', id: 'c', playerId: 'p', input: { type: 'move', payload: [] } }), /payload/);
  assert.throws(() => captureInboxCommand({ worldId: 'w', id: 'c', playerId: 'p', input: { type: 'move', payload: { bad: NaN } } }), /finite/);
  assert.throws(() => captureInboxCommand({ worldId: 'w', id: 'c', playerId: 'p', input: { type: 'move', text: 'x'.repeat(300000) } }), /size/);
  pass('invalid or oversized command input is rejected before SQL');

  const applied = captureCommandResult({ sequence: 4, id: command.id, playerId: command.playerId,
    inputDigest: command.inputDigest, result: { ok: true, completed: false, actionId: 'action-1' } });
  assert.strictEqual(applied.sequence, 4);
  assert.throws(() => captureCommandResult({ ...applied, inputDigest: 'bad' }), /digest/);
  assert.throws(() => captureCommandResult({ ...applied, result: [] }), /object/);
  pass('command application receipt is finite and binds sequence, identity and input digest');

  const world = createWorld({ id: 'command_world', seed: 'commands' });
  const base = { requestId: 'save-command', expectedRevision: 0, commandResults: [applied] };
  const first = captureCheckpoint(world, base), second = captureCheckpoint(world, base);
  assert.strictEqual(first.requestHash, second.requestHash);
  const changed = captureCheckpoint(world, { ...base, commandResults: [{ ...applied, result: { ok: false, reason: 'rejected' } }] });
  assert.notStrictEqual(first.requestHash, changed.requestHash);
  assert.throws(() => captureCheckpoint(world, { ...base, commandResults: [applied, applied] }), /unique/);
  pass('checkpoint idempotency hash covers command results and rejects duplicate receipts');

  assert.ok(MIGRATIONS.some(migration => migration.name === 'durable_command_inbox'));
  assert.strictEqual(MIGRATIONS[MIGRATIONS.length - 1].version, 2);
  pass('command inbox is an explicit immutable migration');

  console.log(`postgres command inbox contracts completed ${groups} groups: ${groups} passed, 0 failed`);
}

main();
