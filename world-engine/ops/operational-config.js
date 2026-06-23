'use strict';

const path = require('path');

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

const DEFAULT_OPERATIONAL_CONFIG = Object.freeze({
  serviceName: 'phyrex-world-engine',
  host: '0.0.0.0',
  port: 8790,
  dataDir: 'world-engine/data',
  requireAuth: true,
  lockOnboarding: true,
  bootstrapAdmin: true,
  adminAccountId: 'admin',
  adminAccountName: 'Phyrex Administrator',
  adminSessionTtlTicks: 0,
  initialTemplateId: 'cultivation_frontier',
  initialWorldId: '',
  seedTicks: 10,
  autoStartLoop: true,
  intervalMs: 1000,
  ticksPerCycle: 1,
  autosaveEveryTicks: 25,
  stopOnError: true,
  shutdownTimeoutMs: 10000,
  maxBackups: 10,
  recoverFromBackup: true,
  backupOnShutdown: true,
  corsOrigins: ['same-origin'],
  rateLimitPerMinute: 600,
  metricsRequireAuth: true,
  trustProxy: false,
  logLevel: 'info',
});

class OperationalConfigError extends Error {
  constructor(errors, warnings = []) {
    super(`Invalid operational configuration: ${errors.join('; ')}`);
    this.name = 'OperationalConfigError';
    this.errors = errors;
    this.warnings = warnings;
  }
}

