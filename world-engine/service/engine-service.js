'use strict';
const { createDurableCommandApiServer } = require('../core/durable-command-api-engine');
const { createRuntimeWorker, serviceError } = require('./runtime-worker-controller');
const { wallClockNow } = require('../platform/runtime-clock');
const { textId } = require('../storage/postgres/codec');

// Only the worker owns the simulation. The HTTP side reads committed SQL state.
async function createEngineService(options = {}, factories = {}) {
  textId(options.worldId, 'service worldId');
  const port = options.port ?? 8791, host = options.host ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535 || typeof host !== 'string' || !host.trim()) throw serviceError('INVALID_LISTENER');
  let runtime, api, stopping = false, closePromise, probe;
  let rejected = 0, lastRejection = null;
  async function readiness() {
    if (stopping) return 'service_stopping';
    if (!runtime?.isReady()) return runtime?.summary().failureKind || 'runtime_not_ready';
    // Coalesce simultaneous probes; each completed probe is discarded, so a
    // database outage cannot be hidden behind a cached successful result.
    if (!probe) probe = api.store.getWorldHead(options.worldId).then(head => Boolean(head), () => false).finally(() => { probe = null; });
    const available = await probe;
    if (!available) return 'database_unavailable';
    if (stopping) return 'service_stopping';
    return runtime.isReady() ? null : runtime.summary().failureKind || 'runtime_not_ready';
  }
  async function isReady() { return (await readiness()) === null; }
  async function canSubmit() {
    const reason = await readiness();
    if (reason) {
      rejected++;
      const state = runtime?.summary();
      lastRejection = { reason, heartbeatAgeMs: state?.heartbeatAgeMs, revision: state?.revision, tick: state?.tick };
    }
    return reason === null;
  }
  function status() {
    return { stopping, intervalMs: options.intervalMs ?? 1000, runtime: runtime?.summary(),
      admission: { rejected, lastRejection } };
  }
  function close() {
    if (closePromise) return closePromise;
    stopping = true;
    closePromise = (async () => {
      let failure;
      // Stop intake and drain accepted HTTP requests/audits before the worker.
      try { if (api) await api.close(); } catch (error) { failure = error; }
      try { if (runtime) await runtime.close(); } catch (error) { failure ||= error; }
      if (failure) throw failure;
    })();
    return closePromise;
  }
  try {
    api = await (factories.createApi || createDurableCommandApiServer)({ webConsole: true, ...(options.api || {}),
      env: options.env, database: options.database, worldId: options.worldId,
      rateLimitNow: wallClockNow, health: isReady, canSubmit, serviceStatus: status });
    if (typeof api.store.getWorldHead !== 'function' || !await api.store.getWorldHead(options.worldId)) throw serviceError('MISSING_WORLD');
    // Reserve the listener before starting the writer: port collisions must not
    // evolve the world. Readiness stays false until the worker is ready.
    await new Promise((resolve, reject) => {
      api.server.once('error', reject);
      api.server.listen(port, host, () => { api.server.removeListener('error', reject); resolve(); });
    });
    runtime = await (factories.createRuntime || createRuntimeWorker)(options);
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  return Object.freeze({ address: () => api.server.address(), isReady, close,
    summary: () => ({ worldId: options.worldId, ...status(), audit: api.auditStats() }) });
}
module.exports = { createEngineService };
