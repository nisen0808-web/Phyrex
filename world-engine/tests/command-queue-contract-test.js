'use strict';
const assert = require('assert');
const { normalizePostgresConfig, safePostgresConfig } = require('../storage/postgres/config');
const { summarizeCommandReceipt } = require('../storage/postgres/command-queue');
const { mapError } = require('../core/durable-command-api-engine');
async function main() {
  const base = { connectionString: 'postgres://test:private@127.0.0.1/queue_test' };
  const defaults = normalizePostgresConfig(base, {});
  assert.strictEqual(defaults.maxPendingCommands, 10000); assert.strictEqual(defaults.maxPendingPerPlayer, 1000);
  const env = { WORLD_ENGINE_COMMAND_QUEUE_MAX_PENDING: '12', WORLD_ENGINE_COMMAND_QUEUE_MAX_PLAYER_PENDING: '3' };
  assert.strictEqual(normalizePostgresConfig(base, env).maxPendingCommands, 12);
  assert.strictEqual(normalizePostgresConfig({ ...base, maxPendingPerPlayer: 5 }, env).maxPendingPerPlayer, 5);
  for (const key of ['maxPendingCommands', 'maxPendingPerPlayer']) for (const value of [0, -1, '', NaN, Infinity, 1.5, 100001]) assert.throws(() => normalizePostgresConfig({ ...base, [key]: value }, {}));
  assert.ok(!JSON.stringify(safePostgresConfig(defaults)).includes('private'));
  const receipt = summarizeCommandReceipt({ command_id: 'c', world_id: 'w', player_id: 'p', sequence: '17', status: 'pending',
    submitted_at: new Date('2026-01-01T00:00:00Z'), applied_at: null, input: { secret: true }, result: { secret: true }, input_digest: 'secret' });
  assert.deepStrictEqual(Object.keys(receipt).sort(), ['appliedAt', 'id', 'playerId', 'sequence', 'status', 'submittedAt', 'worldId']);
  assert.strictEqual(receipt.sequence, 17);
  assert.deepStrictEqual(mapError({ code: 'WORLD_DB_QUEUE_FULL' }), { status: 429, code: 'command_queue_full', retryAfterMs: 1000 });
  assert.strictEqual(mapError({ code: 'WORLD_DB_PLAYER_QUEUE_FULL' }).code, 'player_queue_full');
  console.log('command queue contract test passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
