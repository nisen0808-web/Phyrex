'use strict';

const assert = require('assert');
const {
  createWorld,
  registerLocation,
  registerEntity,
} = require('../core/world-engine');
const { assignSpecies } = require('../core/species-engine');
const {
  KERNEL_PIPELINES,
  createDeterministicSimulationKernel,
  registerKernelSystem,
  initializeDeterministicSimulation,
  runDeterministicSimulationTick,
  getDeterministicSimulationSummary,
} = require('../core/deterministic-simulation-engine');
const {
  SIMULATION_PIPELINE_PHASES,
  createSimulationPipelineRegistry,
  getSimulationPipelineSummary,
} = require('../core/simulation-pipeline-engine');

function main() {
  const registry = createSimulationPipelineRegistry();
  const pipeline = getSimulationPipelineSummary(registry);
  assert.strictEqual(pipeline.version, 1);
  assert.deepStrictEqual(pipeline.phases, SIMULATION_PIPELINE_PHASES);
  assert.strictEqual(pipeline.systems, 28, 'pipeline should expose every simulation subsystem');
  assert.strictEqual(pipeline.order[0], 'population.lifecycle');
  assert.ok(pipeline.order.includes('world.advance'));
  assert.ok(pipeline.order.includes('finalize.report'));
  assert.ok(pipeline.order.indexOf('agency.planning') < pipeline.order.indexOf('world.advance'));
  assert.ok(pipeline.order.indexOf('world.advance') < pipeline.order.indexOf('knowledge.information'));
  assert.ok(pipeline.order.indexOf('civilization.governance') < pipeline.order.indexOf('civilization.conflict'));
  assert.ok(pipeline.order.indexOf('finalize.history') < pipeline.order.indexOf('finalize.report'));

  const world = buildPipelineWorld('modular-world');
  const kernel = createDeterministicSimulationKernel();
  assert.strictEqual(kernel.pipeline, KERNEL_PIPELINES.MODULAR);
  assert.strictEqual(kernel.options.contractPolicy, 'error');
  assert.strictEqual(kernel.contractAttachment.attached.length, 28);
  assert.deepStrictEqual(kernel.contractAttachment.missingContracts, []);
  assert.strictEqual(kernel.contractAttachment.coverage, 1);

  registerKernelSystem(kernel, {
    id: 'test.before',
    phase: 'before',
    writes: ['test.before'],
    contract: {
      inputs: [
        { path: 'world.tick', schema: { type: 'integer', minimum: 0 } },
      ],
      output: {
        type: 'object',
        required: ['tick'],
        properties: { tick: { type: 'integer', minimum: 0 } },
      },
      postconditions: [
        { path: 'world.test.order', schema: { type: 'array', minItems: 1 } },
      ],
    },
    run(context) {
      if (!context.world.test) context.world.test = { order: [] };
      context.world.test.order.push('before');
      return { tick: context.tick };
    },
  });
  registerKernelSystem(kernel, {
    id: 'test.after',
    phase: 'after',
    writes: ['test.after'],
    run(context) {
      context.world.test.order.push('after');
      return { tick: context.world.tick };
    },
  });

  const report = runDeterministicSimulationTick(world, {
    simulation: disabledSimulationOptions(),
  }, kernel);
  assert.strictEqual(world.tick, 1);
  assert.strictEqual(report.tickBefore, 0);
  assert.strictEqual(report.tickAfter, 1);
  assert.ok(report.world, 'world advance system should produce a report');
  assert.strictEqual(report.population, null, 'disabled subsystem should remain absent');
  assert.deepStrictEqual(world.test.order, ['before', 'after']);
  assert.strictEqual(report.kernel.pipeline, 'modular');
  assert.strictEqual(report.kernel.completed, 4, 'before, advance, finalize and after should complete');
  assert.strictEqual(report.kernel.skipped, 26, 'disabled simulation systems should be skipped');
  assert.ok(report.kernel.order.indexOf('test.before') < report.kernel.order.indexOf('world.advance'));
  assert.ok(report.kernel.order.indexOf('finalize.report') < report.kernel.order.indexOf('test.after'));
  assert.deepStrictEqual(report.kernel.contracts, {
    policy: 'error',
    validations: 9,
    violations: 0,
    warnings: 0,
    failures: 0,
  });

  const summary = getDeterministicSimulationSummary(world, kernel);
  assert.strictEqual(summary.pipeline, 'modular');
  assert.strictEqual(summary.modularPipeline.systems, 30, 'summary should include custom systems');
  assert.strictEqual(summary.contractCoverage.systems, 30);
  assert.strictEqual(summary.contractCoverage.contracted, 29);
  assert.strictEqual(summary.contractCoverage.uncontracted, 1);
  assert.deepStrictEqual(summary.contractCoverage.uncontractedIds, ['test.after']);
  assert.strictEqual(summary.contracts.validations, 9);
  assert.strictEqual(summary.contracts.violations, 0);
  const advanceStats = summary.scheduler.systems.find(system => system.id === 'world.advance');
  const populationStats = summary.scheduler.systems.find(system => system.id === 'population.lifecycle');
  assert.strictEqual(advanceStats.runs, 1);
  assert.strictEqual(populationStats.skips, 1);
  assert.strictEqual(world.simulation.counters.ticks, 1);
  assert.strictEqual(world.simulation.lastTickReport.tickAfter, 1);

  const warningWorld = buildPipelineWorld('warning-world');
  const warningKernel = createDeterministicSimulationKernel({ contractPolicy: 'warn' });
  assert.strictEqual(warningKernel.options.contractPolicy, 'warn');
  const warningReport = runDeterministicSimulationTick(warningWorld, {
    simulation: disabledSimulationOptions(),
  }, warningKernel);
  assert.strictEqual(warningReport.kernel.contracts.policy, 'warn');
  assert.strictEqual(warningReport.kernel.contracts.violations, 0);

  const legacyWorld = buildPipelineWorld('legacy-world');
  const legacyKernel = createDeterministicSimulationKernel({ pipeline: 'legacy' });
  const legacyReport = runDeterministicSimulationTick(legacyWorld, {
    simulation: disabledSimulationOptions(),
  }, legacyKernel);
  assert.strictEqual(legacyKernel.pipeline, KERNEL_PIPELINES.LEGACY);
  assert.strictEqual(legacyWorld.tick, 1);
  assert.strictEqual(legacyReport.kernel.order.includes('world.simulation'), true);
  assert.strictEqual(legacyReport.kernel.pipeline, 'legacy');
  assert.strictEqual(legacyReport.kernel.contracts, null);

  assert.throws(
    () => createDeterministicSimulationKernel({ pipeline: 'unknown' }),
    /Unsupported deterministic simulation pipeline/,
  );
  assert.throws(
    () => createDeterministicSimulationKernel({ contractPolicy: 'unknown' }),
    /Unsupported system contract policy/,
  );

  console.log('modular simulation pipeline test passed');
}

