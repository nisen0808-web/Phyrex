'use strict';
const path = require('path');
const { performance } = require('perf_hooks');
const { Worker } = require('worker_threads');

function serviceError(code) { return Object.assign(new Error(code), { code: `WORLD_SERVICE_${code}` }); }
function duration(value, fallback) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 10 || result > 3600000) throw serviceError('INVALID_TIMEOUT');
  return result;
}
async function createRuntimeWorker(options = {}, createWorker = data => new Worker(path.join(__dirname, 'runtime-worker.js'), { workerData: data })) {
  const startupMs = duration(options.startupTimeoutMs, 30000);
  const shutdownMs = duration(options.shutdownTimeoutMs, 30000);
  const staleMs = duration(options.heartbeatTimeoutMs, 30000);
  const worker = createWorker({ worldId: options.worldId, database: options.database, env: options.env,
    ticksPerBatch: options.ticksPerBatch, intervalMs: options.intervalMs, retryDelayMs: options.retryDelayMs,
    maxCommitAttempts: options.maxCommitAttempts, simulation: options.simulation, upgradeCommandProfile: options.upgradeCommandProfile });
  let state = { status: 'starting' }, updated = -Infinity, closing = false, ended = false, stopped, fault, closePromise;
  let readyResolve, readyReject, exitResolve;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exited = new Promise(resolve => { exitResolve = resolve; });
  const fail = error => { fault = error; readyReject(error); };
  worker.on('message', message => {
    if (message?.type === 'ready' || message?.type === 'status') {
      state = message.state; updated = performance.now();
      if (message.type === 'ready') readyResolve();
    } else if (message?.type === 'fatal') fail(message.error === 'WORLD_RUNTIME_COMMAND_PROFILE_UPGRADE_REQUIRED'
      ? Object.assign(new Error(message.error), { code: message.error }) : serviceError('WORKER_FAILED'));
    else if (message?.type === 'stopped') stopped = message;
  });
  worker.on('error', () => fail(serviceError('WORKER_FAILED')));
  worker.on('exit', code => {
    ended = true;
    if (!closing || code !== 0 || !stopped?.ok) fail(serviceError('WORKER_EXITED'));
    exitResolve();
  });
  let startupTimer;
  try {
    await Promise.race([ready, new Promise((_, reject) => {
      startupTimer = setTimeout(() => reject(serviceError('STARTUP_TIMEOUT')), startupMs);
    })]);
  } catch (error) {
    closing = true;
    await worker.terminate();
    throw error;
  } finally { clearTimeout(startupTimer); }
  function isReady() {
    return !closing && !ended && !fault && performance.now() - updated <= staleMs
      && state.running === true && !state.lastError && ['running', 'busy'].includes(state.status);
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      if (!ended) worker.postMessage({ type: 'stop' });
      let timer;
      try {
        await Promise.race([exited, new Promise((_, reject) => {
          timer = setTimeout(() => reject(serviceError('SHUTDOWN_TIMEOUT')), shutdownMs);
        })]);
      } catch (error) {
        await worker.terminate();
        throw error;
      } finally { clearTimeout(timer); }
      if (fault || !stopped?.ok) throw fault || serviceError('UNCONFIRMED_SHUTDOWN');
    })();
    return closePromise;
  }
  return Object.freeze({ isReady, close, summary: () => ({ status: ended ? 'stopped' : state.status,
    ready: isReady(), tick: state.tick ?? null, revision: state.revision ?? null }) });
}
module.exports = { createRuntimeWorker, serviceError, duration };
