'use strict';
const { parentPort, workerData } = require('worker_threads');
const { createDurableWorldRuntime } = require('../runtime/durable-world-runtime');

let runtime, timer, stopping = false, closePromise;
function safeCode(error) {
  return /^(WORLD_DB|WORLD_RUNTIME)_[A-Z_]+$/.test(error?.code || '') ? error.code : 'WORLD_SERVICE_WORKER_FAILED';
}
function report(type = 'status') {
  const state = runtime.summary();
  parentPort.postMessage({ type, state: { status: state.status, running: state.running,
    revision: state.revision, tick: state.tick, failures: state.failures, lastError: state.lastError } });
}
function stop() {
  stopping = true;
  clearInterval(timer);
  if (!runtime) return;
  if (!closePromise) closePromise = runtime.close().then(
    () => parentPort.postMessage({ type: 'stopped', ok: true }),
    error => parentPort.postMessage({ type: 'stopped', ok: false, error: safeCode(error) })
  ).finally(() => parentPort.close());
  return closePromise;
}
parentPort.on('message', message => { if (message?.type === 'stop') stop(); });
(async () => {
  runtime = await createDurableWorldRuntime(workerData);
  if (stopping) return stop();
  runtime.start();
  report('ready');
  timer = setInterval(report, 250);
})().catch(error => {
  clearInterval(timer);
  parentPort.postMessage({ type: 'fatal', error: safeCode(error) });
  parentPort.close();
});
