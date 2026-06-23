'use strict';

const fs = require('fs');
const path = require('path');
const {
  loadOperationalConfig,
  publicOperationalConfig,
  operationalUsage,
} = require('./operational-config');
const { createStructuredLogger } = require('./structured-logger');
const {
  loadOperationalWorld,
  bootstrapOperationalAdmin,
  savePrimaryWorld,
  createOperationalBackup,
  ensureOperationalDirectories,
  timestampForFile,
} = require('./world-storage');
const { runOperationalPreflight } = require('./preflight');
const { createOperationalApiServer } = require('../core/operational-api-engine');
const { stopRuntimeLoop, getRuntimeLoopSummary } = require('../core/runtime-loop-engine');

function createProductionService(config, options = {}) {
  const logger = options.logger || createStructuredLogger({
    level: config.logLevel,
    service: config.serviceName,
  });
  const operationalState = {
    ready: false,
    shuttingDown: false,
    startedAt: null,
    stoppedAt: null,
    storageReady: false,
    storageSource: null,
    recovered: false,
  };

  ensureOperationalDirectories(config);
  const storage = loadOperationalWorld(config, { logger });
  operationalState.storageReady = true;
  operationalState.storageSource = storage.source;
  operationalState.recovered = Boolean(storage.recovered);
  if (storage.recovered && fs.existsSync(config.worldFile)) {
    quarantinePrimarySave(config, logger);
  }

  const admin = bootstrapOperationalAdmin(storage.world, config, { logger });
  const initialSave = savePrimaryWorld(
    storage.world,
    config,
    storage.recovered ? 'startup_recovery' : storage.source.startsWith('template:') ? 'initial_world' : 'startup_state',
    { createBackup: false },
  );
  logger.info('world_primary_saved', {
    file: initialSave.file,
    worldId: initialSave.worldId,
    tick: initialSave.tick,
  });

  const apiServer = createOperationalApiServer(storage.world, {
    host: config.host,
    port: config.port,
    seedTicks: 0,
    defaultSavePath: config.worldFile,
    requireAuth: config.requireAuth,
    autoStartLoop: config.autoStartLoop,
    runtimeLoop: {
      intervalMs: config.intervalMs,
      ticksPerCycle: config.ticksPerCycle,
      autosaveEveryTicks: config.autosaveEveryTicks,
      autosavePath: config.autosavePath,
      stopOnError: config.stopOnError,
      immediate: false,
      simulation: {
        autoNovel: false,
        autoNarrative: false,
      },
    },
    operationalState,
    operational: {
      serviceName: config.serviceName,
      lockOnboarding: config.lockOnboarding,
      corsOrigins: config.corsOrigins,
      rateLimitPerMinute: config.rateLimitPerMinute,
      metricsRequireAuth: config.metricsRequireAuth,
      trustProxy: config.trustProxy,
      buildSha: config.buildSha,
      buildDate: config.buildDate,
    },
  });

  let started = false;
  let stoppingPromise = null;
  let removeSignalHandlers = null;

  async function start() {
    if (started) return serviceSummary();
    await listen(apiServer.server, config.port, config.host);
    started = true;
    operationalState.startedAt = new Date().toISOString();
    operationalState.ready = true;
    const summary = serviceSummary();
    logger.info('service_started', summary);
    for (const warning of config.warnings || []) logger.warn('configuration_warning', { warning });
    if (admin) {
      logger.warn('administrator_access', {
        accountId: admin.account.id,
        tokenFile: admin.tokenFile,
        sessionReused: admin.reused,
      });
    }
    return summary;
  }

  async function stop(reason = 'shutdown') {
    if (stoppingPromise) return stoppingPromise;
    stoppingPromise = (async () => {
      operationalState.shuttingDown = true;
      operationalState.ready = false;
      logger.warn('service_stopping', { reason });
      stopRuntimeLoop(apiServer.api.runtimeLoop, reason);

      const errors = [];
      let backup = null;
      let save = null;
      try {
        if (config.backupOnShutdown) {
          backup = createOperationalBackup(apiServer.api.getWorld(), config, 'shutdown');
          logger.info('shutdown_backup_created', {
            file: backup.file,
            tick: backup.tick,
          });
        }
      } catch (error) {
        errors.push(error);
        logger.error('shutdown_backup_failed', { error });
      }

      try {
        save = savePrimaryWorld(apiServer.api.getWorld(), config, 'shutdown', { createBackup: false });
        logger.info('shutdown_world_saved', {
          file: save.file,
          tick: save.tick,
        });
      } catch (error) {
        errors.push(error);
        logger.error('shutdown_save_failed', { error });
      }

      closeLiveConnections(apiServer.api);
      const closeResult = await closeServer(apiServer.server, config.shutdownTimeoutMs);
      operationalState.stoppedAt = new Date().toISOString();
      operationalState.shuttingDown = false;
      started = false;
      if (removeSignalHandlers) {
        removeSignalHandlers();
        removeSignalHandlers = null;
      }
      const result = {
        ok: errors.length === 0 && !closeResult.timedOut,
        reason,
        backup,
        save,
        close: closeResult,
        errors: errors.map(error => error.message),
      };
      logger.info('service_stopped', result);
      return result;
    })();
    return stoppingPromise;
  }

  function installSignalHandlers() {
    if (removeSignalHandlers) return removeSignalHandlers;
    let fatal = false;
    const onSignal = signal => {
      if (fatal) return;
      fatal = true;
      logger.warn('signal_received', { signal });
      stop(`signal:${signal}`).then(result => {
        process.exit(result.ok ? 0 : 1);
      }).catch(error => {
        logger.error('signal_shutdown_failed', { error });
        process.exit(1);
      });
    };
    const onFatal = error => {
      if (fatal) return;
      fatal = true;
      logger.error('fatal_process_error', { error });
      stop('fatal_error').finally(() => process.exit(1));
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.once('uncaughtException', onFatal);
    process.once('unhandledRejection', onFatal);
    removeSignalHandlers = () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('uncaughtException', onFatal);
      process.removeListener('unhandledRejection', onFatal);
    };
    return removeSignalHandlers;
  }

  function serviceSummary() {
    const address = apiServer.server.address();
    const boundPort = typeof address === 'object' && address ? address.port : config.port;
    const clientHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
    return {
      ok: true,
      service: config.serviceName,
      version: apiServer.versionInfo.version,
      host: config.host,
      port: boundPort,
      publicUrl: config.publicUrl || null,
      clientUrl: config.publicUrl ? `${config.publicUrl.replace(/\/$/, '')}/client` : `http://${clientHost}:${boundPort}/client`,
      worldId: apiServer.api.getWorld().id,
      tick: apiServer.api.getWorld().tick,
      requireAuth: config.requireAuth,
      onboardingLocked: config.lockOnboarding,
      storageSource: storage.source,
      recovered: storage.recovered,
      worldFile: config.worldFile,
      backupDir: config.backupDir,
      adminTokenFile: admin?.tokenFile || null,
      runtimeLoop: getRuntimeLoopSummary(apiServer.api.runtimeLoop),
    };
  }

  return {
    config,
    logger,
    storage,
    admin,
    server: apiServer.server,
    api: apiServer.api,
    operationalState,
    versionInfo: apiServer.versionInfo,
    start,
    stop,
    installSignalHandlers,
    summary: serviceSummary,
  };
}

