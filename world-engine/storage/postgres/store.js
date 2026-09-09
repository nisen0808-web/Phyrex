'use strict';
const crypto = require('crypto');
const { normalizePostgresConfig, safePostgresConfig, databaseError, integer } = require('./config');
const { MIGRATIONS, checkMigrationHistory } = require('./migrations');
const { textId, safeInteger, fromSqlInteger, captureCheckpoint, captureEvent, digest,
  canonicalJson, summarizeSave, restoreSave } = require('./codec');

function createPostgresDatabaseStore(options = {}) {
  const config = normalizePostgresConfig(options.database || options, options.env || process.env);
  let Pool;
  try { Pool = options.Pool || require('pg').Pool; }
  catch (_) { throw databaseError('DRIVER_MISSING', 'Install world-engine dependencies to enable PostgreSQL'); }
  const pool = new Pool({ connectionString: config.connectionString, ssl: config.ssl, max: config.max,
    connectionTimeoutMillis: config.connectionTimeoutMillis, idleTimeoutMillis: config.idleTimeoutMillis,
    application_name: 'phyrex-world-engine', statement_timeout: config.statementTimeoutMillis, lock_timeout: config.lockTimeoutMillis });
  const schema = `"${config.schema}"`;
  let ready = null, closing = false, closePromise = null, poolErrors = 0;
  pool.on('error', () => { poolErrors += 1; }); // Do not leak idle-client errors or let them crash the process.
  function assertOpen() { if (closing) throw databaseError('CLOSED', 'PostgreSQL store is closed'); }
  async function transaction(work, readOnly = false) {
    assertOpen();
    let client, broken = false;
    try {
      client = await pool.connect();
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      await client.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)",
        [String(config.statementTimeoutMillis), String(config.lockTimeoutMillis)]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) { try { await client.query('ROLLBACK'); } catch (_) { broken = true; } }
      throw sanitizeError(error);
    } finally { if (client) client.release(broken); }
  }
  async function readSchema(client, requireCurrent = true) {
    const result = await client.query(`SELECT version, name, checksum FROM ${schema}.schema_migrations ORDER BY version`);
    const version = checkMigrationHistory(result.rows);
    if (requireCurrent && version !== MIGRATIONS.length) throw databaseError('MIGRATION_REQUIRED', 'Run the migration command before use');
    return version;
  }
  function ensureReady() {
    assertOpen();
    if (!ready) ready = transaction(client => readSchema(client), true).catch(error => { ready = null; throw error; });
    return ready;
  }
  async function migrate() {
    const lock = crypto.createHash('sha256').update(`phyrex:world-db:migration:${config.schema}`).digest().readBigInt64BE(0).toString();
    const result = await transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lock]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
        version integer PRIMARY KEY CHECK (version > 0), name text NOT NULL,
        checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'), applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
      const before = await readSchema(client, false);
      for (const migration of MIGRATIONS.slice(before)) {
        await client.query(migration.sql.replaceAll('__SCHEMA__', schema));
        await client.query(`INSERT INTO ${schema}.schema_migrations(version,name,checksum) VALUES ($1,$2,$3)`,
          [migration.version, migration.name, migration.checksum]);
      }
      return { provider: 'postgres', schema: config.schema, version: MIGRATIONS.length, applied: MIGRATIONS.length - before };
    });
    ready = Promise.resolve(result.version);
    return result;
  }
  async function insertEvent(client, event, saveSequence = null) {
    const result = await client.query(`INSERT INTO ${schema}.world_events
      (world_id,save_sequence,event_id,tick,type,payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
    [event.worldId, saveSequence, event.id, event.tick, event.type, JSON.stringify(event.payload)]);
    return summarizeEvent(result.rows[0]);
  }
  async function saveWorld(world, saveOptions = {}) {
    assertOpen();
    const snapshot = captureCheckpoint(world, saveOptions, config.maxEnvelopeBytes);
    await ensureReady();
    return transaction(async client => {
      const { envelope, expectedRevision, requestId, requestHash, checksum, events } = snapshot;
      await client.query(`INSERT INTO ${schema}.worlds(world_id) VALUES ($1) ON CONFLICT (world_id) DO NOTHING`, [envelope.worldId]);
      const current = await client.query(`SELECT revision FROM ${schema}.worlds WHERE world_id=$1 FOR UPDATE`, [envelope.worldId]);
      const existing = await client.query(`SELECT * FROM ${schema}.world_saves WHERE world_id=$1 AND request_id=$2`, [envelope.worldId, requestId]);
      if (existing.rows.length) {
        if (existing.rows[0].request_hash !== requestHash) throw databaseError('IDEMPOTENCY_CONFLICT', 'Request ID was already used for a different checkpoint');
        restoreSave(existing.rows[0]);
        return summarizeSave(existing.rows[0], true);
      }
      const revision = fromSqlInteger(current.rows[0].revision, 'revision');
      if (revision !== expectedRevision) {
        const error = databaseError('REVISION_CONFLICT', 'World revision changed; reload before writing');
        error.expectedRevision = expectedRevision; error.actualRevision = revision;
        throw error;
      }
      if (revision === Number.MAX_SAFE_INTEGER) throw databaseError('REVISION_EXHAUSTED', 'World revision limit reached');
      const inserted = await client.query(`INSERT INTO ${schema}.world_saves
        (world_id,revision,tick,save_schema,request_id,request_hash,payload_digest,envelope)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
      [envelope.worldId, revision + 1, envelope.tick, envelope.schemaVersion, requestId, requestHash, checksum, JSON.stringify(envelope)]);
      const row = inserted.rows[0];
      // The snapshot, audit event, caller events and latest-world pointer share one transaction.
      await insertEvent(client, { id: `checkpoint:${requestId}`, worldId: envelope.worldId, tick: envelope.tick,
        type: 'database.world_saved', payload: { revision: revision + 1, checksum } }, row.sequence);
      for (const event of events) await insertEvent(client, event, row.sequence);
      await client.query(`UPDATE ${schema}.worlds SET revision=$2, latest_sequence=$3, updated_at=clock_timestamp() WHERE world_id=$1`,
        [envelope.worldId, revision + 1, row.sequence]);
      return summarizeSave(row);
    });
  }
  async function loadWorld(worldId = null, loadOptions = {}) {
    if (worldId !== null) textId(worldId, 'worldId');
    if (loadOptions.revision !== undefined) safeInteger(loadOptions.revision, 'revision', 1);
    await ensureReady();
    return transaction(async client => {
      let selected = worldId;
      if (selected === null) {
        const worlds = await client.query(`SELECT world_id FROM ${schema}.worlds WHERE latest_sequence IS NOT NULL ORDER BY world_id LIMIT 2`);
        if (!worlds.rows.length) return null;
        if (worlds.rows.length !== 1) throw databaseError('AMBIGUOUS_WORLD', 'Specify worldId when multiple worlds exist');
        selected = worlds.rows[0].world_id;
      }
      const result = loadOptions.revision === undefined
        ? await client.query(`SELECT s.* FROM ${schema}.worlds w JOIN ${schema}.world_saves s
          ON s.world_id=w.world_id AND s.sequence=w.latest_sequence WHERE w.world_id=$1`, [selected])
        : await client.query(`SELECT * FROM ${schema}.world_saves WHERE world_id=$1 AND revision=$2`, [selected, loadOptions.revision]);
      return result.rows.length ? restoreSave(result.rows[0]) : null;
    }, true);
  }
  async function listWorlds(listOptions = {}) {
    const limit = integer(listOptions.limit, 100, 1, 1000, 'world limit');
    await ensureReady();
    return transaction(async client => {
      const result = await client.query(`SELECT s.* FROM ${schema}.worlds w JOIN ${schema}.world_saves s
        ON s.world_id=w.world_id AND s.sequence=w.latest_sequence ORDER BY w.updated_at DESC,w.world_id LIMIT $1`, [limit]);
      return result.rows.map(row => summarizeSave(row));
    }, true);
  }
  async function appendEvent(input) {
    const event = captureEvent(input);
    if (Buffer.byteLength(canonicalJson(event)) > config.maxEnvelopeBytes) throw databaseError('PAYLOAD_TOO_LARGE', 'Event exceeds size limit');
    await ensureReady();
    return transaction(async client => {
      const inserted = await client.query(`INSERT INTO ${schema}.world_events
        (world_id,event_id,tick,type,payload) VALUES ($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT (world_id,event_id) DO NOTHING RETURNING *`, [event.worldId,event.id,event.tick,event.type,JSON.stringify(event.payload)]);
      if (inserted.rows.length) return summarizeEvent(inserted.rows[0]);
      const existing = await client.query(`SELECT * FROM ${schema}.world_events WHERE world_id=$1 AND event_id=$2`, [event.worldId,event.id]);
      const previous = summarizeEvent(existing.rows[0]);
      if (previous.tick !== event.tick || previous.type !== event.type || digest(previous.payload) !== digest(event.payload)) {
        throw databaseError('IDEMPOTENCY_CONFLICT', 'Event ID was already used for different data');
      }
      return { ...previous, idempotent: true };
    });
  }
  async function listEvents(listOptions = {}) {
    const limit = integer(listOptions.limit, 100, 1, 1000, 'event limit');
    const order = listOptions.order ?? 'desc';
    if (!['asc', 'desc'].includes(order)) throw databaseError('INVALID_INPUT', 'Event order must be asc or desc');
    const conditions = [], values = [];
    const add = (clause, value) => { values.push(value); conditions.push(clause.replace('?', `$${values.length}`)); };
    if (listOptions.worldId !== undefined) add('world_id = ?', textId(listOptions.worldId, 'worldId'));
    if (listOptions.type !== undefined) add('type = ?', textId(listOptions.type, 'event type', 128));
    if (listOptions.afterSequence !== undefined) add('sequence > ?', safeInteger(listOptions.afterSequence, 'afterSequence'));
    if (listOptions.beforeSequence !== undefined) add('sequence < ?', safeInteger(listOptions.beforeSequence, 'beforeSequence', 1));
    values.push(limit);
    await ensureReady();
    return transaction(async client => {
      const result = await client.query(`SELECT * FROM ${schema}.world_events ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY sequence ${order.toUpperCase()} LIMIT $${values.length}`, values);
      return result.rows.map(summarizeEvent);
    }, true);
  }
  async function summary() {
    await ensureReady();
    return transaction(async client => {
      const version = await readSchema(client);
      const result = await client.query(`SELECT current_setting('server_version') AS server_version,
        (SELECT count(*) FROM ${schema}.worlds) AS worlds, (SELECT count(*) FROM ${schema}.world_saves) AS records,
        (SELECT count(*) FROM ${schema}.world_events) AS events`);
      const row = result.rows[0];
      return { ...safePostgresConfig(config), ready: true, connected: true, supported: true,
        schemaVersion: version, serverVersion: row.server_version, poolErrors,
        worlds: fromSqlInteger(row.worlds), records: fromSqlInteger(row.records), events: fromSqlInteger(row.events) };
    }, true);
  }
  function close() {
    if (!closePromise) { closing = true; closePromise = pool.end(); }
    return closePromise;
  }
  return Object.freeze({ version: 1, provider: 'postgres', config: Object.freeze(safePostgresConfig(config)),
    migrate, saveWorld, loadWorld, listWorlds, appendEvent, listEvents, summary, close });
}
function summarizeEvent(row) {
  return { provider: 'postgres', id: row.event_id, worldId: row.world_id,
    sequence: fromSqlInteger(row.sequence), saveSequence: row.save_sequence === null ? null : fromSqlInteger(row.save_sequence),
    tick: fromSqlInteger(row.tick), type: row.type, payload: row.payload,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at };
}
function sanitizeError(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('WORLD_DB_')) return error;
  const sqlState = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
  const unavailable = /^(08|57P)/.test(sqlState || '') || ['ECONNREFUSED','ECONNRESET','ENOTFOUND','ETIMEDOUT','EPIPE'].includes(error?.code);
  const code = unavailable ? 'UNAVAILABLE' : ['42P01','3F000'].includes(sqlState) ? 'MIGRATION_REQUIRED'
    : ['57014','55P03'].includes(sqlState) ? 'TIMEOUT' : 'SQL_ERROR';
  const safe = databaseError(code, `PostgreSQL operation failed${sqlState ? ` (${sqlState})` : ''}`);
  if (sqlState) safe.sqlState = sqlState;
  return safe;
}
module.exports = { createPostgresDatabaseStore, sanitizeError };
