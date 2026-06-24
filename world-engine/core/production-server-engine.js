'use strict';

const fs = require('fs');
const path = require('path');
const {
  createProductionApiServer,
} = require('./production-api-engine');
const {
  loadWorld,
  saveWorld,
} = require('./persistence-engine');
const {
  stopRuntimeLoop,
  getRuntimeLoopSummary,
} = require('./runtime-loop-engine');
const {
  RELEASE_VERSION,
  redactProductionConfig,
} = require('./production-config-engine');

function createProductionWorldService(config, dependencies = {}) {
  if (!config) throw new Error('createProductionWorldService requires config');
  const io = {
    fs: dependencies.fs || fs,
    now: dependencies.now || (() => new Date()),
    process: dependencies.process || process,
  };
  ensureProductionDirectories(config, io.fs);
  const recovery = loadInitialProductionWorld(config, io.fs);
  invalidatePersistedSessions(recovery.world);

  const bundle = createProductionApiServer(recovery.world, {
    environment: config.environment,
    requireAuth: config.requireAuth,
    allowRegistration: config.allowRegistration,
    requirePasswords: config.requirePasswords,
    sessionTtlTicks: config.sessionTtlTicks,
    corsOrigins: config.corsOrigins,
    trustProxy: config.trustProxy,
    rateLimitWindowMs: config.rateLimitWindowMs,
    rateLimitMax: config.rateLimitMax,
    authRateLimitMax: config.authRateLimitMax,
    maxBodyBytes: config.maxBodyBytes,
    metricsPublic: config.metricsPublic,
    logger: entry => emitServiceLog(config, entry),
    defaultSavePath: config.savePath,
    seedTicks: config.seedTicks,
    autoStartLoop: config.autoStartLoop,
    runtimeLoop: {
      intervalMs: config.loopIntervalMs,
      ticksPerCycle: config.ticksPerCycle,
      autosaveEveryTicks: config.autosaveEveryTicks,
      autosavePath: config.autosaveEveryTicks > 0 ? config.savePath : null,
      stopOnError: config.stopOnLoopError,
      immediate: false,
      persistence: {
        excludeSessions: true,
        createBackup: true,
        maxBackups: 5,
      },
    },
    admin: {
      id: config.adminId,
      name: config.adminName,
      password: config.adminPassword,
    },
  });

  const state = {
    started: false,
    shuttingDown: false,
    shutdownPromise: null,
    lockPath: path.join(config.dataDirectory, 'world-engine.pid'),
    recovery: {
      loaded: recovery.loaded,
      file: recovery.file,
      savedAt: recovery.savedAt,
      sessionsInvalidated: recovery.sessionsInvalidated,
    },
    lastSave: null,
    lastArchive: null,
  };

  bundle.production.recovery = { ...state.recovery };

  async function start() {
    if (state.started) return serviceStatus(bundle, config, state);
    acquireProcessLock(state.lockPath, io.process, io.fs);
    try {
      await listen(bundle.server, config.port, config.host);
      state.started = true;
      writeRuntimeManifest(config, bundle, state, io.fs, io.now);
      emitServiceLog(config, {
        level: 'info',
        event: 'service_started',
        version: RELEASE_VERSION,
        pid: io.process.pid,
        host: config.host,
        port: config.port,
        worldId: bundle.api.getWorld().id,
        tick: bundle.api.getWorld().tick,
        recovery: state.recovery,
        config: redactProductionConfig(config),
      });
      return serviceStatus(bundle, config, state);
    } catch (error) {
      releaseProcessLock(state.lockPath, io.fs);
      throw error;
    }
  }

  async function save(reason = 'manual', options = {}) {
    const world = bundle.api.getWorld();
    const primary = saveWorld(world, config.savePath, {
      excludeSessions: true,
      createBackup: options.createBackup !== false,
      maxBackups: 5,
      reason,
      metadata: {
        source: 'production_service',
        releaseVersion: RELEASE_VERSION,
        ...(options.metadata || {}),
      },
    });
    state.lastSave = primary;
    if (options.archive === true) {
      const archivePath = operationalArchivePath(config, world, reason, io.now());
      state.lastArchive = saveWorld(world, archivePath, {
        excludeSessions: true,
        createBackup: false,
        reason,
        metadata: {
          source: 'production_service_archive',
          releaseVersion: RELEASE_VERSION,
        },
      });
    }
    return { primary, archive: state.lastArchive };
  }

  async function shutdown(reason = 'shutdown', exitCode = 0) {
    if (state.shutdownPromise) return state.shutdownPromise;
    state.shutdownPromise = (async () => {
      state.shuttingDown = true;
      bundle.production.shuttingDown = true;
      bundle.production.ready = false;
      emitServiceLog(config, { level: 'info', event: 'shutdown_started', reason, exitCode });

      stopRuntimeLoop(bundle.runtimeLoop, `production_${reason}`);
      await waitForLoopIdle(bundle.runtimeLoop, Math.min(5000, Math.floor(config.shutdownTimeoutMs / 2)));

      let saveResult = null;
      let saveError = null;
      if (config.shutdownSave) {
        try {
          saveResult = await save('production_shutdown', {
            archive: true,
            metadata: { shutdownReason: reason, exitCode },
          });
        } catch (error) {
          saveError = error;
          emitServiceLog(config, { level: 'error', event: 'shutdown_save_failed', error: error.message || String(error) });
        }
      }

      closeLiveConnections(bundle);
      const closeResult = await closeServerWithTimeout(bundle.server, config.shutdownTimeoutMs);
      releaseProcessLock(state.lockPath, io.fs);
      removeRuntimeManifest(config, io.fs);
      state.started = false;

      emitServiceLog(config, {
        level: saveError || !closeResult.closed ? 'error' : 'info',
        event: 'shutdown_completed',
        reason,
        exitCode,
        closed: closeResult.closed,
        forced: closeResult.forced,
        save: saveResult,
        saveError: saveError?.message || null,
      });

      return {
        ok: !saveError && closeResult.closed,
        reason,
        exitCode,
        save: saveResult,
        saveError: saveError?.message || null,
        ...closeResult,
      };
    })();
    return state.shutdownPromise;
  }

  return {
    ...bundle,
    config,
    state,
    start,
    save,
    shutdown,
    status: () => serviceStatus(bundle, config, state),
  };
}

