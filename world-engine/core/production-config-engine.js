'use strict';

const path = require('path');
const { validatePassword } = require('./password-auth-engine');

const RELEASE_VERSION = '1.0.0';

const DEFAULT_PRODUCTION_CONFIG = Object.freeze({
  environment: 'production',
  host: '0.0.0.0',
  port: 8790,
  dataDirectory: 'world-engine/data',
  savePath: 'world-engine/data/world.json',
  backupDirectory: 'world-engine/data/backups',
  loadOnStart: true,
  requireExistingSave: false,
  requireAuth: true,
  allowRegistration: false,
  requirePasswords: true,
  adminId: 'admin',
  adminName: 'World Administrator',
  adminPassword: null,
  sessionTtlTicks: 10000,
  corsOrigins: [],
  trustProxy: false,
  rateLimitWindowMs: 60000,
  rateLimitMax: 600,
  authRateLimitMax: 30,
  maxBodyBytes: 1024 * 1024,
  metricsPublic: false,
  autoStartLoop: true,
  loopIntervalMs: 1000,
  ticksPerCycle: 1,
  autosaveEveryTicks: 25,
  stopOnLoopError: true,
  shutdownSave: true,
  shutdownTimeoutMs: 10000,
  logFormat: 'json',
  seedTicks: 10,
});

function loadProductionConfig(env = process.env, overrides = {}) {
  const dataDirectory = env.WORLD_DATA_DIR || DEFAULT_PRODUCTION_CONFIG.dataDirectory;
  const config = {
    ...DEFAULT_PRODUCTION_CONFIG,
    environment: env.NODE_ENV || DEFAULT_PRODUCTION_CONFIG.environment,
    host: env.HOST || env.WORLD_HOST || DEFAULT_PRODUCTION_CONFIG.host,
    port: numberValue(env.PORT || env.WORLD_PORT, DEFAULT_PRODUCTION_CONFIG.port, 1, 65535),
    dataDirectory,
    savePath: env.WORLD_SAVE_PATH || path.join(dataDirectory, 'world.json'),
    backupDirectory: env.WORLD_BACKUP_DIR || path.join(dataDirectory, 'backups'),
    loadOnStart: booleanValue(env.WORLD_LOAD_ON_START, DEFAULT_PRODUCTION_CONFIG.loadOnStart),
    requireExistingSave: booleanValue(env.WORLD_REQUIRE_EXISTING_SAVE, DEFAULT_PRODUCTION_CONFIG.requireExistingSave),
    requireAuth: booleanValue(env.WORLD_REQUIRE_AUTH, DEFAULT_PRODUCTION_CONFIG.requireAuth),
    allowRegistration: booleanValue(env.WORLD_ALLOW_REGISTRATION, DEFAULT_PRODUCTION_CONFIG.allowRegistration),
    requirePasswords: booleanValue(env.WORLD_REQUIRE_PASSWORDS, DEFAULT_PRODUCTION_CONFIG.requirePasswords),
    adminId: env.WORLD_ADMIN_ID || DEFAULT_PRODUCTION_CONFIG.adminId,
    adminName: env.WORLD_ADMIN_NAME || DEFAULT_PRODUCTION_CONFIG.adminName,
    adminPassword: env.WORLD_ADMIN_PASSWORD || null,
    sessionTtlTicks: numberValue(env.WORLD_SESSION_TTL_TICKS, DEFAULT_PRODUCTION_CONFIG.sessionTtlTicks, 100, 100000000),
    corsOrigins: parseList(env.WORLD_CORS_ORIGINS),
    trustProxy: booleanValue(env.WORLD_TRUST_PROXY, DEFAULT_PRODUCTION_CONFIG.trustProxy),
    rateLimitWindowMs: numberValue(env.WORLD_RATE_LIMIT_WINDOW_MS, DEFAULT_PRODUCTION_CONFIG.rateLimitWindowMs, 1000, 3600000),
    rateLimitMax: numberValue(env.WORLD_RATE_LIMIT_MAX, DEFAULT_PRODUCTION_CONFIG.rateLimitMax, 1, 1000000),
    authRateLimitMax: numberValue(env.WORLD_AUTH_RATE_LIMIT_MAX, DEFAULT_PRODUCTION_CONFIG.authRateLimitMax, 1, 100000),
    maxBodyBytes: numberValue(env.WORLD_MAX_BODY_BYTES, DEFAULT_PRODUCTION_CONFIG.maxBodyBytes, 1024, 50 * 1024 * 1024),
    metricsPublic: booleanValue(env.WORLD_METRICS_PUBLIC, DEFAULT_PRODUCTION_CONFIG.metricsPublic),
    autoStartLoop: booleanValue(env.WORLD_AUTO_LOOP, DEFAULT_PRODUCTION_CONFIG.autoStartLoop),
    loopIntervalMs: numberValue(env.WORLD_LOOP_INTERVAL_MS, DEFAULT_PRODUCTION_CONFIG.loopIntervalMs, 10, 3600000),
    ticksPerCycle: numberValue(env.WORLD_TICKS_PER_CYCLE, DEFAULT_PRODUCTION_CONFIG.ticksPerCycle, 1, 100000),
    autosaveEveryTicks: numberValue(env.WORLD_AUTOSAVE_EVERY_TICKS, DEFAULT_PRODUCTION_CONFIG.autosaveEveryTicks, 0, 100000000),
    stopOnLoopError: booleanValue(env.WORLD_STOP_ON_LOOP_ERROR, DEFAULT_PRODUCTION_CONFIG.stopOnLoopError),
    shutdownSave: booleanValue(env.WORLD_SHUTDOWN_SAVE, DEFAULT_PRODUCTION_CONFIG.shutdownSave),
    shutdownTimeoutMs: numberValue(env.WORLD_SHUTDOWN_TIMEOUT_MS, DEFAULT_PRODUCTION_CONFIG.shutdownTimeoutMs, 1000, 120000),
    logFormat: env.WORLD_LOG_FORMAT || DEFAULT_PRODUCTION_CONFIG.logFormat,
    seedTicks: numberValue(env.WORLD_SEED_TICKS, DEFAULT_PRODUCTION_CONFIG.seedTicks, 0, 1000000),
    allowInsecure: booleanValue(env.WORLD_ALLOW_INSECURE, false),
    allowWildcardCors: booleanValue(env.WORLD_ALLOW_WILDCARD_CORS, false),
    ...overrides,
  };

  config.dataDirectory = path.resolve(config.dataDirectory);
  config.savePath = path.resolve(config.savePath);
  config.backupDirectory = path.resolve(config.backupDirectory);
  config.corsOrigins = Array.isArray(config.corsOrigins)
    ? [...new Set(config.corsOrigins.map(value => String(value).trim()).filter(Boolean))]
    : parseList(config.corsOrigins);

  const validation = validateProductionConfig(config);
  if (!validation.ok) {
    const error = new Error(`invalid_production_config:${validation.errors.join(',')}`);
    error.code = 'invalid_production_config';
    error.validation = validation;
    throw error;
  }
  return config;
}

