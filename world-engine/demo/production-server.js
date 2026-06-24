'use strict';

const fs = require('fs');
const path = require('path');
const {
  loadProductionConfig,
  redactProductionConfig,
} = require('../core/production-config-engine');
const {
  configurePersistenceSecurity,
  loadWorld,
  saveWorld,
} = require('../core/persistence-engine');
const {
  createWorldTemplateRegistry,
  createWorldFromTemplate,
} = require('../core/world-template-engine');
const {
  createAccount,
  getAccount,
} = require('../core/account-session-engine');
const {
  setAccountSecret,
  hasAccountSecret,
} = require('../core/credential-engine');
const {
  createProductionApiServer,
} = require('../core/production-api-engine');
const {
  stopRuntimeLoop,
  getRuntimeLoopSummary,
} = require('../core/runtime-loop-engine');

async function main() {
  const config = loadProductionConfig(process.env, process.cwd());
  const runtime = await initializeProductionRuntime(config);
  installProcessHandlers(runtime);
  runtime.server.listen(config.port, config.host, () => {
    logEvent('info', 'server.started', {
      ...redactProductionConfig(config),
      worldId: runtime.api.getWorld().id,
      tick: runtime.api.getWorld().tick,
      runtimeLoop: getRuntimeLoopSummary(runtime.api.runtimeLoop),
      endpoints: productionEndpoints(),
    });
  });
  return runtime;
}

async function initializeProductionRuntime(config) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  configurePersistenceSecurity({ allowedRoots: [config.dataDir], enforce: true });
  const previousCwd = process.cwd();
  process.chdir(config.dataDir);

  const registry = createWorldTemplateRegistry();
  const initialized = initializeProductionWorld(config, registry);
  const world = initialized.world;
  const bootstrap = await ensureBootstrapAdmin(world, config);

  if (initialized.created || bootstrap.changed) {
    saveWorld(world, config.worldFile, {
      createBackup: !initialized.created,
      reason: initialized.created ? 'production_bootstrap' : 'credential_bootstrap',
      metadata: {
        service: config.serviceName,
        templateId: world.template?.id || config.templateId,
      },
    });
  }

  const serverResult = createProductionApiServer(world, {
    ...config,
    version: '1.0.0',
    defaultSavePath: config.worldFile,
    templateRegistry: registry,
    runtimeLoop: config.runtimeLoop,
  });

  return {
    ...serverResult,
    config,
    registry,
    initialized,
    bootstrap,
    previousCwd,
    shuttingDown: false,
  };
}

function initializeProductionWorld(config, registry) {
  if (fs.existsSync(config.worldFile)) {
    const loaded = loadWorld(config.worldFile);
    return {
      world: loaded.world,
      created: false,
      source: 'save',
      file: loaded.file,
      savedAt: loaded.savedAt,
    };
  }

  const world = createWorldFromTemplate(registry, config.templateId, {
    seedTicks: config.seedTicks,
  });
  return {
    world,
    created: true,
    source: 'template',
    templateId: config.templateId,
  };
}

async function ensureBootstrapAdmin(world, config) {
  let account = getAccount(world, config.adminId);
  let changed = false;

  if (!account) {
    if (!config.adminSecret) throw startupError('MUD_ADMIN_SECRET is required on first startup');
    account = createAccount(world, {
      id: config.adminId,
      name: config.adminName,
      roles: ['admin', 'gm'],
      meta: { bootstrap: true },
    });
    await setAccountSecret(account, config.adminSecret);
    changed = true;
  } else {
    account.roles = [...new Set([...(account.roles || []), 'admin', 'gm'])];
    if (!hasAccountSecret(account)) {
      if (!config.adminSecret) throw startupError('MUD_ADMIN_SECRET is required to secure the existing bootstrap admin');
      await setAccountSecret(account, config.adminSecret);
      changed = true;
    } else if (config.rotateAdminSecret) {
      if (!config.adminSecret) throw startupError('MUD_ADMIN_SECRET is required when MUD_ROTATE_ADMIN_SECRET=true');
      await setAccountSecret(account, config.adminSecret);
      changed = true;
    }
  }

  return {
    accountId: account.id,
    changed,
    credentialConfigured: hasAccountSecret(account),
  };
}

function installProcessHandlers(runtime) {
  const shutdown = signal => gracefulShutdown(runtime, signal).catch(error => {
    logEvent('error', 'server.shutdown_failed', { signal, error: error.message });
    process.exitCode = 1;
  });

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', error => {
    logEvent('error', 'process.unhandled_rejection', { error: error?.stack || error?.message || String(error) });
  });
  process.on('uncaughtException', error => {
    logEvent('error', 'process.uncaught_exception', { error: error.stack || error.message });
    shutdown('uncaughtException');
  });
}

async function gracefulShutdown(runtime, signal = 'shutdown') {
  if (runtime.shuttingDown) return;
  runtime.shuttingDown = true;
  logEvent('info', 'server.stopping', { signal });
  stopRuntimeLoop(runtime.api.runtimeLoop, `production_${String(signal).toLowerCase()}`);

  let save = null;
  if (runtime.config.shutdownSave) {
    save = saveWorld(runtime.api.getWorld(), runtime.config.worldFile, {
      createBackup: true,
      reason: 'shutdown',
      metadata: { signal, service: runtime.config.serviceName },
    });
  }

  const timeout = setTimeout(() => {
    logEvent('error', 'server.shutdown_timeout', { signal });
    process.exitCode = 1;
  }, runtime.config.shutdownTimeoutMs);
  timeout.unref();

  await new Promise((resolve, reject) => {
    runtime.server.close(error => error ? reject(error) : resolve());
  });
  clearTimeout(timeout);
  logEvent('info', 'server.stopped', {
    signal,
    worldId: runtime.api.getWorld().id,
    tick: runtime.api.getWorld().tick,
    save,
  });
}

function productionEndpoints() {
  return [
    'GET /client',
    'GET /health',
    'GET /ready',
    'POST /accounts',
    'POST /sessions',
    'GET /session',
    'GET /players/:playerId/dashboard',
    'POST /players/:playerId/actions',
    'GET /admin/security',
    'GET /admin/accounts',
    'POST /admin/accounts',
    'POST /admin/accounts/:accountId/secret',
    'GET /admin/templates',
    'POST /admin/templates/reset',
    'GET /admin/loop',
    'POST /admin/loop/start',
    'POST /admin/loop/pause',
    'POST /admin/loop/stop',
    'POST /save',
    'POST /load',
    'GET /saves',
    'WS /ws/ticks?token=<session-token>',
  ];
}

function logEvent(level, event, data = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  const output = JSON.stringify(entry);
  if (level === 'error') console.error(output);
  else console.log(output);
  return entry;
}

function startupError(message) {
  const error = new Error(message);
  error.code = 'production_startup_failed';
  return error;
}

if (require.main === module) {
  main().catch(error => {
    logEvent('error', 'server.start_failed', {
      error: error.stack || error.message,
      cwd: path.resolve(process.cwd()),
    });
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  initializeProductionRuntime,
  initializeProductionWorld,
  ensureBootstrapAdmin,
  gracefulShutdown,
  productionEndpoints,
  logEvent,
};