function loadOperationalConfig(input = {}) {
  const env = input.env || process.env;
  const argv = input.argv || [];
  const cwd = path.resolve(input.cwd || process.cwd());
  const args = parseOperationalArgs(argv);
  const overrides = input.overrides || {};

  const dataDir = resolveFromCwd(
    pick(overrides.dataDir, args.dataDir, env.PHYREX_DATA_DIR, DEFAULT_OPERATIONAL_CONFIG.dataDir),
    cwd,
  );
  const worldFile = resolveFromCwd(
    pick(overrides.worldFile, args.worldFile, env.PHYREX_WORLD_FILE, path.join(dataDir, 'world.json')),
    cwd,
  );
  const backupDir = resolveFromCwd(
    pick(overrides.backupDir, args.backupDir, env.PHYREX_BACKUP_DIR, path.join(dataDir, 'backups')),
    cwd,
  );
  const adminTokenFile = resolveFromCwd(
    pick(overrides.adminTokenFile, args.adminTokenFile, env.PHYREX_ADMIN_TOKEN_FILE, path.join(dataDir, 'admin-token.txt')),
    cwd,
  );

  const config = {
    serviceName: String(pick(overrides.serviceName, env.PHYREX_SERVICE_NAME, DEFAULT_OPERATIONAL_CONFIG.serviceName)),
    host: String(pick(overrides.host, args.host, env.PHYREX_HOST, DEFAULT_OPERATIONAL_CONFIG.host)),
    port: parseInteger(pick(overrides.port, args.port, env.PHYREX_PORT, DEFAULT_OPERATIONAL_CONFIG.port), 'port'),
    publicUrl: nullableString(pick(overrides.publicUrl, args.publicUrl, env.PHYREX_PUBLIC_URL, null)),
    dataDir,
    worldFile,
    backupDir,
    adminTokenFile,
    adminToken: nullableString(pick(overrides.adminToken, env.PHYREX_ADMIN_TOKEN, null)),
    requireAuth: parseBoolean(pick(overrides.requireAuth, args.requireAuth, env.PHYREX_REQUIRE_AUTH, DEFAULT_OPERATIONAL_CONFIG.requireAuth)),
    lockOnboarding: parseBoolean(pick(
      overrides.lockOnboarding,
      args.lockOnboarding,
      env.PHYREX_LOCK_ONBOARDING,
      DEFAULT_OPERATIONAL_CONFIG.lockOnboarding,
    )),
    bootstrapAdmin: parseBoolean(pick(
      overrides.bootstrapAdmin,
      args.bootstrapAdmin,
      env.PHYREX_BOOTSTRAP_ADMIN,
      DEFAULT_OPERATIONAL_CONFIG.bootstrapAdmin,
    )),
    adminAccountId: String(pick(
      overrides.adminAccountId,
      args.adminAccountId,
      env.PHYREX_ADMIN_ACCOUNT_ID,
      DEFAULT_OPERATIONAL_CONFIG.adminAccountId,
    )),
    adminAccountName: String(pick(
      overrides.adminAccountName,
      args.adminAccountName,
      env.PHYREX_ADMIN_ACCOUNT_NAME,
      DEFAULT_OPERATIONAL_CONFIG.adminAccountName,
    )),
    adminSessionTtlTicks: parseInteger(pick(
      overrides.adminSessionTtlTicks,
      args.adminSessionTtlTicks,
      env.PHYREX_ADMIN_SESSION_TTL_TICKS,
      DEFAULT_OPERATIONAL_CONFIG.adminSessionTtlTicks,
    ), 'adminSessionTtlTicks'),
    initialTemplateId: String(pick(
      overrides.initialTemplateId,
      args.initialTemplateId,
      env.PHYREX_INITIAL_TEMPLATE,
      DEFAULT_OPERATIONAL_CONFIG.initialTemplateId,
    )),
    initialWorldId: nullableString(pick(
      overrides.initialWorldId,
      args.initialWorldId,
      env.PHYREX_INITIAL_WORLD_ID,
      DEFAULT_OPERATIONAL_CONFIG.initialWorldId,
    )),
    seedTicks: parseInteger(pick(
      overrides.seedTicks,
      args.seedTicks,
      env.PHYREX_SEED_TICKS,
      DEFAULT_OPERATIONAL_CONFIG.seedTicks,
    ), 'seedTicks'),
    autoStartLoop: parseBoolean(pick(
      overrides.autoStartLoop,
      args.autoStartLoop,
      env.PHYREX_AUTO_LOOP,
      DEFAULT_OPERATIONAL_CONFIG.autoStartLoop,
    )),
    intervalMs: parseInteger(pick(
      overrides.intervalMs,
      args.intervalMs,
      env.PHYREX_LOOP_INTERVAL_MS,
      DEFAULT_OPERATIONAL_CONFIG.intervalMs,
    ), 'intervalMs'),
    ticksPerCycle: parseInteger(pick(
      overrides.ticksPerCycle,
      args.ticksPerCycle,
      env.PHYREX_TICKS_PER_CYCLE,
      DEFAULT_OPERATIONAL_CONFIG.ticksPerCycle,
    ), 'ticksPerCycle'),
    autosaveEveryTicks: parseInteger(pick(
      overrides.autosaveEveryTicks,
      args.autosaveEveryTicks,
      env.PHYREX_AUTOSAVE_EVERY_TICKS,
      DEFAULT_OPERATIONAL_CONFIG.autosaveEveryTicks,
    ), 'autosaveEveryTicks'),
    autosavePath: resolveFromCwd(
      pick(overrides.autosavePath, args.autosavePath, env.PHYREX_AUTOSAVE_PATH, worldFile),
      cwd,
    ),
    stopOnError: parseBoolean(pick(
      overrides.stopOnError,
      args.stopOnError,
      env.PHYREX_STOP_ON_ERROR,
      DEFAULT_OPERATIONAL_CONFIG.stopOnError,
    )),
    shutdownTimeoutMs: parseInteger(pick(
      overrides.shutdownTimeoutMs,
      args.shutdownTimeoutMs,
      env.PHYREX_SHUTDOWN_TIMEOUT_MS,
      DEFAULT_OPERATIONAL_CONFIG.shutdownTimeoutMs,
    ), 'shutdownTimeoutMs'),
    maxBackups: parseInteger(pick(
      overrides.maxBackups,
      args.maxBackups,
      env.PHYREX_MAX_BACKUPS,
      DEFAULT_OPERATIONAL_CONFIG.maxBackups,
    ), 'maxBackups'),
    recoverFromBackup: parseBoolean(pick(
      overrides.recoverFromBackup,
      args.recoverFromBackup,
      env.PHYREX_RECOVER_FROM_BACKUP,
      DEFAULT_OPERATIONAL_CONFIG.recoverFromBackup,
    )),
    backupOnShutdown: parseBoolean(pick(
      overrides.backupOnShutdown,
      args.backupOnShutdown,
      env.PHYREX_BACKUP_ON_SHUTDOWN,
      DEFAULT_OPERATIONAL_CONFIG.backupOnShutdown,
    )),
    corsOrigins: parseList(pick(
      overrides.corsOrigins,
      args.corsOrigins,
      env.PHYREX_CORS_ORIGINS,
      DEFAULT_OPERATIONAL_CONFIG.corsOrigins,
    )),
    rateLimitPerMinute: parseInteger(pick(
      overrides.rateLimitPerMinute,
      args.rateLimitPerMinute,
      env.PHYREX_RATE_LIMIT_PER_MINUTE,
      DEFAULT_OPERATIONAL_CONFIG.rateLimitPerMinute,
    ), 'rateLimitPerMinute'),
    metricsRequireAuth: parseBoolean(pick(
      overrides.metricsRequireAuth,
      args.metricsRequireAuth,
      env.PHYREX_METRICS_REQUIRE_AUTH,
      DEFAULT_OPERATIONAL_CONFIG.metricsRequireAuth,
    )),
    trustProxy: parseBoolean(pick(
      overrides.trustProxy,
      args.trustProxy,
      env.PHYREX_TRUST_PROXY,
      DEFAULT_OPERATIONAL_CONFIG.trustProxy,
    )),
    logLevel: String(pick(overrides.logLevel, args.logLevel, env.PHYREX_LOG_LEVEL, DEFAULT_OPERATIONAL_CONFIG.logLevel)).toLowerCase(),
    buildSha: nullableString(pick(overrides.buildSha, env.PHYREX_BUILD_SHA, null)),
    buildDate: nullableString(pick(overrides.buildDate, env.PHYREX_BUILD_DATE, null)),
    checkOnly: Boolean(args.checkOnly || overrides.checkOnly),
    printConfig: Boolean(args.printConfig || overrides.printConfig),
    help: Boolean(args.help || overrides.help),
    cwd,
  };

  const validation = validateOperationalConfig(config);
  config.warnings = validation.warnings;
  if (validation.errors.length) throw new OperationalConfigError(validation.errors, validation.warnings);
  return config;
}

