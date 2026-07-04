'use strict';

const fs = require('fs');
const path = require('path');
const {
  DATABASE_PROVIDERS,
  loadDatabaseConfig,
  getDatabaseConfigSummary,
} = require('./database-config-engine');

const DATABASE_CHECK_REPORT_VERSION = 1;

function buildDatabaseCheckReport(options = {}) {
  const config = loadDatabaseConfig(options.database || options);
  const supported = config.provider === DATABASE_PROVIDERS.JSONL || config.provider === DATABASE_PROVIDERS.DISABLED;
  const worlds = inspectJsonLineFile(config.worldsFile, { expectedRecordType: 'world_save' });
  const events = inspectJsonLineFile(config.eventsFile, { expectedRecordType: 'world_event' });
  const schema = inspectJsonFile(config.schemaFile);
  const warnings = [];
  if (!config.ready) warnings.push('database_not_ready');
  if (!supported) warnings.push('database_provider_requires_adapter');
  if (config.provider === DATABASE_PROVIDERS.JSONL && !worlds.exists) warnings.push('worlds_file_missing');
  if (config.provider === DATABASE_PROVIDERS.JSONL && !events.exists) warnings.push('events_file_missing');
  const errors = [
    ...worlds.parseErrors.map(error => ({ file: 'worlds', ...error })),
    ...events.parseErrors.map(error => ({ file: 'events', ...error })),
    ...schema.parseErrors.map(error => ({ file: 'schema', ...error })),
  ];
  return {
    version: DATABASE_CHECK_REPORT_VERSION,
    config: getDatabaseConfigSummary(config),
    supported,
    ok: supported && errors.length === 0,
    counts: {
      worlds: worlds.records,
      events: events.records,
      schema: schema.exists ? 1 : 0,
      errors: errors.length,
      warnings: warnings.length,
    },
    files: {
      worlds,
      events,
      schema,
    },
    warnings,
    errors,
  };
}

function inspectJsonLineFile(file, options = {}) {
  const expectedRecordType = options.expectedRecordType || null;
  const info = {
    file: file || null,
    exists: Boolean(file && fs.existsSync(file)),
    bytes: 0,
    lines: 0,
    records: 0,
    expectedRecordType,
    recordTypes: {},
    firstSequence: null,
    lastSequence: null,
    minTick: null,
    maxTick: null,
    parseErrors: [],
  };
  if (!info.exists) return info;
  const text = fs.readFileSync(file, 'utf8');
  info.bytes = Buffer.byteLength(text);
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  info.lines = lines.length;
  lines.forEach((line, index) => {
    try {
      const record = JSON.parse(line);
      info.records += 1;
      const type = record.recordType || 'unknown';
      info.recordTypes[type] = (info.recordTypes[type] || 0) + 1;
      const sequence = Number(record.sequence || 0);
      if (Number.isFinite(sequence) && sequence > 0) {
        if (info.firstSequence === null || sequence < info.firstSequence) info.firstSequence = sequence;
        if (info.lastSequence === null || sequence > info.lastSequence) info.lastSequence = sequence;
      }
      const tick = Number(record.tick || 0);
      if (Number.isFinite(tick)) {
        if (info.minTick === null || tick < info.minTick) info.minTick = tick;
        if (info.maxTick === null || tick > info.maxTick) info.maxTick = tick;
      }
      if (expectedRecordType && type !== expectedRecordType) {
        info.parseErrors.push({ line: index + 1, message: `unexpected_record_type:${type}` });
      }
    } catch (error) {
      info.parseErrors.push({ line: index + 1, message: error.message });
    }
  });
  return info;
}

function inspectJsonFile(file) {
  const info = {
    file: file || null,
    exists: Boolean(file && fs.existsSync(file)),
    bytes: 0,
    keys: [],
    parseErrors: [],
  };
  if (!info.exists) return info;
  try {
    const text = fs.readFileSync(file, 'utf8');
    info.bytes = Buffer.byteLength(text);
    const json = JSON.parse(text || '{}');
    info.keys = Object.keys(json).sort();
  } catch (error) {
    info.parseErrors.push({ line: 1, message: error.message });
  }
  return info;
}

function summarizeDatabaseCheckReport(report) {
  return {
    ok: Boolean(report?.ok),
    provider: report?.config?.provider || null,
    records: Number(report?.counts?.worlds || 0),
    events: Number(report?.counts?.events || 0),
    errors: Number(report?.counts?.errors || 0),
    warnings: Number(report?.counts?.warnings || 0),
  };
}

module.exports = {
  DATABASE_CHECK_REPORT_VERSION,
  buildDatabaseCheckReport,
  inspectJsonLineFile,
  inspectJsonFile,
  summarizeDatabaseCheckReport,
};
