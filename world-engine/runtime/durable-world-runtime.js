'use strict';

const { createPostgresDatabaseStore } = require('../storage/postgres/store');
const { detachedJson, digest, textId, safeInteger } = require('../storage/postgres/codec');
const { integer } = require('../storage/postgres/config');
const {
  createCultureBeliefFlowDeterministicKernel,
  runDeterministicSimulationTickWithCultureBeliefFlow,
} = require('../core/culture-belief-flow-runtime-engine');

const { repairLoadedWorld } = require('../core/persistence-engine');

const { canonicalWorldCopy, canonicalizeWorldInPlace } = require('./canonical-world');

const DURABLE_RUNTIME_VERSION = 1;

function runtimeError(code) {
  const error = new Error(`Durable runtime: ${code}`);
  error.code = `WORLD_RUNTIME_${code}`;
  return error;
}
function safeErrorCode(error) {
  const code = String(error?.code || '');
  return /^(WORLD_DB|WORLD_RUNTIME)_[A-Z_]+$/.test(code) ? code : 'WORLD_RUNTIME_OPERATION_FAILED';
}
function retryable(error) {
  return ['WORLD_DB_UNAVAILABLE', 'WORLD_DB_TIMEOUT'].includes(error?.code)
    || (error?.code === 'WORLD_DB_SQL_ERROR' && ['40001', '40P01'].includes(error.sqlState));
}
function freezeJson(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
function advanceDeterministicBatch(world, ticks, simulation = {}) {
  // Kernel registries are per-batch; all continuation state lives in the world.
  const kernel = createCultureBeliefFlowDeterministicKernel();
  for (let index = 0; index < ticks; index += 1) {
    canonicalizeWorldInPlace(world);
    const report = runDeterministicSimulationTickWithCultureBeliefFlow(world, simulation, kernel);
    if (!report.kernel || report.kernel.failed !== 0) throw runtimeError('SIMULATION_FAILED');
  }
}

async function createDurableWorldRuntime(options = {}) {
  const worldId = textId(options.worldId, 'runtime worldId');
  const maxTicks = integer(options.maxTicksPerBatch, 100, 1, 1000, 'max ticks per batch');
  const batchTicks = integer(options.ticksPerBatch, 1, 1, maxTicks, 'ticks per batch');
  const intervalMs = integer(options.intervalMs, 1000, 10, 3600000, 'runtime interval');
  const retryDelayMs = integer(options.retryDelayMs, 250, 10, 60000, 'retry delay');
  const maxRetryDelayMs = integer(options.maxRetryDelayMs, Math.max(10000, retryDelayMs), retryDelayMs, 3600000, 'max retry delay');
  const maxAttempts = integer(options.maxCommitAttempts, 5, 1, 100, 'max commit attempts');
  if (options.simulation !== undefined && (!options.simulation || typeof options.simulation !== 'object' || Array.isArray(options.simulation))) {
    throw runtimeError('INVALID_SIMULATION_OPTIONS');
  }
  const simulation = freezeJson(detachedJson(options.simulation || {}));
  if (options.advance !== undefined && typeof options.advance !== 'function') throw runtimeError('INVALID_ADVANCE');
  const profile = options.advance ? textId(options.simulationId, 'custom simulationId') : 'culture-info-v1';
  const advance = options.advance || advanceDeterministicBatch;
  const onCommit = options.onCommit;
  const configHash = digest({ version: DURABLE_RUNTIME_VERSION, profile, simulation });
  const ownsStore = !options.store || options.closeStore === true;
  const store = options.store || createPostgresDatabaseStore({ ...(options.database || {}), env: options.env });
  let committed, revision;
  try {
    if (store.provider !== 'postgres' || !['saveWorld', 'loadWorld', 'close'].every(key => typeof store[key] === 'function')) {
      throw runtimeError('TRANSACTIONAL_STORE_REQUIRED');
    }
    const loaded = await store.loadWorld(worldId);
    if (!loaded) throw runtimeError('MISSING_WORLD');
    if (loaded.worldId !== worldId || loaded.world?.id !== worldId || loaded.tick !== loaded.world.tick) {
      throw runtimeError('INVALID_CHECKPOINT');
    }
    revision = safeInteger(loaded.revision, 'loaded revision', 1);
    safeInteger(loaded.world.tick, 'loaded tick');
    const previousConfig = loaded.metadata?.durableRuntime?.configHash;
    if (previousConfig && previousConfig !== configHash) throw runtimeError('CONFIG_MISMATCH');
    committed = freezeJson(canonicalWorldCopy(loaded.world));
  } catch (error) {
    if (ownsStore && typeof store.close === 'function') await store.close().catch(() => {});
    throw error;
  }

  let pending = null, inFlight = null, timer = null, closePromise = null;
  let running = false, closing = false, closed = false, blocked = false;
  let lastError = null, failures = 0, commits = 0, ticksCommitted = 0, observerErrors = 0;
  let lastReceipt = null;

  function summary() {
    return {
      version: DURABLE_RUNTIME_VERSION, provider: 'postgres', worldId, revision,
      tick: committed.tick, status: closed ? 'closed' : closing ? 'closing' : blocked ? 'blocked'
        : inFlight ? 'busy' : pending ? 'retrying' : running ? 'running' : 'idle',
      running, busy: Boolean(inFlight), pending: pending ? {
        requestId: pending.saveOptions.requestId, expectedRevision: pending.saveOptions.expectedRevision,
        tickBefore: pending.tickBefore, tickAfter: pending.world.tick, attempts: pending.attempts,
      } : null,
      commits, ticksCommitted, failures, observerErrors, lastError,
      lastReceipt: lastReceipt ? { ...lastReceipt } : null, configHash,
    };
  }
  function getWorld() { return detachedJson(committed); }
  function assertOpen() { if (closing || closed) throw runtimeError('CLOSED'); }
  function cancelTimer() { if (timer) clearTimeout(timer); timer = null; }
  function pause() { running = false; cancelTimer(); return summary(); }
  function rememberFailure(error, canRetry) {
    failures += 1;
    lastError = safeErrorCode(error);
    if (pending) pending.canRetry = canRetry;
    blocked = !canRetry || (pending?.attempts || 0) >= maxAttempts;
    if (blocked) pause();
  }
  async function commitPending() {
    if (!pending) return null;
    const batch = pending;
    batch.attempts += 1;
    let saved;
    try {
      // Defensive copies stop a driver/caller from altering the retry candidate.
      saved = await store.saveWorld(detachedJson(batch.world), detachedJson(batch.saveOptions));
      if (saved?.worldId !== worldId || saved.revision !== revision + 1 || saved.tick !== batch.world.tick
          || saved.id !== batch.saveOptions.requestId) throw runtimeError('INVALID_COMMIT_RECEIPT');
    } catch (error) {
      rememberFailure(error, retryable(error));
      throw error;
    }
    committed = batch.world;
    revision = saved.revision;
    lastReceipt = { id: saved.id, revision, tick: saved.tick, idempotent: saved.idempotent === true };
    pending = null;
    blocked = false;
    lastError = null;
    commits += 1;
    ticksCommitted += batch.ticks;
    const result = { worldId, tickBefore: batch.tickBefore, tickAfter: committed.tick,
      ticks: batch.ticks, revision, requestId: saved.id, idempotent: saved.idempotent === true };
    if (typeof onCommit === 'function') {
      try { await onCommit({ ...result }, getWorld()); }
      catch (_) { observerErrors += 1; } // A failed observer cannot uncommit or replay a batch.
    }
    return result;
  }
  function exclusive(work) {
    if (inFlight) return Promise.reject(runtimeError('BUSY'));
    const task = Promise.resolve().then(work);
    inFlight = task.finally(() => { inFlight = null; });
    return inFlight;
  }
  function step(ticks = batchTicks) {
    try {
      assertOpen();
      if (blocked) throw runtimeError('BLOCKED');
      const amount = integer(ticks, batchTicks, 1, maxTicks, 'batch ticks');
      return exclusive(async () => {
        if (!pending) {
          if (!Number.isSafeInteger(committed.tick + amount) || revision === Number.MAX_SAFE_INTEGER) {
            const error = runtimeError('COUNTER_EXHAUSTED'); rememberFailure(error, false); throw error;
          }
          try {
            const candidate = getWorld();
            await advance(candidate, amount, detachedJson(simulation));
            if (candidate.id !== worldId || candidate.tick !== committed.tick + amount) throw runtimeError('INVALID_ADVANCEMENT');
            repairLoadedWorld(candidate);
            const world = freezeJson(canonicalWorldCopy(candidate));
            const requestId = `runtime:${digest({ world, revision, configHash })}`;
            pending = { world, tickBefore: committed.tick, ticks: amount, attempts: 0, canRetry: true,
              saveOptions: freezeJson({ requestId, expectedRevision: revision, reason: 'durable_runtime_batch',
                metadata: { durableRuntime: { version: DURABLE_RUNTIME_VERSION, configHash, profile } },
                events: [{ type: 'runtime.batch_committed', payload: { tickBefore: committed.tick, ticks: amount, configHash } }],
              }),
            };
          } catch (error) { rememberFailure(error, false); throw error; }
        }
        // A retained batch is always resolved before any new simulation.
        return commitPending();
      });
    } catch (error) { return Promise.reject(error); }
  }
  function retry() {
    try {
      assertOpen();
      if (!pending || !pending.canRetry) throw runtimeError('NOT_RETRYABLE');
      if (inFlight) throw runtimeError('BUSY');
      blocked = false;
      pending.attempts = 0;
      return exclusive(commitPending);
    } catch (error) { return Promise.reject(error); }
  }
  function schedule(delay) {
    if (!running || closing || closed || blocked) return;
    cancelTimer();
    timer = setTimeout(async () => {
      timer = null;
      try { await step(); } catch (_) { /* failure is retained in summary */ }
      const backoff = pending ? Math.min(maxRetryDelayMs, retryDelayMs * (2 ** Math.min(pending.attempts - 1, 20))) : intervalMs;
      schedule(backoff);
    }, delay);
  }
  function start() {
    assertOpen();
    if (blocked) throw runtimeError('BLOCKED');
    if (inFlight) throw runtimeError('BUSY');
    if (!running) { running = true; schedule(intervalMs); }
    return summary();
  }
  function close(closeOptions = {}) {
    if (closePromise) return closePromise;
    if (closeOptions.flush !== undefined && typeof closeOptions.flush !== 'boolean') return Promise.reject(runtimeError('INVALID_CLOSE_OPTIONS'));
    closing = true; pause();
    closePromise = (async () => {
      try {
        if (inFlight) await inFlight.catch(() => {});
        if (pending && closeOptions.flush !== false && pending.canRetry) {
          try { await exclusive(commitPending); } catch (_) { /* report unconfirmed checkpoint below */ }
        }
        if (pending && closeOptions.flush !== false) throw runtimeError('UNCONFIRMED_CHECKPOINT');
      } finally {
        try { if (ownsStore) await store.close(); } finally { closed = true; closing = false; }
      }
      return summary();
    })();
    return closePromise;
  }
  return Object.freeze({ version: DURABLE_RUNTIME_VERSION, step, retry, start, pause, close, getWorld, summary });
}

module.exports = { DURABLE_RUNTIME_VERSION, createDurableWorldRuntime, advanceDeterministicBatch, retryable };
