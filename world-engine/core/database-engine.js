'use strict';

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
  return {
    version: DATABASE_ENGINE_VERSION,
    config,
    summary: () => getDatabaseStatus(config),
    saveWorld: (world, saveOptions = {}) => saveWorldToDatabase(world, { ...saveOptions, database: config }),
    loadWorld: (worldId = null, loadOptions = {}) => loadWorldFromDatabase(worldId, { ...loadOptions, database: config }),
    listWorlds: listOptions => listDatabaseWorlds({ ...(listOptions || {}), database: config }),
    appendEvent: event => appendDatabaseEvent(event, { database: config }),
  };
}

function getDatabaseStatus(options = {}) {
  const config = options.version ? options : loadDatabaseConfig(options.database || options);
  return {
    ...getDatabaseConfigSummary(config),
    engineVersion: DATABASE_ENGINE_VERSION,
    supported: config.provider === DATABASE_PROVIDERS.JSONL || config.provider === DATABASE_PROVIDERS.DISABLED,
    records: config.provider === DATABASE_PROVIDERS.JSONL && fs.existsSync(config.worldsFile) ? readJsonLines(config.worldsFile).length : 0,
    events: config.provider === DATABASE_PROVIDERS.JSONL && fs.existsSync(config.eventsFile) ? readJsonLines(config.eventsFile).length : 0,
  };
}

function saveWorldToDatabase(world, options = {}) {
  if (!world) throw new Error('saveWorldToDatabase requires world');
  const config = loadDatabaseConfig(options.database || options);
  if (config.provider === DATABASE_PROVIDERS.DISABLED) return disabledResult('saveWorld');
  assertJsonlProvider(config);
  ensureDatabaseFiles(config);
  const envelope = createSaveEnvelope(world, { ...(options || {}), reason: options.reason || 'database_save' });
  const sequence = readJsonLines(config.worldsFile).length + 1;
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
  appendJsonLine(config.worldsFile, record);
  writeSchemaFile(config);
  return summarizeWorldRecord(record, config);
}

function loadWorldFromDatabase(worldId = null, options = {}) {
  const config = loadDatabaseConfig(options.database || options);
  if (config.provider === DATABASE_PROVIDERS.DISABLED) return null;
  assertJsonlProvider(config);
  const records = readJsonLines(config.worldsFile)
    .filter(record => record.recordType === 'world_save')
    .filter(record => !worldId || record.worldId === worldId)
    .sort(compareWorldRecordsDesc);
  const record = records[0] || null;
  if (!record) return null;
  const migrated = migrateSaveEnvelope(record.envelope);
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
  for (const record of readJsonLines(config.worldsFile).filter(item => item.recordType === 'world_save')) {
    const previous = latest.get(record.worldId);
    if (!previous || compareWorldRecordsDesc(record, previous) < 0) latest.set(record.worldId, record);
  }
  return Array.from(latest.values()).sort(compareWorldRecordsDesc).map(record => summarizeWorldRecord(record, config));
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
  };
  appendJsonLine(config.eventsFile, event);
  writeSchemaFile(config);
  return event;
}

function ensureDatabaseFiles(config) {
  if (!config.autoCreate) return;
  fs.mkdirSync(path.dirname(config.worldsFile), { recursive: true });
  for (const file of [config.worldsFile, config.eventsFile]) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
  }
}

function writeSchemaFile(config) {
  if (!config.autoCreate) return;
  const schema = {
    version: DATABASE_ENGINE_VERSION,
    provider: config.provider,
    files: {
      worlds: path.basename(config.worldsFile),
      events: path.basename(config.eventsFile),
    },
    records: {
      world_save: ['recordType', 'id', 'sequence', 'worldId', 'tick', 'schemaVersion', 'savedAt', 'metadata', 'envelope'],
      world_event: ['recordType', 'id', 'sequence', 'worldId', 'tick', 'type', 'payload'],
    },
  };
  fs.mkdirSync(path.dirname(config.schemaFile), { recursive: true });
  fs.writeFileSync(config.schemaFile, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
}

function appendJsonLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function readJsonLines(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function compareWorldRecordsDesc(left, right) {
  const tick = Number(right.tick || 0) - Number(left.tick || 0);
  if (tick) return tick;
  return Number(right.sequence || 0) - Number(left.sequence || 0);
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

function assertJsonlProvider(config) {
  if (config.provider !== DATABASE_PROVIDERS.JSONL) {
    throw new Error(`Database provider ${config.provider} requires an external adapter`);
  }
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
  ensureDatabaseFiles,
  readJsonLines,
};
