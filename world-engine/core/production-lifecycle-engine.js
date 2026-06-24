'use strict';

const fs = require('fs');
const { loadWorld, saveWorld } = require('./persistence-engine');
const { stopRuntimeLoop, getRuntimeLoopSummary } = require('./runtime-loop-engine');

function loadStartupWorld(config = {}) {
  if (!config.startupSavePath) return null;
  if (!fs.existsSync(config.startupSavePath)) {
    const error = new Error(`startup_save_missing:${config.startupSavePath}`);
    error.code = 'STARTUP_SAVE_MISSING';
    throw error;
  }
  return loadWorld(config.startupSavePath).world;
}

function createProductionLifecycle(input = {}) {
  const server = required(input, 'server');
  const api = required(input, 'api');
  const config = input.config || {};
  const logger = input.logger || console;
  const processRef = input.processRef || process;
  const signals = input.signals !== false;
  let shutdownPromise = null;
  const handlers = new Map();

  async function shutdown(reason = 'shutdown', options = {}) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = performShutdown({
      server,
      api,
      config,
      logger,
      reason,
      save: options.save !== false,
    });
    return shutdownPromise;
  }

  function install() {
    if (!signals || handlers.size) return lifecycle;
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => {
        shutdown(signal.toLowerCase()).then(() => {
          processRef.exitCode = 0;
        }).catch(error => {
          logger.error?.(JSON.stringify({ ok: false, event: 'shutdown.failed', signal, error: error.message }));
          processRef.exitCode = 1;
        });
      };
      handlers.set(signal, handler);
      processRef.on(signal, handler);
    }

    const fatal = type => error => {
      logger.error?.(JSON.stringify({
        ok: false,
        event: type,
        error: error?.stack || error?.message || String(error),
      }));
      shutdown(type).finally(() => {
        processRef.exitCode = 1;
      });
    };
    handlers.set('uncaughtException', fatal('uncaughtException'));
    handlers.set('unhandledRejection', fatal('unhandledRejection'));
    processRef.on('uncaughtException', handlers.get('uncaughtException'));
    processRef.on('unhandledRejection', handlers.get('unhandledRejection'));
    return lifecycle;
  }

  function uninstall() {
    for (const [event, handler] of handlers.entries()) processRef.removeListener(event, handler);
    handlers.clear();
    return lifecycle;
  }

  const lifecycle = {
    install,
    uninstall,
    shutdown,
    get shuttingDown() {
      return Boolean(shutdownPromise);
    },
  };
  return lifecycle;
}

async function performShutdown(input) {
  const startedAt = Date.now();
  const { server, api, config, logger, reason } = input;
  const world = api.getWorld();
  const loopBefore = getRuntimeLoopSummary(api.runtimeLoop);
  stopRuntimeLoop(api.runtimeLoop, reason);

  let save = null;
  let saveError = null;
  if (input.save && config.shutdownSavePath && world) {
    try {
      save = saveWorld(world, config.shutdownSavePath, {
        createBackup: true,
        reason: 'graceful_shutdown',
        metadata: {
          source: 'production_lifecycle',
          shutdownReason: reason,
        },
      });
    } catch (error) {
      saveError = error;
      logger.error?.(JSON.stringify({ ok: false, event: 'shutdown.save_failed', error: error.message }));
    }
  }

  closeStreams(api.streams);
  closeSockets(api.sockets);
  const closeResult = await closeServer(server, Number(config.shutdownTimeoutMs || 10000));
  const summary = {
    ok: !saveError && !closeResult.timedOut,
    reason,
    durationMs: Date.now() - startedAt,
    worldId: world?.id || null,
    tick: world?.tick ?? null,
    loopBefore,
    save,
    saveError: saveError?.message || null,
    close: closeResult,
  };
  logger.log?.(JSON.stringify({ event: 'shutdown.complete', ...summary }));
  if (saveError) throw saveError;
  return summary;
}

function closeServer(server, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve({ closed: true, timedOut: false });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.closeAllConnections?.();
      resolve({ closed: false, timedOut: true });
    }, Math.max(1000, timeoutMs));
    timer.unref?.();
    server.close(error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ closed: true, timedOut: false });
    });
  });
}

function closeStreams(streams) {
  for (const stream of streams || []) {
    try {
      stream.end?.();
      stream.destroy?.();
    } catch (_error) {
      // Best-effort shutdown for open SSE clients.
    }
  }
}

function closeSockets(sockets) {
  for (const socket of sockets || []) {
    try {
      socket.end?.();
      socket.destroy?.();
    } catch (_error) {
      // Best-effort shutdown for open WebSocket clients.
    }
  }
}

function required(input, key) {
  if (!input[key]) throw new Error(`production_lifecycle_requires_${key}`);
  return input[key];
}

module.exports = {
  loadStartupWorld,
  createProductionLifecycle,
  performShutdown,
  closeServer,
  closeStreams,
  closeSockets,
};