function loadInitialProductionWorld(config, fsModule = fs) {
  if (config.loadOnStart && fsModule.existsSync(config.savePath)) {
    const loaded = loadWorld(config.savePath);
    return {
      world: loaded.world,
      loaded: true,
      file: loaded.file,
      savedAt: loaded.savedAt,
      sessionsInvalidated: countActiveSessions(loaded.world),
    };
  }
  if (config.requireExistingSave) {
    const error = new Error(`required_save_missing:${config.savePath}`);
    error.code = 'required_save_missing';
    throw error;
  }
  return {
    world: null,
    loaded: false,
    file: null,
    savedAt: null,
    sessionsInvalidated: 0,
  };
}

function invalidatePersistedSessions(world) {
  if (!world?.accounts) return 0;
  const count = countActiveSessions(world);
  world.accounts.sessions = {};
  world.accounts.byToken = {};
  return count;
}

function countActiveSessions(world) {
  return Object.values(world?.accounts?.sessions || {}).filter(session => session?.status === 'active').length;
}

function ensureProductionDirectories(config, fsModule = fs) {
  fsModule.mkdirSync(config.dataDirectory, { recursive: true });
  fsModule.mkdirSync(path.dirname(config.savePath), { recursive: true });
  fsModule.mkdirSync(config.backupDirectory, { recursive: true });
}

function acquireProcessLock(lockPath, processObject = process, fsModule = fs) {
  if (fsModule.existsSync(lockPath)) {
    try {
      const existing = JSON.parse(fsModule.readFileSync(lockPath, 'utf8'));
      const pid = Number(existing.pid || 0);
      if (pid > 0 && processIsAlive(pid, processObject)) {
        const error = new Error(`service_already_running:${pid}`);
        error.code = 'service_already_running';
        throw error;
      }
    } catch (error) {
      if (error.code === 'service_already_running') throw error;
    }
  }
  fsModule.writeFileSync(lockPath, JSON.stringify({
    pid: processObject.pid,
    startedAt: new Date().toISOString(),
    version: RELEASE_VERSION,
  }, null, 2), 'utf8');
}

function releaseProcessLock(lockPath, fsModule = fs) {
  try { fsModule.rmSync(lockPath, { force: true }); } catch (_error) { /* best effort */ }
}

