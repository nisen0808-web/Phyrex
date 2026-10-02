'use strict';
const { databaseError, integer } = require('./config');
const { textId, safeInteger, fromSqlInteger } = require('./codec');

// Scan only a bounded prefix of the existing pending index, never applied
// history. If the world is below its cap this prefix contains every pending row.
async function readPendingCapacity(client, schema, worldId, playerId, limit) {
  const result = await client.query(`SELECT count(*) AS pending,
    count(*) FILTER (WHERE player_id=$2) AS player_pending, min(sequence) AS oldest_sequence
    FROM (SELECT player_id, sequence FROM ${schema}.world_commands
      WHERE world_id=$1 AND status='pending' ORDER BY sequence LIMIT $3) pending`, [worldId, playerId, limit]);
  const row = result.rows[0];
  return { pending: fromSqlInteger(row.pending), playerPending: fromSqlInteger(row.player_pending),
    oldestPendingSequence: row.oldest_sequence === null ? null : fromSqlInteger(row.oldest_sequence) };
}
function summarizeCommandReceipt(row) {
  const timestamp = value => value instanceof Date ? value.toISOString() : value || null;
  return { id: row.command_id, worldId: row.world_id, playerId: row.player_id,
    sequence: fromSqlInteger(row.sequence), status: row.status,
    submittedAt: timestamp(row.submitted_at), appliedAt: timestamp(row.applied_at) };
}
function createCommandQueueOperations({ transaction, ensureReady, schema, config }) {
  async function readRevision(client, worldId, expected) {
    const result = await client.query(`SELECT revision FROM ${schema}.worlds WHERE world_id=$1 AND latest_sequence IS NOT NULL`, [worldId]);
    if (!result.rows.length) throw databaseError('MISSING_WORLD', 'Command world does not have a committed checkpoint');
    const revision = fromSqlInteger(result.rows[0].revision);
    if (expected !== undefined && expected !== revision) throw databaseError('REVISION_CONFLICT', 'Re-authorize before reading commands');
    return revision;
  }
  function expectedRevision(options) {
    return options.expectedWorldRevision === undefined ? undefined : safeInteger(options.expectedWorldRevision, 'expectedWorldRevision', 1);
  }
  async function listCommandReceipts(options = {}, readOptions = {}) {
    const worldId = textId(options.worldId, 'command worldId'), playerId = textId(options.playerId, 'command playerId');
    const limit = integer(options.limit, 50, 1, 100, 'command receipt limit');
    const expected = expectedRevision(readOptions);
    const conditions = ['world_id=$1', 'player_id=$2'], values = [worldId, playerId];
    if (options.beforeSequence !== undefined) { values.push(safeInteger(options.beforeSequence, 'beforeSequence', 1)); conditions.push(`sequence<$${values.length}`); }
    if (options.status !== undefined) {
      if (!['pending', 'applied'].includes(options.status)) throw databaseError('INVALID_INPUT', 'Invalid command status');
      values.push(options.status); conditions.push(`status=$${values.length}`);
    }
    values.push(limit);
    await ensureReady();
    return transaction(async client => {
      const revision = await readRevision(client, worldId, expected);
      // Do not transfer command input/result JSON merely to list identifiers.
      const result = await client.query(`SELECT command_id, world_id, player_id, sequence, status, submitted_at, applied_at
        FROM ${schema}.world_commands WHERE ${conditions.join(' AND ')} ORDER BY sequence DESC LIMIT $${values.length}`, values);
      return { worldId, playerId, revision, records: result.rows.map(summarizeCommandReceipt) };
    }, true);
  }
  async function getCommandQueue(worldId, readOptions = {}) {
    textId(worldId, 'command worldId');
    const expected = expectedRevision(readOptions);
    await ensureReady();
    return transaction(async client => {
      const revision = await readRevision(client, worldId, expected);
      const counts = await readPendingCapacity(client, schema, worldId, null, config.maxPendingCommands + 1);
      return { worldId, revision, pending: counts.pending, pendingIsLowerBound: counts.pending > config.maxPendingCommands,
        oldestPendingSequence: counts.oldestPendingSequence, worldCapacityAvailable: counts.pending < config.maxPendingCommands,
        limits: { maxPendingCommands: config.maxPendingCommands, maxPendingPerPlayer: config.maxPendingPerPlayer } };
    }, true);
  }
  return { listCommandReceipts, getCommandQueue };
}
module.exports = { createCommandQueueOperations, readPendingCapacity, summarizeCommandReceipt };
