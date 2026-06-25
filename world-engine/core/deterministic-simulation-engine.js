'use strict';

const {
  initializeSimulation,
  runSimulationTick,
  getSimulationSummary,
} = require('./simulation-engine');
const {
  createSystemRegistry,
  registerSystem,
  runSystemSchedule,
  getSchedulerSummary,
  analyzeSystemRegistry,
} = require('./system-scheduler-engine');
const {
  ensureRandomState,
  withDeterministicGlobals,
  getRandomSummary,
} = require('./random-engine');
const { ensureWorldIdState } = require('./world-id-engine');
const { hashWorldState } = require('./state-integrity-engine');

const DETERMINISTIC_KERNEL_VERSION = 1;

function createDeterministicSimulationKernel(options = {}) {
  const registry = createSystemRegistry({
    phases: options.phases || ['before', 'simulation', 'after'],
  });
  registerSystem(registry, {
    id: 'world.simulation',
    phase: 'simulation',
    priority: 0,
    reads: ['*'],
    writes: ['*'],
    run: context => {
      const report = runSimulationTick(context.world, context.shared.simulationOptions || {});
      context.shared.simulationReport = report;
      return report;
    },
  });
  return {
    version: DETERMINISTIC_KERNEL_VERSION,
    registry,
    options: {
      failurePolicy: options.failurePolicy || 'halt',
      atomic: Boolean(options.atomic),
      recordResults: Boolean(options.recordResults),
    },
  };
}

function registerKernelSystem(kernel, definition) {
  validateKernel(kernel);
  return registerSystem(kernel.registry, definition);
}

function initializeDeterministicSimulation(world, options = {}) {
  ensureDeterministicWorldState(world);
  return withDeterministicGlobals(world, 'simulation.initialize', () => initializeSimulation(world, options));
}

function runDeterministicSimulationTick(world, options = {}, kernel = null) {
  ensureDeterministicWorldState(world);
  const activeKernel = kernel || createDeterministicSimulationKernel(options.kernel || {});
  validateKernel(activeKernel);
  const shared = {
    simulationOptions: options.simulation || options,
    simulationReport: null,
    metadata: { ...(options.metadata || {}) },
  };
  const schedule = runSystemSchedule(world, activeKernel.registry, {
    ...activeKernel.options,
    ...(options.scheduler || {}),
    tick: Number(world.tick || 0),
    targetTick: Number(world.tick || 0) + 1,
    shared,
  });
  if (!shared.simulationReport) throw new Error('Deterministic kernel did not execute world.simulation');
  shared.simulationReport.kernel = {
    scheduleId: schedule.id,
    completed: schedule.completed,
    skipped: schedule.skipped,
    failed: schedule.failed,
    order: schedule.systems.map(system => system.id),
    worldDigest: hashWorldState(world, options.hashOptions || {}),
  };
  return shared.simulationReport;
}

function runDeterministicSimulationTicks(world, ticks = 1, options = {}, kernel = null) {
  const activeKernel = kernel || createDeterministicSimulationKernel(options.kernel || {});
  const reports = [];
  for (let index = 0; index < Math.max(0, Number(ticks || 0)); index += 1) {
    reports.push(runDeterministicSimulationTick(world, options, activeKernel));
  }
  return reports;
}

function getDeterministicSimulationSummary(world, kernel = null) {
  ensureDeterministicWorldState(world);
  return {
    simulation: getSimulationSummary(world),
    random: getRandomSummary(world),
    scheduler: getSchedulerSummary(world),
    registry: kernel ? analyzeSystemRegistry(kernel.registry) : null,
    worldDigest: hashWorldState(world),
  };
}

function ensureDeterministicWorldState(world) {
  ensureRandomState(world);
  ensureWorldIdState(world);
  return world;
}

function validateKernel(kernel) {
  if (!kernel || kernel.version !== DETERMINISTIC_KERNEL_VERSION || !kernel.registry) {
    throw new Error('Invalid deterministic simulation kernel');
  }
  return kernel;
}

module.exports = {
  DETERMINISTIC_KERNEL_VERSION,
  createDeterministicSimulationKernel,
  registerKernelSystem,
  initializeDeterministicSimulation,
  runDeterministicSimulationTick,
  runDeterministicSimulationTicks,
  getDeterministicSimulationSummary,
  ensureDeterministicWorldState,
};
