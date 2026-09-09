'use strict';

const { wallClockIso } = require('../platform/runtime-clock');

const fs = require('fs');
const path = require('path');
const { createSaveEnvelope, migrateSaveEnvelope, repairLoadedWorld } = require('./persistence-engine');
const {
  DATABASE_PROVIDERS,
  loadDatabaseConfig,
  getDatabaseConfigSummary,
} = require('./database-config-engine');

const DATABASE_ENGINE_VERSION = 1;

function createDatabaseStore(options = {}) {
  const config = loadDatabaseConfig(options.database || options);
  if (config.provider === DATABASE_PROVIDERS.POSTGRES) {
    const { createPostgresDatabaseStore } = require('./postgres-database-engine');
    return createPostgresDatabaseStore({ ...(options.database || options), connectionString: config.connectionString });
  }
  return {
    version: DATABASE_ENGINE_VERSION,
    config,
    summary: () => getDatabaseStatus(config),
    saveWorld: (world, saveOptions = {}) => saveWorldToDatabase(world, { ...saveOptions, database: config }),
    loadWorld: (worldId = null, loadOptions = {}) => loadWorldFromDatabase(worldId, { ...loadOptions, database: config }),
    listWorlds: listOptions => listDatabaseWorlds({ ...(listOptions || {}), database: config }),
    appendEvent: event => appendDatabaseEvent(event, { database: config }),
    listEvents: listOptions => listDatabaseEvents({ ...(listOptions || {}), database: config }),
  };
}

function getDatabaseStatus(options = {}) {
  const config = options.version ? options : loadDatabaseConfig(options.database || options);
  return {
    ...getDatabaseConfigSummary(config),
    engineVersion: DATABASE_ENGINE_VERSION,
    supported: config.provider === DATABASE_PROVIDERS.JSONL || config.provider === DATABASE_PROVIDERS.DISABLED,
    records: config.provider === DATABASE_PROVIDERS.JSONL ? readWorldSaveRecords(config.worldsFile).length : 0,
    events: config.provider === DATABASE_PROVIDERS.JSONL ? readJsonLines(config.eventsFile).length : 0,
  };
}

function saveWorldToDatabase(world, options = {}) {
  if (!world) throw new Error('saveWorldToDatabase requires world');
  const config = loadDatabaseConfig(options.database || options);
  if (config.provider === DATABASE_PROVIDERS.DISABLED) return disabledResult('saveWorld');
  assertJsonlProvider(config);
  const records = readWorldSaveRecords(config.worldsFile);
  const sequence = (records.length ? records[records.length - 1].sequence : 0) + 1;
  const envelope = createSaveEnvelope(world, { ...(options || {}), reason: options.reason || 'database_save' });
  const record = {
    recordType: 'world_save',
    id: `world_save_${sanitize(envelope.worldId)}_${Number(envelope.tick || 0)}_${sequence}`,
    sequence,
    worldId: envelope.worldId,
    tick: envelope.tick,
    schemaVersion: envelope.schemaVersion,
    savedAt: envelope.savedAt,
    metadata: { ...(envelope.metadata || {}) },
    envelope,
  };
  validateWorldSaveRecord(record);
  ensureDatabaseFiles(config);
  appendJsonLine(config.worldsFile, record);
  writeSchemaFile(config);
  return summarizeWorldRecord(record, config);
}

function loadWorldFromDatabase(worldId = null, options = {}) {
  const config = loadDatabaseConfig(options.database || options);
  if (config.provider === DATABASE_PROVIDERS.DISABLED) return null;
  assertJsonlProvider(config);
  const records = readWorldSaveRecords(config.worldsFile);
  const record = records.slice().reverse().find(item => worldId === null || item.worldId === worldId);
  return record ? restoreWorldSaveRecord(record, config) : null;
}

function restoreWorldSaveRecord(record, config) {
  validateWorldSaveRecord(record);
  // Repair only a detached copy. Reading a save must not mutate a caller's record.
  const migrated = migrateSaveEnvelope(JSON.parse(JSON.stringify(record.envelope)));
  repairLoadedWorld(migrated.world);
  return {
    ...summarizeWorldRecord(record, config),
    metadata: { ...(migrated.metadata || {}) },
    world: migrated.world,
  };
}

function listDatabaseWorlds(options = {}) {
  const config = loadDatabaseConfig(options.database || options);
  if (config.provider === DATABASE_PROVIDERS.DISABLED) return [];
  assertJsonlProvider(config);
  const latest = new Map();
  for (const record of readWorldSaveRecords(config.worldsFile)) latest.set(record.worldId, record);
  return Array.from(latest.values()).sort(compareWorldRecordsDesc).map(record => summarizeWorldRecord(record, config));
}

function readWorldSaveRecords(file) {
  let previousSequence = 0;
  const ids = new Set();
  return readJsonLines(file, record => {
    validateWorldSaveRecord(record);
    if (record.sequence <= previousSequence) throw new Error('world_sequence_not_increasing');
    if (ids.has(record.id)) throw new Error('duplicate_world_record_id');
    previousSequence = record.sequence;
    ids.add(record.id);
  });
}