function quarantinePrimarySave(config, logger) {
  const fileName = `corrupt-primary-${timestampForFile()}.json`;
  const destination = path.join(config.backupDir, fileName);
  try {
    fs.copyFileSync(config.worldFile, destination, fs.constants.COPYFILE_EXCL);
    logger?.warn('corrupt_primary_quarantined', {
      source: config.worldFile,
      destination,
    });
    return destination;
  } catch (error) {
    logger?.error('corrupt_primary_quarantine_failed', { error, source: config.worldFile });
    throw error;
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeLiveConnections(api) {
  for (const stream of [...(api.streams || [])]) {
    try { stream.res.end(); } catch (_error) {}
    api.streams.delete(stream);
  }
  for (const socket of [...(api.sockets || [])]) {
    try { socket.end(); } catch (_error) {}
    try { socket.destroy(); } catch (_error) {}
    api.sockets.delete(socket);
  }
}

function closeServer(server, timeoutMs) {
  if (!server.listening) return Promise.resolve({ closed: true, timedOut: false });
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { server.closeAllConnections?.(); } catch (_error) {}
      finish({ closed: false, timedOut: true });
    }, Math.max(100, Number(timeoutMs || 10000)));
    server.close(error => {
      if (error) finish({ closed: false, timedOut: false, error: error.message });
      else finish({ closed: true, timedOut: false });
    });
    try { server.closeIdleConnections?.(); } catch (_error) {}
  });
}

async function main() {
  let config;
  let logger;
  try {
    config = loadOperationalConfig({ argv: process.argv.slice(2) });
    if (config.help) {
      console.log(operationalUsage());
      return;
    }
    if (config.printConfig) console.log(JSON.stringify(publicOperationalConfig(config), null, 2));
    const preflight = runOperationalPreflight(config);
    if (config.checkOnly) {
      console.log(JSON.stringify(preflight, null, 2));
      if (!preflight.ok) process.exitCode = 1;
      return;
    }
    if (!preflight.ok) throw new Error(`Operational preflight failed: ${preflight.errors.join('; ')}`);

    logger = createStructuredLogger({ level: config.logLevel, service: config.serviceName });
    const service = createProductionService(config, { logger });
    service.installSignalHandlers();
    await service.start();
  } catch (error) {
    if (logger) logger.error('service_start_failed', { error });
    else console.error(JSON.stringify({ ok: false, error: error.message, errors: error.errors || [] }, null, 2));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  createProductionService,
  quarantinePrimarySave,
  listen,
  closeLiveConnections,
  closeServer,
  main,
};
