'use strict';
const assert = require('assert');
const { Worker } = require('worker_threads');
const { setTimeout: delay } = require('timers/promises');
const { createRuntimeWorker } = require('../service/runtime-worker-controller');
const initial = `const { parentPort, workerData } = require('worker_threads');
  const report = type => parentPort.postMessage({ type, state: { status: 'running', running: true, tick: 7, revision: 8, lastError: null } });`;
async function main() {
  const control = new Int32Array(new SharedArrayBuffer(4)); let child;
  const controller = await createRuntimeWorker({ heartbeatTimeoutMs: 30, shutdownTimeoutMs: 5000 }, () => {
    child = new Worker(initial + `
      report('ready');
      const flags = new Int32Array(workerData);
      while (Atomics.load(flags, 0) === 0) {} // deliberately block only the worker
      report('status');
      const timer = setInterval(() => report('status'), 10);
      parentPort.on('message', () => { clearInterval(timer); parentPort.postMessage({ type: 'stopped', ok: true }); parentPort.close(); });`,
    { eval: true, workerData: control.buffer }); return child;
  });
  try {
    await delay(60); // This timer would never run if evolution used the HTTP thread.
    assert.strictEqual(controller.isReady(), false, 'stale worker must close admission');
    assert.strictEqual(controller.summary().failureKind, 'heartbeat_stale');
    assert.ok(controller.summary().heartbeatAgeMs >= 30);
    Atomics.store(control, 0, 1);
    for (let i = 0; i < 100 && !controller.isReady(); i++) await delay(10);
    assert.strictEqual(controller.isReady(), true);
    assert.strictEqual(controller.summary().tick, 7);
    assert.strictEqual(controller.summary().failureKind, null);
    const close = controller.close(); assert.strictEqual(controller.close(), close); await close;
  } finally { Atomics.store(control, 0, 1); await child.terminate(); }
  await assert.rejects(createRuntimeWorker({ startupTimeoutMs: 30 }, () => new Worker('setInterval(() => {}, 1000)', { eval: true })), { code: 'WORLD_SERVICE_STARTUP_TIMEOUT' });
  const stuck = await createRuntimeWorker({ shutdownTimeoutMs: 30 }, () => new Worker(initial + "report('ready'); setInterval(() => {}, 1000);", { eval: true }));
  await assert.rejects(stuck.close(), { code: 'WORLD_SERVICE_SHUTDOWN_TIMEOUT' });
  let crashWorker;
  const crash = await createRuntimeWorker({}, () => { crashWorker = new Worker(initial + "report('ready'); setInterval(() => {}, 1000);", { eval: true }); return crashWorker; });
  await crashWorker.terminate();
  assert.strictEqual(crash.summary().failureKind, 'worker_failed');
  assert.strictEqual(crash.isReady(), false); await assert.rejects(crash.close(), { code: 'WORLD_SERVICE_WORKER_EXITED' });
  const unconfirmed = await createRuntimeWorker({}, () => new Worker(initial + "report('ready'); parentPort.on('message', () => { parentPort.postMessage({ type:'stopped', ok:false }); parentPort.close(); });", { eval: true }));
  await assert.rejects(unconfirmed.close(), { code: 'WORLD_SERVICE_WORKER_EXITED' });
  console.log('runtime worker controller test passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
