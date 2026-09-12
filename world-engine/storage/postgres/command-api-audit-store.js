'use strict';

const { normalizePostgresConfig, safePostgresConfig, databaseError, integer } = require('./config');
const { MIGRATIONS, checkMigrationHistory } = require('./migrations');
const { textId, safeInteger, fromSqlInteger } = require('./codec');
const { sanitizeError } = require('./store');

function createPostgresCommandApiAuditStore(options = {}) {
  const config = normalizePostgresConfig(options.database || options, options.env || process.env);
  let Pool;
  try { Pool = options.Pool || require('pg').Pool; }
  catch (_) { throw databaseError('DRIVER_MISSING', 'Install world-engine dependencies to enable PostgreSQL'); }
  const pool = new Pool({ connectionString: config.connectionString, ssl: config.ssl, max: Math.min(config.max, 4),
    connectionTimeoutMillis: config.connectionTimeoutMillis, idleTimeoutMillis: config.idleTimeoutMillis,
    application_name: 'phyrex-world-command-audit', statement_timeout: config.statementTimeoutMillis,
    lock_timeout: config.lockTimeoutMillis });
  const schema = `"${config.schema}"`;
  let ready = null, closing = false, closePromise = null;
  pool.on('error', () => {});

  function assertOpen() { if (closing) throw databaseError('CLOSED', 'PostgreSQL audit store is closed'); }
  async function transaction(work, readOnly = false) {
    assertOpen();
    let client, broken = false;
    try {
      client = await pool.connect();
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) { try { await client.query('ROLLBACK'); } catch (_) { broken = true; } }
      throw sanitizeError(error);
    } finally { if (client) client.release(broken); }
  }
  function ensureReady() {
    assertOpen();
    if (!ready) ready = transaction(async client => {
      const result = await client.query(`SELECT version,name,checksum FROM ${schema}.schema_migrations ORDER BY version`);
      const version = checkMigrationHistory(result.rows);
      if (version !== MIGRATIONS.length) throw databaseError('MIGRATION_REQUIRED', 'Run the migration command before command API audit use');
      return version;
    }, true).catch(error => { ready = null; throw error; });
    return ready;
  }

  async function append(input = {}) {
    const row = captureAudit(input);
    await ensureReady();
    return transaction(async client => {
      const inserted = await client.query(`INSERT INTO ${schema}.command_api_audit
        (request_id,world_id,account_id,player_id,command_id,method,route,status_code,error_code)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (request_id) DO NOTHING RETURNING *`,
      [row.requestId,row.worldId,row.accountId,row.playerId,row.commandId,row.method,row.route,row.statusCode,row.errorCode]);
      if (inserted.rows.length) return summarizeAudit(inserted.rows[0]);
      const existing = await client.query(`SELECT * FROM ${schema}.command_api_audit WHERE request_id=$1`, [row.requestId]);
      const previous = summarizeAudit(existing.rows[0]);
      for (const key of ['worldId','accountId','playerId','commandId','method','route','statusCode','errorCode']) {
        if (previous[key] !== row[key]) throw databaseError('IDEMPOTENCY_CONFLICT', 'Audit request ID was reused for different data');
      }
      return { ...previous, idempotent: true };
    });
  }

  async function list(options = {}) {
    const limit = integer(options.limit, 100, 1, 1000, 'audit limit');
    const order = options.order ?? 'desc';
    if (!['asc','desc'].includes(order)) throw databaseError('INVALID_INPUT', 'Audit order must be asc or desc');
    const conditions = [], values = [];
    const add = (clause, value) => { values.push(value); conditions.push(clause.replace('?', `$${values.length}`)); };
    if (options.worldId !== undefined) add('world_id = ?', textId(options.worldId, 'audit worldId'));
    if (options.accountId !== undefined) add('account_id = ?', textId(options.accountId, 'audit accountId'));
    if (options.playerId !== undefined) add('player_id = ?', textId(options.playerId, 'audit playerId'));
    if (options.commandId !== undefined) add('command_id = ?', textId(options.commandId, 'audit commandId', 256));
    if (options.method !== undefined) add('method = ?', textId(options.method, 'audit method', 16));
    if (options.route !== undefined) add('route = ?', textId(options.route, 'audit route', 64));
    if (options.statusCode !== undefined) add('status_code = ?', auditStatus(options.statusCode));
    if (options.afterSequence !== undefined) add('sequence > ?', safeInteger(options.afterSequence, 'audit afterSequence'));
    values.push(limit);
    await ensureReady();
    return transaction(async client => {
      const result = await client.query(`SELECT * FROM ${schema}.command_api_audit ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY sequence ${order.toUpperCase()} LIMIT $${values.length}`, values);
      return result.rows.map(summarizeAudit);
    }, true);
  }

  async function summary() {
    await ensureReady();
    return transaction(async client => {
      const result = await client.query(`SELECT count(*) AS records FROM ${schema}.command_api_audit`);
      return { ...safePostgresConfig(config), records: fromSqlInteger(result.rows[0].records, 'audit records') };
    }, true);
  }

  function close() {
    if (!closePromise) { closing = true; closePromise = pool.end(); }
    return closePromise;
  }

  return Object.freeze({ provider: 'postgres', append, list, summary, close });
}

function captureAudit(input) {
  const requestId = textId(input.requestId, 'audit requestId', 128);
  const method = textId(String(input.method || '').toUpperCase(), 'audit method', 16);
  const route = textId(input.route || 'unknown', 'audit route', 64);
  return {
    requestId,
    worldId: optionalText(input.worldId, 'audit worldId', 200),
    accountId: optionalText(input.accountId, 'audit accountId', 200),
    playerId: optionalText(input.playerId, 'audit playerId', 200),
    commandId: optionalText(input.commandId, 'audit commandId', 256),
    method,
    route,
    statusCode: auditStatus(input.statusCode),
    errorCode: optionalText(input.errorCode, 'audit errorCode', 128),
  };
}
function optionalText(value, name, max) { return value === undefined || value === null ? null : textId(value, name, max); }
function auditStatus(value) {
  const status = Number(value);
  if (!Number.isInteger(status) || status < 100 || status > 599) throw databaseError('INVALID_INPUT', 'Invalid audit status code');
  return status;
}
function summarizeAudit(row) {
  return {
    sequence: fromSqlInteger(row.sequence, 'audit sequence'), requestId: row.request_id,
    worldId: row.world_id, accountId: row.account_id, playerId: row.player_id, commandId: row.command_id,
    method: row.method, route: row.route, statusCode: Number(row.status_code), errorCode: row.error_code,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

module.exports = { createPostgresCommandApiAuditStore, captureAudit, summarizeAudit };
