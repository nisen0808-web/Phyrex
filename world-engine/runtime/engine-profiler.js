'use strict';
// Operational diagnostics stay outside deterministic core state. Timings are
// never supplied to simulation decisions, schedule reports or persisted worlds.
const { performance } = require('node:perf_hooks');
const { detachedJson, digest } = require('../storage/postgres/codec');
const { canonicalizeWorldInPlace } = require('./canonical-world');
const { advanceDeterministicBatch } = require('./durable-world-runtime');
const { createCultureBeliefFlowDeterministicKernel, runDeterministicSimulationTickWithCultureBeliefFlow } = require('../core/culture-belief-flow-runtime-engine');

function boundedInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid profile ' + name);
  return value;
}
function summarizeWorld(world) {
  const entities = Object.values(world.entities || {});
  return { tick: world.tick, entities: entities.length, alive: entities.filter(entity => entity.status === 'alive').length,
    bytes: Buffer.byteLength(JSON.stringify(world)), digest: digest(world) };
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { minMs: sorted[0], medianMs: sorted[Math.ceil(sorted.length / 2) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted[sorted.length - 1] };
}
function profileEngineWorld(input, options = {}) {
  const ticks = boundedInteger(options.ticks ?? 10, 'ticks', 1, 1000);
  const warmup = boundedInteger(options.warmup ?? 0, 'warmup', 0, 1000);
  const simulation = detachedJson(options.simulation || {});
  if (!simulation || typeof simulation !== 'object' || Array.isArray(simulation)) throw new Error('Invalid profile simulation');
  const world = detachedJson(input);
  const warmupStarted = performance.now();
  if (warmup) advanceDeterministicBatch(world, warmup, simulation);
  const warmupMs = performance.now() - warmupStarted;
  const start = summarizeWorld(world);
  const kernel = createCultureBeliefFlowDeterministicKernel();
  const systems = [];
  let systemMs = 0;
  for (const system of Object.values(kernel.registry.systems)) {
    const row = { id: system.id, phase: system.phase, calls: 0, failures: 0, totalMs: 0, maxMs: 0 };
    systems.push(row);
    const original = system.run;
    system.run = function (context) {
      const started = performance.now();
      row.calls++;
      try { return original.call(this, context); }
      catch (error) { row.failures++; throw error; }
      finally {
        const elapsed = performance.now() - started;
        row.totalMs += elapsed; row.maxMs = Math.max(row.maxMs, elapsed); systemMs += elapsed;
      }
    };
  }
  const samples = [];
  const started = performance.now();
  for (let index = 0; index < ticks; index++) {
    const beforeSystems = systemMs, tickStarted = performance.now();
    canonicalizeWorldInPlace(world);
    const normalized = performance.now();
    const result = runDeterministicSimulationTickWithCultureBeliefFlow(world, simulation, kernel);
    const finished = performance.now();
    if (!result.kernel || result.kernel.failed !== 0) throw new Error('Profile simulation failed');
    const simulationMs = finished - normalized, systemsMs = systemMs - beforeSystems;
    samples.push({ tick: world.tick, totalMs: finished - tickStarted, normalizationMs: normalized - tickStarted,
      simulationMs, systemsMs, schedulerAndIntegrityMs: Math.max(0, simulationMs - systemsMs) });
  }
  const elapsedMs = performance.now() - started;
  const end = summarizeWorld(world);
  const sum = key => samples.reduce((total, sample) => total + sample[key], 0);
  const report = {
    version: 1, mode: 'offline-world-copy', runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
    ticks, warmup, warmupMs, elapsedMs, start, end,
    timing: { ...distribution(samples.map(row => row.totalMs)), normalizationMs: sum('normalizationMs'),
      simulationMs: sum('simulationMs'), systemsMs: sum('systemsMs'), schedulerAndIntegrityMs: sum('schedulerAndIntegrityMs') },
    systems: systems.map(row => ({ ...row, meanMs: row.calls ? row.totalMs / row.calls : 0 }))
      .sort((a, b) => b.totalMs - a.totalMs || a.id.localeCompare(b.id)),
    samples,
  };
  return { report, world };
}
module.exports = { profileEngineWorld };

