'use strict';

const path = require('path');

const DATABASE_CONFIG_VERSION = 1;
const DATABASE_PROVIDERS = {
  DISABLED: 'disabled',
  JSONL: 'jsonl',
  SQLITE: 'sqlite',
  POSTGRES: 'postgres',
};

const DEFAULT_DATABASE_CONFIG = {
  provider: DATABASE_PROVIDERS.JSONL,
  directory: path.join('world-engine', 'data', 'db'),
  name: 'world-engine',
  worldsFile: null,
  eventsFile: null,
  connectionString: null,
  autoCreate: true,
};

function loadDatabaseConfig(input = {}, env = process.env) {
  const provider = normalizeProvider(input.provider || env.WORLD_ENGINE_DB_PROVIDER || DEFAULT_DATABASE_CONFIG.provider);
  const directory = input.directory || env.WORLD_ENGINE_DB_DIR || DEFAULT_DATABASE_CONFIG.directory;
  const name = sanitizeName(input.name || env.WORLD_ENGINE_DB_NAME || DEFAULT_DATABASE_CONFIG.name);
  const config = {
    version: DATABASE_CONFIG_VERSION,
    provider,
    directory: path.resolve(directory),
    name,
    connectionString: input.connectionString || env.WORLD_ENGINE_DATABASE_URL || env.DATABASE_URL || DEFAULT_DATABASE_CONFIG.connectionString,
    autoCreate: normalizeBoolean(input.autoCreate ?? env.WORLD_ENGINE_DB_AUTO_CREATE, DEFAULT_DATABASE_CONFIG.autoCreate),
  };
  const paths = resolveDatabasePaths(config, input);
  return { ...config, ...paths, ready: provider !== DATABASE_PROVIDERS.DISABLED };
}

function resolveDatabasePaths(config, input = {}) {
  const base = path.resolve(config.directory || DEFAULT_DATABASE_CONFIG.directory);
  const name = sanitizeName(config.name || DEFAULT_DATABASE_CONFIG.name);
  return {
    worldsFile: path.resolve(input.worldsFile || path.join(base, `${name}-worlds.jsonl`)),
    eventsFile: path.resolve(input.eventsFile || path.join(base, `${name}-events.jsonl`)),
    schemaFile: path.resolve(input.schemaFile || path.join(base, `${name}-schema.json`)),
  };
}

function normalizeProvider(value) {
  const provider = String(value || DEFAULT_DATABASE_CONFIG.provider).trim().toLowerCase();
  if (!Object.values(DATABASE_PROVIDERS).includes(provider)) {
    throw new Error(`Unsupported database provider ${provider}`);
  }
  return provider;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return Boolean(fallback);
}

function sanitizeName(value) {
  return String(value || DEFAULT_DATABASE_CONFIG.name).replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function getDatabaseConfigSummary(config) {
  const loaded = config?.version === DATABASE_CONFIG_VERSION ? config : loadDatabaseConfig(config || {});
  return {
    version: loaded.version,
    provider: loaded.provider,
    ready: loaded.ready,
    directory: loaded.directory,
    name: loaded.name,
    worldsFile: loaded.worldsFile,
    eventsFile: loaded.eventsFile,
    schemaFile: loaded.schemaFile,
    hasConnectionString: Boolean(loaded.connectionString),
    autoCreate: loaded.autoCreate,
  };
}

module.exports = {
  DATABASE_CONFIG_VERSION,
  DATABASE_PROVIDERS,
  DEFAULT_DATABASE_CONFIG,
  loadDatabaseConfig,
  resolveDatabasePaths,
  normalizeProvider,
  normalizeBoolean,
  sanitizeName,
  getDatabaseConfigSummary,
};
