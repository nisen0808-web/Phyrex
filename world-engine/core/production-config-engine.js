'use strict';

const path = require('path');

const REGISTRATION_POLICIES = new Set(['disabled', 'admin', 'open']);

function loadProductionConfig(env = process.env, cwd = process.cwd()) {
  const dataDir = path.resolve(cwd, env.MUD_DATA_DIR || 'world-engine/data');
  const worldFile = resolveWithin(dataDir, env.MUD_WORLD_FILE || 'world.json');
  const registrationPolicy = String(env.MUD_REGISTRATION_POLICY || 'admin').toLowerCase();
  if (!REGISTRATION_POLICIES.has(registrationPolicy)) {
    throw configError(`invalid_registration_policy:${registrationPolicy}`);
  }

  const config = {
    environment: String(env.NODE_ENV || 'production'),
    serviceName: String(env.MUD_SERVICE_NAME || 'phyrex-world-engine'),
    host: String(env.HOST || env.MUD_HOST || '0.0.0.0'),
    port: integer(env.PORT || env.MUD_PORT, 8790, 1, 65535, 'port'),
    dataDir,
    worldFile,
    templateId: String(env.MUD_TEMPLATE_ID || 'cultivation_frontier'),
    seedTicks: integer(env.MUD_SEED_TICKS, 10, 0, 100000, 'seed_ticks'),
    requireAuth: boolean(env.MUD_REQUIRE_AUTH, true),
    requireCredentials: boolean(env.MUD_REQUIRE_CREDENTIALS, true),
    registrationPolicy,
    adminId: accountId(env.MUD_ADMIN_ID || 'admin'),
    adminName: String(env.MUD_ADMIN_NAME || 'World Administrator').slice(0, 120),
    adminSecret: env.MUD_ADMIN_SECRET ? String(env.MUD_ADMIN_SECRET) : null,
    rotateAdminSecret: boolean(env.MUD_ROTATE_ADMIN_SECRET, false),
    sessionTtlTicks: integer(env.MUD_SESSION_TTL_TICKS, 100000, 1, 1000000000, 'session_ttl_ticks'),
    maxBodyBytes: integer(env.MUD_MAX_BODY_BYTES, 256 * 1024, 1024, 16 * 1024 * 1024, 'max_body_bytes'),
    corsOrigins: csv(env.MUD_CORS_ORIGINS),
    trustProxy: boolean(env.MUD_TRUST_PROXY, false),
    shutdownSave: boolean(env.MUD_SHUTDOWN_SAVE, true),
    shutdownTimeoutMs: integer(env.MUD_SHUTDOWN_TIMEOUT_MS, 10000, 1000, 120000, 'shutdown_timeout_ms'),
    autoStartLoop: boolean(env.MUD_AUTO_LOOP, true),
    runtimeLoop: {
      intervalMs: integer(env.MUD_LOOP_INTERVAL_MS, 1000, 10, 86400000, 'loop_interval_ms'),
      ticksPerCycle: integer(env.MUD_TICKS_PER_CYCLE, 1, 1, 100000, 'ticks_per_cycle'),
      autosaveEveryTicks: integer(env.MUD_AUTOSAVE_EVERY_TICKS, 25, 0, 1000000000, 'autosave_every_ticks'),
      autosavePath: resolveWithin(dataDir, env.MUD_AUTOSAVE_FILE || 'autosave/world.json'),
      immediate: boolean(env.MUD_LOOP_IMMEDIATE, false),
      stopOnError: boolean(env.MUD_STOP_ON_ERROR, true),
    },
    rateLimit: {
      windowMs: integer(env.MUD_RATE_WINDOW_MS, 60000, 1000, 3600000, 'rate_window_ms'),
      generalMax: integer(env.MUD_RATE_GENERAL_MAX, 600, 1, 100000, 'rate_general_max'),
      authMax: integer(env.MUD_RATE_AUTH_MAX, 20, 1, 10000, 'rate_auth_max'),
      registrationMax: integer(env.MUD_RATE_REGISTRATION_MAX, 5, 1, 10000, 'rate_registration_max'),
    },
  };

  validateProductionConfig(config);
  return config;
}

function validateProductionConfig(config) {
  if (!config.requireAuth) throw configError('production_auth_required');
  if (!config.requireCredentials) throw configError('production_credentials_required');
  assertWithin(config.dataDir, config.worldFile, 'world_file_outside_data_dir');
  assertWithin(config.dataDir, config.runtimeLoop.autosavePath, 'autosave_file_outside_data_dir');
  if (config.adminSecret && config.adminSecret.length < 12) throw configError('admin_secret_too_short');
  if (config.adminSecret && config.adminSecret.length > 256) throw configError('admin_secret_too_long');
  return config;
}

function redactProductionConfig(config) {
  return {
    ...config,
    adminSecret: config.adminSecret ? '[configured]' : null,
  };
}

function resolveWithin(root, value) {
  const candidate = path.isAbsolute(String(value || ''))
    ? path.resolve(String(value))
    : path.resolve(root, String(value || ''));
  assertWithin(root, candidate, 'path_outside_data_dir');
  return candidate;
}

function assertWithin(root, candidate, message) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  const relative = path.relative(absoluteRoot, absoluteCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw configError(message);
  return absoluteCandidate;
}

function boolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw configError(`invalid_boolean:${value}`);
}

function integer(value, fallback, min, max, name) {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw configError(`invalid_${name}:${value}`);
  }
  return parsed;
}

function csv(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function accountId(value) {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(id)) throw configError(`invalid_admin_id:${id}`);
  return id;
}

function configError(message) {
  const error = new Error(message);
  error.code = message;
  return error;
}

module.exports = {
  REGISTRATION_POLICIES,
  loadProductionConfig,
  validateProductionConfig,
  redactProductionConfig,
  resolveWithin,
  assertWithin,
  boolean,
  integer,
  csv,
};
