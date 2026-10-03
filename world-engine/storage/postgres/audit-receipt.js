'use strict';
const crypto = require('crypto');
const { digest } = require('./codec');

function auditDigest(row) {
  return digest(Object.fromEntries(['requestId', 'worldId', 'accountId', 'playerId', 'commandId',
    'method', 'route', 'statusCode', 'errorCode'].map(key => [key, row[key]])));
}
function auditRecordInput(row) {
  return { requestId: row.request_id, worldId: row.world_id, accountId: row.account_id, playerId: row.player_id,
    commandId: row.command_id, method: row.method, route: row.route, statusCode: row.status_code, errorCode: row.error_code };
}
async function lockAuditRequest(client, schema, requestId) {
  const key = crypto.createHash('sha256').update(`phyrex:audit:${schema}:${requestId}`).digest().readBigInt64BE(0).toString();
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
}
module.exports = { auditDigest, auditRecordInput, lockAuditRequest };