function validateOperationalConfig(config) {
  const errors = [];
  const warnings = [];
  if (!config.host) errors.push('host is required');
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) errors.push('port must be between 0 and 65535');
  if (!path.isAbsolute(config.dataDir)) errors.push('dataDir must be absolute');
  if (!path.isAbsolute(config.worldFile)) errors.push('worldFile must be absolute');
  if (!path.isAbsolute(config.backupDir)) errors.push('backupDir must be absolute');
  if (!path.isAbsolute(config.adminTokenFile)) errors.push('adminTokenFile must be absolute');
  if (!config.initialTemplateId) errors.push('initialTemplateId is required');
  if (config.seedTicks < 0) errors.push('seedTicks must be >= 0');
  if (config.intervalMs < 10) errors.push('intervalMs must be >= 10');
  if (config.ticksPerCycle < 1) errors.push('ticksPerCycle must be >= 1');
  if (config.autosaveEveryTicks < 0) errors.push('autosaveEveryTicks must be >= 0');
  if (config.shutdownTimeoutMs < 100) errors.push('shutdownTimeoutMs must be >= 100');
  if (config.maxBackups < 1) errors.push('maxBackups must be >= 1');
  if (config.rateLimitPerMinute < 0) errors.push('rateLimitPerMinute must be >= 0');
  if (!LOG_LEVELS.includes(config.logLevel)) errors.push(`logLevel must be one of ${LOG_LEVELS.join(', ')}`);
  if (!config.corsOrigins.length) warnings.push('no CORS origins configured; cross-origin browser requests will be rejected');
  if (!config.requireAuth) warnings.push('authentication is disabled');
  if (!config.lockOnboarding) warnings.push('public account/session onboarding is enabled');
  if (config.requireAuth && !config.bootstrapAdmin) {
    warnings.push('admin bootstrap is disabled; an existing valid administrator session is required');
  }
  if (config.corsOrigins.includes('*')) warnings.push('CORS wildcard is enabled');
  if (config.rateLimitPerMinute === 0) warnings.push('request rate limiting is disabled');
  return { errors, warnings };
}