function validateProductionConfig(config = {}) {
  const errors = [];
  const warnings = [];
  const production = String(config.environment || '').toLowerCase() === 'production';
  const publicHost = !isLoopbackHost(config.host);

  if (!config.host) errors.push('host_required');
  if (!Number.isInteger(Number(config.port)) || Number(config.port) < 1 || Number(config.port) > 65535) errors.push('invalid_port');
  if (!config.dataDirectory) errors.push('data_directory_required');
  if (!config.savePath) errors.push('save_path_required');
  if (!config.backupDirectory) errors.push('backup_directory_required');
  if (!String(config.adminId || '').match(/^[a-zA-Z0-9_.-]{3,64}$/)) errors.push('invalid_admin_id');
  if (!['json', 'pretty'].includes(String(config.logFormat || ''))) errors.push('invalid_log_format');

  if (production && publicHost && !config.requireAuth && !config.allowInsecure) errors.push('public_host_requires_auth');
  if (production && config.allowRegistration && !config.requirePasswords && !config.allowInsecure) errors.push('public_registration_requires_passwords');
  if (production && config.requirePasswords && !config.adminPassword) errors.push('admin_password_required');
  if (config.adminPassword) {
    const passwordValidation = validatePassword(config.adminPassword);
    if (!passwordValidation.ok) errors.push(...passwordValidation.errors.map(code => `admin_${code}`));
  }
  if ((config.corsOrigins || []).includes('*') && publicHost && !config.allowWildcardCors) errors.push('wildcard_cors_requires_explicit_override');
  if (!(config.corsOrigins || []).length) warnings.push('cors_same_origin_only');
  if (!config.autoStartLoop) warnings.push('runtime_loop_disabled');
  if (!config.shutdownSave) warnings.push('shutdown_save_disabled');
  if (!config.autosaveEveryTicks) warnings.push('runtime_autosave_disabled');

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
  };
}

function redactProductionConfig(config = {}) {
  return {
    releaseVersion: RELEASE_VERSION,
    environment: config.environment,
    host: config.host,
    port: config.port,
    dataDirectory: config.dataDirectory,
    savePath: config.savePath,
    backupDirectory: config.backupDirectory,
    loadOnStart: config.loadOnStart,
    requireExistingSave: config.requireExistingSave,
    requireAuth: config.requireAuth,
    allowRegistration: config.allowRegistration,
    requirePasswords: config.requirePasswords,
    adminId: config.adminId,
    adminPasswordConfigured: Boolean(config.adminPassword),
    sessionTtlTicks: config.sessionTtlTicks,
    corsOrigins: [...(config.corsOrigins || [])],
    trustProxy: config.trustProxy,
    rateLimitWindowMs: config.rateLimitWindowMs,
    rateLimitMax: config.rateLimitMax,
    authRateLimitMax: config.authRateLimitMax,
    maxBodyBytes: config.maxBodyBytes,
    metricsPublic: config.metricsPublic,
    autoStartLoop: config.autoStartLoop,
    loopIntervalMs: config.loopIntervalMs,
    ticksPerCycle: config.ticksPerCycle,
    autosaveEveryTicks: config.autosaveEveryTicks,
    stopOnLoopError: config.stopOnLoopError,
    shutdownSave: config.shutdownSave,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    logFormat: config.logFormat,
    seedTicks: config.seedTicks,
  };
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return Boolean(fallback);
}

function numberValue(value, fallback, min, max) {
  const parsed = Number(value);
  const number = Number.isFinite(parsed) ? parsed : Number(fallback);
  return Math.max(Number(min), Math.min(Number(max), Math.floor(number)));
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase();
  return ['127.0.0.1', 'localhost', '::1'].includes(value);
}

module.exports = {
  RELEASE_VERSION,
  DEFAULT_PRODUCTION_CONFIG,
  loadProductionConfig,
  validateProductionConfig,
  redactProductionConfig,
  booleanValue,
  numberValue,
  parseList,
  isLoopbackHost,
};
