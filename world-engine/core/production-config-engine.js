'use strict';

const path = require('path');

const DEFAULT_PRODUCTION_OPTIONS = {
  enabled: false,
  host: '127.0.0.1',
  port: 8790,
  operatorAccountId: 'operator',
  operatorAccountName: 'World Operator',
  dataDir: 'world-engine/output',
  startupSave: null,
  shutdownSave: 'world-latest.json',
  shutdownTimeoutMs: 10000,
  corsOrigins: ['*'],
  rateLimitWindowMs: 60000,
  rateLimitMax: 300,
  authRateLimitMax: 30,
  metricsPublic: false,
  maintenanceAtStart: false,
  releaseVersion: '0.1.0',
  releaseSha: null,
};

function resolveProductionConfig(input = {}) {
  const args = input.args || {};
  const env = input.env || process.env;
  const cwd = path.resolve(input.cwd || process.cwd());
  const enabled = readBoolean(firstDefined(args.production, env.MUD_PRODUCTION), false);
  const dataDir = path.resolve(cwd, firstDefined(args.dataDir, env.MUD_DATA_DIR, DEFAULT_PRODUCTION_OPTIONS.dataDir));
  const config = {
    enabled,
    host: String(firstDefined(args.host, env.HOST, enabled ? '0.0.0.0' : DEFAULT_PRODUCTION_OPTIONS.host)),
    port: readInteger(firstDefined(args.port, env.PORT), DEFAULT_PRODUCTION_OPTIONS.port, 1, 65535),
    requireAuth: enabled || readBoolean(firstDefined(args.requireAuth, env.MUD_AUTH), false),
    operatorToken: nullableString(firstDefined(args.operatorToken, env.MUD_OPERATOR_TOKEN)),
    operatorAccountId: String(firstDefined(args.operatorAccountId, env.MUD_OPERATOR_ACCOUNT_ID, DEFAULT_PRODUCTION_OPTIONS.operatorAccountId)),
    operatorAccountName: String(firstDefined(args.operatorAccountName, env.MUD_OPERATOR_ACCOUNT_NAME, DEFAULT_PRODUCTION_OPTIONS.operatorAccountName)),
    dataDir,
    startupSave: nullableString(firstDefined(args.loadOnStart, env.MUD_LOAD_ON_START)),
    shutdownSave: String(firstDefined(args.shutdownSave, env.MUD_SHUTDOWN_SAVE, DEFAULT_PRODUCTION_OPTIONS.shutdownSave)),
    shutdownTimeoutMs: readInteger(firstDefined(args.shutdownTimeoutMs, env.MUD_SHUTDOWN_TIMEOUT_MS), DEFAULT_PRODUCTION_OPTIONS.shutdownTimeoutMs, 1000, 120000),
    corsOrigins: parseOrigins(firstDefined(args.corsOrigins, env.MUD_CORS_ORIGINS, enabled ? '' : '*')),
    rateLimitWindowMs: readInteger(firstDefined(args.rateLimitWindowMs, env.MUD_RATE_LIMIT_WINDOW_MS), DEFAULT_PRODUCTION_OPTIONS.rateLimitWindowMs, 1000, 3600000),
    rateLimitMax: readInteger(firstDefined(args.rateLimitMax, env.MUD_RATE_LIMIT_MAX), DEFAULT_PRODUCTION_OPTIONS.rateLimitMax, 1, 100000),
    authRateLimitMax: readInteger(firstDefined(args.authRateLimitMax, env.MUD_AUTH_RATE_LIMIT_MAX), DEFAULT_PRODUCTION_OPTIONS.authRateLimitMax, 1, 100000),
    metricsPublic: readBoolean(firstDefined(args.metricsPublic, env.MUD_METRICS_PUBLIC), DEFAULT_PRODUCTION_OPTIONS.metricsPublic),
    maintenanceAtStart: readBoolean(firstDefined(args.maintenanceAtStart, env.MUD_MAINTENANCE), DEFAULT_PRODUCTION_OPTIONS.maintenanceAtStart),
    releaseVersion: String(firstDefined(args.releaseVersion, env.MUD_RELEASE_VERSION, DEFAULT_PRODUCTION_OPTIONS.releaseVersion)),
    releaseSha: nullableString(firstDefined(args.releaseSha, env.MUD_RELEASE_SHA)),
  };

  config.defaultSavePath = resolveManagedPath(dataDir, firstDefined(args.savePath, env.MUD_DEFAULT_SAVE, 'world.json'));
  config.shutdownSavePath = resolveManagedPath(dataDir, config.shutdownSave);
  config.startupSavePath = config.startupSave ? resolveManagedPath(dataDir, config.startupSave) : null;
  validateProductionConfig(config);
  return config;
}

function validateProductionConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('production_config_required');
  if (config.enabled) {
    const token = String(config.operatorToken || '');
    if (token.length < 32) throw new Error('production_operator_token_must_be_at_least_32_characters');
    if (/^(change-me|replace-me|example|test)/i.test(token)) throw new Error('production_operator_token_is_placeholder');
    if (!config.corsOrigins.length) throw new Error('production_cors_origins_required');
    if (config.corsOrigins.includes('*')) throw new Error('production_cors_wildcard_forbidden');
  }
  if (!config.operatorAccountId.trim()) throw new Error('production_operator_account_id_required');
  if (!path.isAbsolute(config.dataDir)) throw new Error('production_data_dir_must_be_absolute');
  for (const origin of config.corsOrigins) validateOrigin(origin);
  return config;
}

function resolveManagedPath(rootDirectory, requestedPath, options = {}) {
  const root = path.resolve(rootDirectory);
  const requested = String(requestedPath || options.fallback || '').trim();
  if (!requested) throw new Error('managed_path_required');
  const candidates = [];
  if (path.isAbsolute(requested)) candidates.push(path.resolve(requested));
  else {
    candidates.push(path.resolve(process.cwd(), requested));
    candidates.push(path.resolve(root, requested));
  }
  const resolved = candidates.find(candidate => isPathInside(root, candidate));
  if (!resolved) throw new Error('managed_path_outside_data_dir');
  if (options.extension && path.extname(resolved).toLowerCase() !== String(options.extension).toLowerCase()) {
    throw new Error(`managed_path_requires_${String(options.extension).replace(/^\./, '')}`);
  }
  return resolved;
}

function isPathInside(rootDirectory, targetPath) {
  const root = path.resolve(rootDirectory);
  const target = path.resolve(targetPath);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function redactProductionConfig(config) {
  return {
    ...config,
    operatorToken: config.operatorToken ? '[redacted]' : null,
  };
}

function parseOrigins(value) {
  if (Array.isArray(value)) return uniqueStrings(value);
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return [];
  return uniqueStrings(text.split(',').map(item => item.trim()).filter(Boolean));
}

function validateOrigin(origin) {
  if (origin === '*') return origin;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch (_error) {
    throw new Error(`invalid_cors_origin:${origin}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`invalid_cors_origin_protocol:${origin}`);
  if (parsed.origin !== origin.replace(/\/$/, '')) throw new Error(`cors_origin_must_not_include_path:${origin}`);
  return origin;
}

function readBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function readInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  const number = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function nullableString(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function uniqueStrings(values) {
  return [...new Set((values || []).map(value => String(value).trim()).filter(Boolean))];
}

module.exports = {
  DEFAULT_PRODUCTION_OPTIONS,
  resolveProductionConfig,
  validateProductionConfig,
  resolveManagedPath,
  isPathInside,
  redactProductionConfig,
  parseOrigins,
  validateOrigin,
  readBoolean,
  readInteger,
};
