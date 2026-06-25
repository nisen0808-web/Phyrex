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
  createSimulationPipelineRegistry,
  createSimulationFrame,
  getSimulationPipelineSummary,
} = require('./simulation-pipeline-engine');
const {
  attachSimulationSystemContracts,
  getSimulationContractCoverage,
} = require('./simulation-system-contracts-engine');
const {
  attachSystemContract,
  getSystemContractSummary,
  normalizeContractPolicy,
} = require('./system-contract-engine');
const {
  ensureRandomState,
  withDeterministicGlobals,
  getRandomSummary,
} = require('./random-engine');
const { ensureWorldIdState } = require('./world-id-engine');
const { hashWorldState } = require('./state-integrity-engine');

const DETERMINISTIC_KERNEL_VERSION = 1;
const KERNEL_PIPELINES = {
  MODULAR: 'modular',
  LEGACY: 'legacy',
};

function createDeterministicSimulationKernel(options = {}) {
  const pipeline = normalizePipeline(options.pipeline);
  const contractPolicy = normalizeContractPolicy(options.contractPolicy || 'error');
  const registry = pipeline === KERNEL_PIPELINES.LEGACY
    ? createLegacySimulationRegistry(options)
    : createSimulationPipelineRegistry({ phases: options.phases });
  const contractAttachment = pipeline === KERNEL_PIPELINES.MODULAR
    ? attachSimulationSystemContracts(registry, {
      policy: contractPolicy,
      maxViolations: options.maxContractViolations,
      recordValues: options.recordContractValues,
    })
    : null;
  return {
    version: DETERMINISTIC_KERNEL_VERSION,
    pipeline,
    registry,
    contractAttachment,
    options: {
      failurePolicy: options.failurePolicy || 'halt',
      atomic: Boolean(options.atomic),
      recordResults: Boolean(options.recordResults),
      contractPolicy,
    },
  };
}

function createLegacySimulationRegistry(options = {}) {
  const registry = createSystemRegistry({
    phases: options.phases || ['before', 'simulation', 'after'],
  });
  registerSystem(registry, {
    id: 'world.simulation',
    phase: 'simulation',
    priority: 0,
    reads: ['*'],
    writes: ['*'],
    tags: ['simulation', 'legacy'],
    run: context => {
      const report = runSimulationTick(context.world, context.shared.simulationOptions || {});
      context.shared.simulationReport = report;
      return report;
    },
  });
  return registry;
}

function registerKernelSystem(kernel, definition) {
  validateKernel(kernel);
  const system = registerSystem(kernel.registry, definition);
  if (definition?.contract) {
    attachSystemContract(system, definition.contract, {
      policy: definition.contractPolicy || kernel.options.contractPolicy,
      maxViolations: definition.maxContractViolations,
      recordValues: definition.recordContractValues,
    });
  }
  return system;
}

function initializeDeterministicSimulation(world, options = {}) {
  ensureDeterministicWorldState(world);
  return withDeterministicGlobals(world, 'simulation.initialize', () => initializeSimulation(world, options));
}

function runDeterministicSimulationTick(world, options = {}, kernel = null) {
  ensureDeterministicWorldState(world);
  const activeKernel = kernel || createDeterministicSimulationKernel(options.kernel || {});
  validateKernel(activeKernel);
  const simulationOptions = options.simulation || options;
  const tick = Number(world.tick || 0);
  const shared = {
    simulationOptions,
    simulationReport: null,
    simulationFrame: activeKernel.pipeline === KERNEL_PIPELINES.MODULAR
      ? createSimulationFrame(world, simulationOptions)
      : null,
    metadata: { ...(options.metadata || {}) },
  };
  const schedule = runSystemSchedule(world, activeKernel.registry, {
    ...activeKernel.options,
    ...(options.scheduler || {}),
    tick,
    targetTick: tick + 1,
    shared,
  });
  if (!shared.simulationReport) {
    throw new Error(`Deterministic ${activeKernel.pipeline} pipeline did not finalize a simulation report`);
  }
  const contractSummary = activeKernel.pipeline === KERNEL_PIPELINES.MODULAR
    ? getSystemContractSummary(world)
    : null;
  shared.simulationReport.kernel = {
    version: activeKernel.version,
    pipeline: activeKernel.pipeline,
    scheduleId: schedule.id,
    completed: schedule.completed,
    skipped: schedule.skipped,
    failed: schedule.failed,
    order: schedule.systems.map(system => system.id),
    contracts: contractSummary ? {
      policy: activeKernel.options.contractPolicy,
      validations: contractSummary.validations,
      violations: contractSummary.violations,
      warnings: contractSummary.warnings,
      failures: contractSummary.failures,
    } : null,
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
    contracts: getSystemContractSummary(world),
    pipeline: kernel?.pipeline || null,
    registry: kernel ? analyzeSystemRegistry(kernel.registry) : null,
    contractCoverage: kernel ? getSimulationContractCoverage(kernel.registry) : null,
    modularPipeline: kernel?.pipeline === KERNEL_PIPELINES.MODULAR
      ? getSimulationPipelineSummary(kernel.registry)
      : null,
    worldDigest: hashWorldState(world),
  };
}

function ensureDeterministicWorldState(world) {
  ensureRandomState(world);
  ensureWorldIdState(world);
  return world;
}

function normalizePipeline(value) {
  if (value === undefined || value === null || value === '') return KERNEL_PIPELINES.MODULAR;
  const pipeline = String(value).trim().toLowerCase();
  if (!Object.values(KERNEL_PIPELINES).includes(pipeline)) {
    throw new Error(`Unsupported deterministic simulation pipeline ${pipeline}`);
  }
  return pipeline;
}

function validateKernel(kernel) {
  if (!kernel || kernel.version !== DETERMINISTIC_KERNEL_VERSION || !kernel.registry) {
    throw new Error('Invalid deterministic simulation kernel');
  }
  kernel.pipeline = normalizePipeline(kernel.pipeline || KERNEL_PIPELINES.LEGACY);
  kernel.options.contractPolicy = normalizeContractPolicy(kernel.options.contractPolicy || 'error');
  return kernel;
}

module.exports = {
  DETERMINISTIC_KERNEL_VERSION,
  KERNEL_PIPELINES,
  createDeterministicSimulationKernel,
  createLegacySimulationRegistry,
  registerKernelSystem,
  initializeDeterministicSimulation,
  runDeterministicSimulationTick,
  runDeterministicSimulationTicks,
  getDeterministicSimulationSummary,
  ensureDeterministicWorldState,
  normalizePipeline,
};
