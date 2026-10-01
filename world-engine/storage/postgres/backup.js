'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MIGRATIONS, checkMigrationHistory } = require('./migrations');
const { databaseError } = require('./config');
const { digest, restoreSave } = require('./codec');

const TABLES = Object.freeze({
  worlds: ['world_id', 'revision', 'latest_sequence', 'updated_at'],
  world_saves: ['sequence', 'world_id', 'revision', 'tick', 'save_schema', 'request_id', 'request_hash', 'payload_digest', 'envelope', 'saved_at'],
  world_events: ['sequence', 'world_id', 'save_sequence', 'event_id', 'tick', 'type', 'payload', 'created_at'],
  world_commands: ['sequence', 'world_id', 'command_id', 'player_id', 'input', 'input_digest', 'status', 'result', 'applied_save_sequence', 'submitted_at', 'applied_at'],
  command_api_audit: ['sequence', 'request_id', 'world_id', 'account_id', 'player_id', 'command_id', 'method', 'route', 'status_code', 'error_code', 'created_at'],
});
const SEQUENCED = Object.keys(TABLES).filter(table => table !== 'worlds');
const JSON_COLUMNS = new Set(['envelope', 'payload', 'input', 'result']);
const FORMAT = 'phyrex-postgres-snapshot';

function fail(message = 'Invalid database backup') { throw databaseError('INVALID_BACKUP', message); }
function header() { return { type: 'header', format: FORMAT, version: 1,
  migrations: MIGRATIONS.map(({ version, name, checksum }) => ({ version, name, checksum })) }; }
function validateHeader(record) {
  if (record?.type !== 'header' || record.format !== FORMAT || record.version !== 1) fail();
  if (checkMigrationHistory(record.migrations) !== MIGRATIONS.length) fail('Backup schema version must match the engine');
}
function validateRow(record) {
  const columns = TABLES[record.table];
  const row = record.values;
  if (record.type !== 'row' || !Object.hasOwn(TABLES, record.table) || !row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).length !== columns.length || columns.some(key => !Object.hasOwn(row, key))) fail();
  if (record.table === 'world_saves') restoreSave(row);
  if (record.table === 'world_commands' && digest(row.input) !== row.input_digest) fail('Command input checksum mismatch');
}
function sequenceNext(record) {
  if (!record || !/^[1-9][0-9]{0,15}$/.test(String(record.lastValue)) || typeof record.isCalled !== 'boolean') fail();
  const value = BigInt(record.lastValue);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail();
  return value + (record.isCalled ? 1n : 0n);
}

function createBackupOperations({ transaction, readSchema, ensureReady, schema }) {
  async function exportSnapshot(writeRecord) {
    if (typeof writeRecord !== 'function') throw databaseError('INVALID_INPUT', 'Backup writer required');
    await ensureReady();
    return transaction(async client => {
      await readSchema(client);
      await writeRecord(header());
      const counts = {};
      for (const table of Object.keys(TABLES)) {
        const order = table === 'worlds' ? 'world_id' : 'sequence';
        await client.query(`DECLARE engine_backup_cursor NO SCROLL CURSOR FOR SELECT to_jsonb(t) AS data FROM ${schema}.${table} t ORDER BY ${order}`);
        counts[table] = 0;
        while (true) {
          const rows = await client.query(`FETCH FORWARD ${table === 'world_saves' ? 1 : 32} FROM engine_backup_cursor`);
          if (!rows.rows.length) break;
          for (const { data } of rows.rows) {
            const record = { type: 'row', table, values: data };
            validateRow(record);
            await writeRecord(record);
            counts[table]++;
          }
        }
        await client.query('CLOSE engine_backup_cursor');
      }
      // Sequences are not MVCC. Reading after all rows preserves at least the
      // snapshot's high-water marks, including gaps from concurrent/failed writes.
      const values = {};
      for (const table of SEQUENCED) {
        const result = await client.query(`SELECT last_value::text AS value, is_called FROM ${schema}."${table}_sequence_seq"`);
        values[table] = { lastValue: result.rows[0].value, isCalled: result.rows[0].is_called };
      }
      await writeRecord({ type: 'sequences', values });
      return { counts };
    }, true);
  }

  async function restoreSnapshot(records) {
    if (!records?.[Symbol.asyncIterator]) throw databaseError('INVALID_INPUT', 'Backup reader required');
    await ensureReady();
    return transaction(async client => {
      await readSchema(client);
      const tables = Object.keys(TABLES);
      await client.query(`LOCK TABLE ${tables.map(table => `${schema}.${table}`).join(',')} IN ACCESS EXCLUSIVE MODE`);
      for (const table of tables) {
        const found = await client.query(`SELECT 1 FROM ${schema}.${table} LIMIT 1`);
        if (found.rows.length) throw databaseError('RESTORE_TARGET_NOT_EMPTY', 'Restore requires an empty dedicated schema');
      }
      let seenHeader = false, seenFooter = false, sequences = null, lastTable = -1;
      const counts = Object.fromEntries(tables.map(table => [table, 0]));
      for await (const record of records) {
        if (!seenHeader) { validateHeader(record); seenHeader = true; continue; }
        if (seenFooter) fail('Backup contains records after footer');
        if (record.type === 'row') {
          if (sequences) fail();
          validateRow(record);
          const index = tables.indexOf(record.table);
          if (index < lastTable) fail('Backup table order is invalid');
          lastTable = index;
          const columns = TABLES[record.table];
          const values = columns.map(key => JSON_COLUMNS.has(key) && record.values[key] !== null
            ? JSON.stringify(record.values[key]) : record.values[key]);
          await client.query(`INSERT INTO ${schema}.${record.table} (${columns.join(',')}) OVERRIDING SYSTEM VALUE VALUES (${columns.map((_, n) => `$${n + 1}`).join(',')})`, values);
          counts[record.table]++;
        } else if (record.type === 'sequences') {
          if (sequences || Object.keys(record.values || {}).length !== SEQUENCED.length) fail();
          for (const table of SEQUENCED) sequenceNext(record.values[table]);
          sequences = record.values;
        } else if (record.type === 'footer') {
          if (!sequences || digest(record.counts) !== digest(counts)) fail();
          seenFooter = true;
        } else fail();
      }
      if (!seenHeader || !seenFooter || !sequences) fail('Incomplete database backup');
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      for (const table of SEQUENCED) {
        const result = await client.query(`SELECT COALESCE(MAX(sequence),0)::text AS maximum FROM ${schema}.${table}`);
        const next = sequenceNext(sequences[table]);
        if (next <= BigInt(result.rows[0].maximum)) fail('Sequence high-water mark is below restored data');
        // ALTER RESTART is transactional, unlike setval: a failed import cannot
        // leave a rewound identity sequence behind.
        await client.query(`ALTER SEQUENCE ${schema}."${table}_sequence_seq" RESTART WITH ${next.toString()}`);
      }
      return { counts, restored: true };
    });
  }
  return { exportSnapshot, restoreSnapshot };
}

