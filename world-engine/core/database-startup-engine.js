'use strict';

const { DATABASE_PROVIDERS, loadDatabaseConfig } = require('./database-config-engine');
const { readWorldSaveRecords, restoreWorldSaveRecord } = require('./database-engine');

const DATABASE_STARTUP_MODES = Object.freeze({
  OFF: 'off',
  IF_PRESENT: 'if-present',
  REQUIRED: 'required',
});

function normalizeDatabaseStartupMode(value = 'off') {
  if (typeof value !== 'string') throw startupError('DATABASE_STARTUP_CONFIG', 'mode_must_be_string');
  const mode = value.trim().toLowerCase();
  if (!Object.values(DATABASE_STARTUP_MODES).includes(mode)) {
    throw startupError('DATABASE_STARTUP_CONFIG', 'expected_off_if-present_or_required');
  }
  return mode;
}

/**
 * Read and validate a saved world before the API opens a listener or a timer.
 * No file writes, repair-in-place, fallback to older saves, or simulated ticks.
 * A JSONL store must have one writer; this is not a cross-process locking layer.
 */
function prepareDatabaseStartup(options = {}, env = process.env) {
  const mode = normalizeDatabaseStartupMode(options.mode ?? DATABASE_STARTUP_MODES.OFF);
  const worldId = normalizeWorldId(options.worldId);
  if (mode === DATABASE_STARTUP_MODES.OFF) {
    if (worldId !== null) throw startupError('DATABASE_STARTUP_CONFIG', 'world_id_requires_recovery');
    return result(null, mode, 'off', null);
  }

  const config = loadDatabaseConfig(options.database || {}, env);
  if (config.provider !== DATABASE_PROVIDERS.JSONL) {
    throw startupError('DATABASE_STARTUP_PROVIDER', 'recovery_requires_supported_jsonl_store');
  }

  // Select from one validated read, avoiding a list/load time-of-check gap.
  const records = readWorldSaveRecords(config.worldsFile);
  if (!records.length) {
    if (mode === DATABASE_STARTUP_MODES.REQUIRED || worldId !== null) {
      throw startupError('DATABASE_STARTUP_MISSING', 'no_matching_world_save');
    }
    return result(null, mode, 'new', config.provider);
  }

  const latest = new Map();
  for (const record of records) latest.set(record.worldId, record);
  if (worldId === null && latest.size !== 1) {
    throw startupError('DATABASE_STARTUP_AMBIGUOUS', 'multiple_worlds_specify_resume_world');
  }
  const record = worldId === null ? latest.values().next().value : latest.get(worldId);
  if (!record) throw startupError('DATABASE_STARTUP_MISSING', 'no_matching_world_save');

  const loaded = restoreWorldSaveRecord(record, config);
  return result(loaded, mode, 'restored', config.provider);
}

function result(loaded, mode, status, provider) {
  return {
    world: loaded?.world || null,
    summary: {
      mode,
      status,
      provider,
      worldId: loaded?.worldId ?? null,
      tick: loaded?.tick ?? null,
      sequence: loaded?.sequence ?? null,
    },
  };
}

function normalizeWorldId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw startupError('DATABASE_STARTUP_CONFIG', 'world_id_must_be_nonempty_string');
  }
  return value;
}

function startupError(code, detail) {
  const error = new Error(`${code}:${detail}`);
  error.code = code;
  return error;
}

module.exports = {
  DATABASE_STARTUP_MODES,
  normalizeDatabaseStartupMode,
  prepareDatabaseStartup,
};