function processIsAlive(pid, processObject = process) {
  try {
    processObject.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function writeRuntimeManifest(config, bundle, state, fsModule = fs, now = () => new Date()) {
  const filePath = path.join(config.dataDirectory, 'runtime.json');
  const world = bundle.api.getWorld();
  fsModule.writeFileSync(filePath, JSON.stringify({
    service: 'world-engine',
    version: RELEASE_VERSION,
    pid: process.pid,
    startedAt: now().toISOString(),
    host: config.host,
    port: config.port,
    worldId: world.id,
    tick: world.tick,
    recovery: state.recovery,
  }, null, 2), 'utf8');
}

function removeRuntimeManifest(config, fsModule = fs) {
  try { fsModule.rmSync(path.join(config.dataDirectory, 'runtime.json'), { force: true }); } catch (_error) { /* best effort */ }
}

function operationalArchivePath(config, world, reason, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const name = [
    sanitizeFilePart(world?.id || 'world'),
    `tick-${Number(world?.tick || 0)}`,
    sanitizeFilePart(reason || 'backup'),
    stamp,
  ].join('-') + '.json';
  return path.join(config.backupDirectory, name);
}

function serviceStatus(bundle, config, state) {
  const world = bundle.api.getWorld();
  return {
    ok: state.started && !state.shuttingDown,
    service: 'world-engine',
    version: RELEASE_VERSION,
    host: config.host,
    port: config.port,
    worldId: world?.id || null,
    tick: world?.tick ?? null,
    recovery: { ...state.recovery },
    runtimeLoop: getRuntimeLoopSummary(bundle.runtimeLoop),
    lastSave: state.lastSave,
    lastArchive: state.lastArchive,
  };
}

function installProductionSignalHandlers(service, processObject = process) {
  let handlingFatal = false;
  const terminate = (signal, exitCode) => {
    service.shutdown(signal.toLowerCase(), exitCode)
      .then(() => processObject.exit(exitCode))
      .catch(error => {
        console.error(JSON.stringify({ level: 'error', event: 'shutdown_failed', error: error.message || String(error) }));
        processObject.exit(1);
      });
  };
  processObject.once('SIGTERM', () => terminate('SIGTERM', 0));
  processObject.once('SIGINT', () => terminate('SIGINT', 0));
  processObject.on('unhandledRejection', error => {
    if (handlingFatal) return;
    handlingFatal = true;
    emitServiceLog(service.config, { level: 'error', event: 'unhandled_rejection', error: error?.stack || error?.message || String(error) });
    terminate('unhandled_rejection', 1);
  });
  processObject.on('uncaughtException', error => {
    if (handlingFatal) return;
    handlingFatal = true;
    emitServiceLog(service.config, { level: 'error', event: 'uncaught_exception', error: error?.stack || error?.message || String(error) });
    terminate('uncaught_exception', 1);
  });
}

function closeLiveConnections(bundle) {
  for (const stream of [...(bundle.streams || [])]) {
    try { stream.res.end(); } catch (_error) { /* best effort */ }
  }
  for (const socket of [...(bundle.sockets || [])]) {
    try { socket.end(); } catch (_error) { /* best effort */ }
    try { socket.destroy(); } catch (_error) { /* best effort */ }
  }
}

function closeServerWithTimeout(server, timeoutMs) {
  if (!server.listening) return Promise.resolve({ closed: true, forced: false });
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { server.closeAllConnections?.(); } catch (_error) { /* optional Node API */ }
      finish({ closed: false, forced: true });
    }, Math.max(1000, Number(timeoutMs || 10000)));
    server.close(error => finish({ closed: !error, forced: false, error: error?.message || null }));
  });
}

function waitForLoopIdle(loop, timeoutMs) {
  const started = Date.now();
  return new Promise(resolve => {
    const inspect = () => {
      if (!loop?.busy || Date.now() - started >= timeoutMs) return resolve(!loop?.busy);
      setTimeout(inspect, 20);
    };
    inspect();
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function emitServiceLog(config, entry) {
  if (config.logFormat === 'pretty') {
    const details = Object.entries(entry)
      .filter(([key]) => !['level', 'event'].includes(key))
      .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
      .join(' ');
    console.log(`[${new Date().toISOString()}] ${String(entry.level || 'info').toUpperCase()} ${entry.event || 'event'} ${details}`.trim());
    return;
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), service: 'world-engine', version: RELEASE_VERSION, ...entry }));
}

function sanitizeFilePart(value) {
  return String(value || 'world').replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

module.exports = {
  createProductionWorldService,
  loadInitialProductionWorld,
  invalidatePersistedSessions,
  countActiveSessions,
  ensureProductionDirectories,
  acquireProcessLock,
  releaseProcessLock,
  processIsAlive,
  operationalArchivePath,
  serviceStatus,
  installProductionSignalHandlers,
  closeLiveConnections,
  closeServerWithTimeout,
  waitForLoopIdle,
};
