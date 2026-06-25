'use strict';

const engineState = require('./engine-state-engine');
const random = require('./deterministic-rng-engine');
const trace = require('./engine-trace-engine');
const scheduler = require('./system-scheduler-engine');
const hashing = require('./world-state-hash-engine');
const integrity = require('./world-integrity-engine');
const replay = require('./replay-engine');

function initializeEngineKernel(world, options = {}) {
  engineState.ensureEngineState(world);
  random.ensureRandomState(world, options.random || {});
  trace.ensureTraceState(world, options.trace || {});
  scheduler.ensureSchedulerState(world, options.scheduler || {});
  replay.ensureReplayState(world);
  if (options.validate) integrity.assertWorldIntegrity(world, options.integrity || {});
  return getEngineKernelSummary(world);
}

function getEngineKernelSummary(world) {
  return {
    engine: engineState.getEngineStateSummary(world),
    random: random.getRandomSummary(world),
    trace: trace.getTraceSummary(world),
    scheduler: scheduler.getSchedulerSummary(world),
    replay: replay.getReplaySummary(world),
    integrity: integrity.validateWorldState(world),
    simulationHash: hashing.hashSimulationState(world),
  };
}

module.exports = {
  initializeEngineKernel,
  getEngineKernelSummary,
  ...engineState,
  ...random,
  ...trace,
  ...scheduler,
  ...hashing,
  ...integrity,
  ...replay,
};
