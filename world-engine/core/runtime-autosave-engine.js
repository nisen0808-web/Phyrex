'use strict';

const { saveWorld } = require('./persistence-engine');
const { saveWorldToDatabase } = require('./database-engine');

const RUNTIME_AUTOSAVE_MODE = {
  FILE: 'file',
  DATABASE: 'database',
};

function runRuntimeAutosave(world, options = {}) {
  if (!world) throw new Error('runRuntimeAutosave requires world');
  const mode = resolveRuntimeAutosaveMode(options);
  if (mode === RUNTIME_AUTOSAVE_MODE.DATABASE) {
    const save = saveWorldToDatabase(world, {
      database: options.database || {},
      reason: options.reason || 'runtime_loop_autosave',
      metadata: {
        source: 'runtime_loop',
        ...(options.metadata || {}),
      },
    });
    return { mode, ...save };
  }
  const file = options.path || options.file || options.autosavePath;
  if (!file) return null;
  const save = saveWorld(world, file, {
    ...(options.saveOptions || {}),
    reason: options.reason || 'runtime_loop_autosave',
    metadata: {
      source: 'runtime_loop',
      ...(options.metadata || {}),
      ...(options.saveOptions?.metadata || {}),
    },
  });
  return { mode, ...save };
}

function resolveRuntimeAutosaveMode(options = {}) {
  const requested = options.persistence || options.mode || options.storage || options.autosaveMode;
  if (requested) return normalizeRuntimeAutosaveMode(requested);
  if (hasDatabaseOptions(options.database) || options.useDatabase) return RUNTIME_AUTOSAVE_MODE.DATABASE;
  return RUNTIME_AUTOSAVE_MODE.FILE;
}

function normalizeRuntimeAutosaveMode(value) {
  const mode = String(value || RUNTIME_AUTOSAVE_MODE.FILE).trim().toLowerCase();
  if (mode === 'db') return RUNTIME_AUTOSAVE_MODE.DATABASE;
  if (!Object.values(RUNTIME_AUTOSAVE_MODE).includes(mode)) throw new Error(`Unsupported runtime autosave mode ${mode}`);
  return mode;
}

function hasDatabaseOptions(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(item => item !== undefined && item !== null && item !== '');
}

function summarizeRuntimeAutosave(save) {
  if (!save) return null;
  return {
    mode: save.mode || null,
    provider: save.provider || null,
    file: save.file || null,
    worldId: save.worldId || null,
    tick: save.tick ?? null,
    savedAt: save.savedAt || null,
    sequence: save.sequence || null,
  };
}

module.exports = {
  RUNTIME_AUTOSAVE_MODE,
  runRuntimeAutosave,
  resolveRuntimeAutosaveMode,
  normalizeRuntimeAutosaveMode,
  hasDatabaseOptions,
  summarizeRuntimeAutosave,
};