function validateWorldSaveRecord(record) {
  if (!isObject(record) || record.recordType !== 'world_save') throw new Error('invalid_world_record_type');
  if (typeof record.id !== 'string' || !record.id.trim()) throw new Error('invalid_world_record_id');
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 1) throw new Error('invalid_world_sequence');
  if (typeof record.worldId !== 'string' || !record.worldId.trim()) throw new Error('invalid_world_id');
  if (!Number.isSafeInteger(record.tick) || record.tick < 0) throw new Error('invalid_world_tick');
  if (!Number.isSafeInteger(record.schemaVersion) || record.schemaVersion < 1) throw new Error('invalid_world_schema');
  const envelope = record.envelope;
  if (!isObject(envelope) || !isObject(envelope.world)) throw new Error('invalid_world_envelope');
  if (envelope.schemaVersion !== record.schemaVersion || envelope.worldId !== record.worldId || envelope.tick !== record.tick) {
    throw new Error('world_envelope_header_mismatch');
  }
  if (envelope.world.id !== record.worldId || envelope.world.tick !== record.tick) throw new Error('world_state_header_mismatch');
  if (!isObject(envelope.world.entities) || !isObject(envelope.world.locations)) throw new Error('invalid_world_collections');
  return record;
}

function appendDatabaseEvent(input = {}, options = {}) {
  const config = loadDatabaseConfig(options.database || options);
  if (config.provider === DATABASE_PROVIDERS.DISABLED) return disabledResult('appendEvent');
  assertJsonlProvider(config);
  ensureDatabaseFiles(config);
  const sequence = readJsonLines(config.eventsFile).length + 1;
  const event = {
    recordType: 'world_event',
    id: input.id || `world_event_${sanitize(input.worldId || 'world')}_${Number(input.tick || 0)}_${sequence}`,
    sequence,
    worldId: input.worldId || null,
    tick: Number(input.tick || 0),
    type: input.type || 'event',
    payload: { ...(input.payload || {}) },
    createdAt: input.createdAt || wallClockIso(),
  };
  appendJsonLine(config.eventsFile, event);
  writeSchemaFile(config);
  return event;
}

function listDatabaseEvents(options = {}) {
  const config = loadDatabaseConfig(options.database || options);
  if (config.provider === DATABASE_PROVIDERS.DISABLED) return [];
  assertJsonlProvider(config);
  const limit = Math.max(1, Math.min(1000, Number(options.limit || 100)));
  const order = String(options.order || 'desc').toLowerCase();
  const worldId = options.worldId || null;
  const type = options.type || null;
  const events = readJsonLines(config.eventsFile)
    .filter(event => event.recordType === 'world_event')
    .filter(event => !worldId || event.worldId === worldId)
    .filter(event => !type || event.type === type)
    .sort(compareEventRecordsDesc);
  if (order === 'asc') events.reverse();
  return events.slice(0, limit).map(summarizeEventRecord);
}

function ensureDatabaseFiles(config) {
  if (!config.autoCreate) return;
  for (const file of [config.worldsFile, config.eventsFile]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
  }
}

function writeSchemaFile(config) {
  if (!config.autoCreate) return;
  const schema = {
    version: DATABASE_ENGINE_VERSION,
    provider: config.provider,
    files: { worlds: path.basename(config.worldsFile), events: path.basename(config.eventsFile) },
    records: {
      world_save: ['recordType', 'id', 'sequence', 'worldId', 'tick', 'schemaVersion', 'savedAt', 'metadata', 'envelope'],
      world_event: ['recordType', 'id', 'sequence', 'worldId', 'tick', 'type', 'payload', 'createdAt'],
    },
  };
  fs.mkdirSync(path.dirname(config.schemaFile), { recursive: true });
  fs.writeFileSync(config.schemaFile, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
}

function appendJsonLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function readJsonLines(file, validate = null) {
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const record = JSON.parse(line);
      if (!isObject(record)) throw new Error('record_must_be_object');
      if (validate) validate(record);
      records.push(record);
    } catch (cause) {
      // Do not echo raw JSON: save payloads can contain private world/account data.
      const reason = cause instanceof SyntaxError ? 'invalid_json' : cause.message;
      const error = new Error(`DATABASE_INVALID_RECORD:${path.basename(file)}:line_${index + 1}:${reason}`);
      error.code = 'DATABASE_INVALID_RECORD';
      error.file = file;
      error.line = index + 1;
      throw error;
    }
  });
  return records;
}

function compareWorldRecordsDesc(left, right) {
  // Tick may decrease after a deliberate rollback. Sequence is append order.
  return right.sequence - left.sequence;
}

function compareEventRecordsDesc(left, right) {
  const sequence = Number(right.sequence || 0) - Number(left.sequence || 0);
  if (sequence) return sequence;
  return Number(right.tick || 0) - Number(left.tick || 0);
}

function summarizeWorldRecord(record, config) {
  return {
    file: config.worldsFile,
    provider: config.provider,
    id: record.id,
    sequence: record.sequence,
    worldId: record.worldId,
    tick: record.tick,
    schemaVersion: record.schemaVersion,
    savedAt: record.savedAt,
    metadata: { ...(record.metadata || {}) },
  };
}

function summarizeEventRecord(event) {
  return {
    id: event.id,
    sequence: event.sequence,
    worldId: event.worldId,
    tick: event.tick,
    type: event.type,
    payload: { ...(event.payload || {}) },
    createdAt: event.createdAt || null,
  };
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assertJsonlProvider(config) {
  if (config.provider !== DATABASE_PROVIDERS.JSONL) throw new Error(`Database provider ${config.provider} requires an external adapter`);
}

function disabledResult(operation) {
  return { ok: false, disabled: true, operation };
}

function sanitize(value) {
  return String(value || 'world').replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

module.exports = {
  DATABASE_ENGINE_VERSION,
  createDatabaseStore,
  getDatabaseStatus,
  saveWorldToDatabase,
  loadWorldFromDatabase,
  listDatabaseWorlds,
  appendDatabaseEvent,
  listDatabaseEvents,
  ensureDatabaseFiles,
  readJsonLines,
  readWorldSaveRecords,
  restoreWorldSaveRecord,
  validateWorldSaveRecord,
};