function buildPipelineWorld(id) {
  const world = createWorld({ id, seed: 'modular-pipeline-seed' });
  registerLocation(world, {
    id: 'origin',
    name: 'Origin',
    resources: { food: 500, wood: 500 },
  });
  const entity = registerEntity(world, {
    id: `${id}_entity`,
    name: 'Pipeline Entity',
    locationId: 'origin',
    stats: {
      health: 100,
      maxHealth: 100,
      energy: 100,
      maxEnergy: 100,
      power: 10,
      social: 50,
    },
    demographics: {
      birthTick: -20,
      age: 20,
      ageGroup: 'adult',
      sex: 'female',
      fertility: 1,
      lifeExpectancy: 80,
      generation: 1,
    },
  });
  assignSpecies(world, entity.id, 'human');
  initializeDeterministicSimulation(world, disabledSimulationOptions());
  return world;
}

function disabledSimulationOptions() {
  return {
    autoPlanActions: false,
    autoPopulation: false,
    autoFamilies: false,
    autoLegacy: false,
    autoContracts: false,
    autoOrganizations: false,
    autoEconomy: false,
    autoCity: false,
    autoIdentity: false,
    autoDesire: false,
    autoOpportunity: false,
    autoInformation: false,
    autoMemory: false,
    autoCulture: false,
    autoReligion: false,
    autoCivilization: false,
    autoTechnology: false,
    autoInfrastructure: false,
    autoGovernance: false,
    autoProcess: false,
    autoEmergence: false,
    autoConflict: false,
    autoPlayers: false,
    autoHistory: false,
    autoNarrative: false,
    autoNovel: false,
  };
}

main();