function publicOperationalConfig(config) {
  return {
    serviceName: config.serviceName,
    host: config.host,
    port: config.port,
    publicUrl: config.publicUrl,
    dataDir: config.dataDir,
    worldFile: config.worldFile,
    backupDir: config.backupDir,
    adminTokenFile: config.adminTokenFile,
    requireAuth: config.requireAuth,
    lockOnboarding: config.lockOnboarding,
    bootstrapAdmin: config.bootstrapAdmin,
    adminAccountId: config.adminAccountId,
    adminSessionTtlTicks: config.adminSessionTtlTicks,
    initialTemplateId: config.initialTemplateId,
    initialWorldId: config.initialWorldId,
    seedTicks: config.seedTicks,
    autoStartLoop: config.autoStartLoop,
    intervalMs: config.intervalMs,
    ticksPerCycle: config.ticksPerCycle,
    autosaveEveryTicks: config.autosaveEveryTicks,
    autosavePath: config.autosavePath,
    stopOnError: config.stopOnError,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    maxBackups: config.maxBackups,
    recoverFromBackup: config.recoverFromBackup,
    backupOnShutdown: config.backupOnShutdown,
    corsOrigins: [...config.corsOrigins],
    rateLimitPerMinute: config.rateLimitPerMinute,
    metricsRequireAuth: config.metricsRequireAuth,
    trustProxy: config.trustProxy,
    logLevel: config.logLevel,
    buildSha: config.buildSha,
    buildDate: config.buildDate,
    warnings: [...(config.warnings || [])],
  };
}