async function exportBackupFile(store, file, options = {}) {
  const destination = path.resolve(file);
  const temporary = `${destination}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const maxLineBytes = lineLimit(options.maxLineBytes);
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    const write = async record => {
      const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
      if (line.length > maxLineBytes) throw databaseError('BACKUP_RECORD_TOO_LARGE', 'Backup record exceeds configured line limit');
      hash.update(line);
      await handle.writeFile(line);
    };
    const result = await store.exportSnapshot(write);
    const checksum = hash.digest('hex');
    await handle.writeFile(`${JSON.stringify({ type: 'footer', checksum, counts: result.counts })}\n`);
    await handle.sync();
    await handle.close(); handle = null;
    // Publish without replacing an existing backup, even under concurrent writers.
    await fs.promises.link(temporary, destination);
    return { ...result, checksum, file: destination };
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

function lineLimit(value = 64 * 1024 * 1024) {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 1024 * 1024 * 1024) throw databaseError('INVALID_INPUT', 'Invalid backup line limit');
  return value;
}
async function* readBackupFile(file, options = {}) {
  const limit = lineLimit(options.maxLineBytes);
  const stream = fs.createReadStream(file);
  const hash = crypto.createHash('sha256');
  let parts = [], size = 0, footer = false, first = true;
  try {
    for await (const chunk of stream) {
      let start = 0;
      while (start < chunk.length) {
        const end = chunk.indexOf(10, start);
        const part = chunk.subarray(start, end < 0 ? chunk.length : end + 1);
        parts.push(part); size += part.length;
        if (size > limit) fail('Backup line exceeds configured limit');
        if (end < 0) break;
        const line = Buffer.concat(parts, size);
        parts = []; size = 0; start = end + 1;
        if (footer) fail('Backup contains trailing data');
        let record;
        try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); } catch (_) { fail('Invalid UTF-8 JSON backup record'); }
        if (!record || typeof record !== 'object' || Array.isArray(record)
            || !['header', 'row', 'sequences', 'footer'].includes(record.type)) fail();
        if (first) { validateHeader(record); first = false; }
        else if (record.type === 'header') fail('Duplicate backup header');
        if (record?.type === 'footer') {
          if (record.checksum !== hash.digest('hex')) fail('Backup checksum mismatch');
          footer = true;
        } else hash.update(line);
        yield record;
      }
    }
    if (size || first || !footer) fail('Incomplete database backup');
  } finally { stream.destroy(); }
}
async function verifyBackupFile(file, options = {}) {
  const counts = Object.fromEntries(Object.keys(TABLES).map(table => [table, 0]));
  let lastTable = -1, sequences = false, result;
  for await (const record of readBackupFile(file, options)) {
    if (record.type === 'row') {
      validateRow(record);
      const index = Object.keys(TABLES).indexOf(record.table);
      if (sequences || index < lastTable) fail();
      lastTable = index; counts[record.table]++;
    } else if (record.type === 'sequences') {
      if (sequences || Object.keys(record.values || {}).length !== SEQUENCED.length) fail();
      for (const table of SEQUENCED) sequenceNext(record.values[table]);
      sequences = true;
    } else if (record.type === 'footer') {
      if (!sequences || digest(record.counts) !== digest(counts)) fail();
      result = { valid: true, counts, checksum: record.checksum };
    } else if (record.type !== 'header' || sequences || lastTable >= 0) fail();
  }
  return result;
}
module.exports = { TABLES, SEQUENCED, header, validateRow, createBackupOperations,
  exportBackupFile, readBackupFile, verifyBackupFile };
