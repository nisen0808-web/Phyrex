'use strict';

const { saveWorld, loadWorld, listSaves } = require('./persistence-engine');
const {
  saveWorldToDatabase,
  loadWorldFromDatabase,
  listDatabaseWorlds,
  getDatabaseStatus,
} = require('./database-engine');

const API_PERSISTENCE_MODE = {
  FILE: 'file',
  DATABASE: 'database',
};

function saveWorldForApi(world, request = {}, options = {}) {
  const mode = resolvePersistenceMode(request, options);
  if (mode === API_PERSISTENCE_MODE.DATABASE) {
    return {
      mode,
      save: saveWorldToDatabase(world, {
        database: resolveDatabaseOptions(request, options),
        reason: request.reason || request.options?.reason || 'api_database_save',
        metadata: request.metadata || request.options?.metadata || {},
      }),
    };
  }
  const filePath = request.filePath || request.path || options.defaultSavePath;
  return {
    mode,
    save: saveWorld(world, filePath, request.options || {}),
  };
}

function loadWorldForApi(request = {}, options = {}) {
  const mode = resolvePersistenceMode(request, options);
  if (mode === API_PERSISTENCE_MODE.DATABASE) {
    return {
      mode,
      loaded: loadWorldFromDatabase(request.worldId || null, {
        database: resolveDatabaseOptions(request, options),
      }),
    };
  }
  const filePath = request.filePath || request.path || options.defaultSavePath;
  return {
    mode,
    loaded: loadWorld(filePath, request.options || {}),
  };
}

function listWorldSavesForApi(request = {}, options = {}) {
  const mode = resolvePersistenceMode(request, options);
  if (mode === API_PERSISTENCE_MODE.DATABASE) {
    return {
      mode,
      saves: listDatabaseWorlds({ database: resolveDatabaseOptions(request, options) }),
      database: getDatabaseStatus(resolveDatabaseOptions(request, options)),
    };
  }
  return {
    mode,
    saves: listSaves(request.dir || options.saveDirectory || undefined),
  };
}

function getApiPersistenceStatus(request = {}, options = {}) {
  const mode = resolvePersistenceMode(request, options);
  if (mode !== API_PERSISTENCE_MODE.DATABASE) return { mode, database: null };
  return { mode, database: getDatabaseStatus(resolveDatabaseOptions(request, options)) };
}

function resolvePersistenceMode(request = {}, options = {}) {
  const requested = request.persistence || request.mode || request.storage || options.persistence || options.persistenceMode;
  if (requested) return normalizePersistenceMode(requested);
  if (request.database || request.useDatabase || options.database?.enabled || options.useDatabase) return API_PERSISTENCE_MODE.DATABASE;
  return API_PERSISTENCE_MODE.FILE;
}

function resolveDatabaseOptions(request = {}, options = {}) {
  return request.database || options.database || {};
}

function normalizePersistenceMode(value) {
  const mode = String(value || API_PERSISTENCE_MODE.FILE).trim().toLowerCase();
  if (mode === 'db') return API_PERSISTENCE_MODE.DATABASE;
  if (!Object.values(API_PERSISTENCE_MODE).includes(mode)) throw new Error(`Unsupported API persistence mode ${mode}`);
  return mode;
}

module.exports = {
  API_PERSISTENCE_MODE,
  saveWorldForApi,
  loadWorldForApi,
  listWorldSavesForApi,
  getApiPersistenceStatus,
  resolvePersistenceMode,
  resolveDatabaseOptions,
  normalizePersistenceMode,
};