function parseOperationalArgs(argv = []) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--host') out.host = next();
    else if (arg === '--port') out.port = next();
    else if (arg === '--public-url') out.publicUrl = next();
    else if (arg === '--data-dir') out.dataDir = next();
    else if (arg === '--world-file') out.worldFile = next();
    else if (arg === '--backup-dir') out.backupDir = next();
    else if (arg === '--admin-token-file') out.adminTokenFile = next();
    else if (arg === '--admin-id') out.adminAccountId = next();
    else if (arg === '--admin-name') out.adminAccountName = next();
    else if (arg === '--admin-ttl') out.adminSessionTtlTicks = next();
    else if (arg === '--template') out.initialTemplateId = next();
    else if (arg === '--world-id') out.initialWorldId = next();
    else if (arg === '--seed-ticks') out.seedTicks = next();
    else if (arg === '--interval') out.intervalMs = next();
    else if (arg === '--ticks-per-cycle') out.ticksPerCycle = next();
    else if (arg === '--autosave-every') out.autosaveEveryTicks = next();
    else if (arg === '--autosave-path') out.autosavePath = next();
    else if (arg === '--shutdown-timeout') out.shutdownTimeoutMs = next();
    else if (arg === '--max-backups') out.maxBackups = next();
    else if (arg === '--cors-origins') out.corsOrigins = next();
    else if (arg === '--rate-limit') out.rateLimitPerMinute = next();
    else if (arg === '--log-level') out.logLevel = next();
    else if (arg === '--auth') out.requireAuth = true;
    else if (arg === '--no-auth') out.requireAuth = false;
    else if (arg === '--lock-onboarding') out.lockOnboarding = true;
    else if (arg === '--allow-onboarding') out.lockOnboarding = false;
    else if (arg === '--bootstrap-admin') out.bootstrapAdmin = true;
    else if (arg === '--no-bootstrap-admin') out.bootstrapAdmin = false;
    else if (arg === '--auto-loop') out.autoStartLoop = true;
    else if (arg === '--no-auto-loop') out.autoStartLoop = false;
    else if (arg === '--stop-on-error') out.stopOnError = true;
    else if (arg === '--continue-on-error') out.stopOnError = false;
    else if (arg === '--recover') out.recoverFromBackup = true;
    else if (arg === '--no-recover') out.recoverFromBackup = false;
    else if (arg === '--backup-on-shutdown') out.backupOnShutdown = true;
    else if (arg === '--no-backup-on-shutdown') out.backupOnShutdown = false;
    else if (arg === '--metrics-auth') out.metricsRequireAuth = true;
    else if (arg === '--public-metrics') out.metricsRequireAuth = false;
    else if (arg === '--trust-proxy') out.trustProxy = true;
    else if (arg === '--check') out.checkOnly = true;
    else if (arg === '--print-config') out.printConfig = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new OperationalConfigError([`unknown argument ${arg}`]);
  }
  return out;
}

function operationalUsage() {
  return [
    'Usage: node world-engine/ops/production-server.js [options]',
    '',
    'Core options:',
    '  --host <host>                    Listen host (default 0.0.0.0)',
    '  --port <port>                    Listen port (default 8790)',
    '  --data-dir <path>                Persistent data directory',
    '  --world-file <path>              Primary world save file',
    '  --backup-dir <path>              Timestamped backup directory',
    '  --template <id>                  Initial world template',
    '  --seed-ticks <n>                 Initial template simulation ticks',
    '  --auth / --no-auth               Require bearer sessions',
    '  --lock-onboarding                Require admin for account/session creation',
    '  --allow-onboarding               Permit public account/session creation',
    '  --bootstrap-admin                Create/reuse admin token file',
    '  --no-bootstrap-admin             Disable admin bootstrap',
    '  --auto-loop / --no-auto-loop     Start continuous simulation loop',
    '  --interval <ms>                  Loop interval',
    '  --ticks-per-cycle <n>            Ticks per loop cycle',
    '  --autosave-every <ticks>         Primary save interval',
    '  --cors-origins <csv>             same-origin, *, or explicit origins',
    '  --rate-limit <requests/minute>    0 disables rate limiting',
    '  --check                          Run preflight and exit',
    '  --print-config                   Print redacted configuration',
    '  --help                           Show this help',
  ].join('\n');
}

function pick(...values) {
  return values.find(value => value !== undefined && value !== null);
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled', ''].includes(normalized)) return false;
  throw new OperationalConfigError([`invalid boolean value ${value}`]);
}

function parseInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new OperationalConfigError([`${name} must be an integer`]);
  return number;
}

function parseList(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(source.map(item => String(item).trim()).filter(Boolean))];
}

function nullableString(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function resolveFromCwd(value, cwd) {
  const text = String(value || '').trim();
  if (!text) return path.resolve(cwd);
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(cwd, text);
}

module.exports = {
  LOG_LEVELS,
  DEFAULT_OPERATIONAL_CONFIG,
  OperationalConfigError,
  loadOperationalConfig,
  validateOperationalConfig,
  publicOperationalConfig,
  parseOperationalArgs,
  operationalUsage,
  parseBoolean,
  parseInteger,
  parseList,
  resolveFromCwd,
};
