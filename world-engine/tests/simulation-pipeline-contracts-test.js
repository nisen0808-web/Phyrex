'use strict';

const assert = require('assert');
const {
  createWorld,
  registerLocation,
  registerEntity,
} = require('../core/world-engine');
const { assignSpecies } = require('../core/species-engine');
const {
  createDeterministicSimulationKernel,
  initializeDeterministicSimulation,
  runDeterministicSimulationTick,
} = require('../core/deterministic-simulation-engine');
const {
  createSimulationPipelineContracts,
  attachSimulationPipelineContracts,
  createContractForSystem,
  SYSTEM_OUTPUT_SCHEMAS,
} = require('../core/simulation-pipeline-contracts-engine');
const {
  analyzeContractCoverage,
  getSystemContractSummary,
} = require('../core/system-contract-engine');

function main() {
  const world = buildWorld();
  const kernel = createDeterministicSimulationKernel();
  const contracts = createSimulationPipelineContracts(kernel.registry);

  assert.strictEqual(Object.keys(contracts).length, 28, 'every built-in pipeline system should receive a contract');
  assert.ok(contracts['population.lifecycle']);
  assert.ok(contracts['world.advance']);
  assert.ok(contracts['finalize.report']);
  assert.strictEqual(SYSTEM_OUTPUT_SCHEMAS['agency.planning'].type, 'array');

  const advanceContract = createContractForSystem(kernel.registry.systems['world.advance']);
  assert.ok(advanceContract.inputs.some(rule => rule.path === 'world.actions'));
  assert.ok(advanceContract.postconditions.some(rule => rule.path === 'world.tick'));

  const attachment = attachSimulationPipelineContracts(kernel.registry, { policy: 'error' });
  assert.strictEqual(attachment.version, 1);
  assert.strictEqual(attachment.attached.length, 28);
  assert.strictEqual(attachment.missingContracts.length, 0);
  assert.strictEqual(attachment.summary.coverage, 1);
  assert.strictEqual(analyzeContractCoverage(kernel.registry).uncontracted, 0);

  const report = runDeterministicSimulationTick(world, {
    simulation: disabledSimulationOptions(),
    scheduler: { recordResults: true },
  }, kernel);

  assert.strictEqual(report.kernel.pipeline, 'modular');
  assert.strictEqual(report.tickAfter, 1);
  const advanceEntry = report.kernel.order.indexOf('world.advance');
  const finalizeEntry = report.kernel.order.indexOf('finalize.report');
  assert.ok(advanceEntry >= 0);
  assert.ok(finalizeEntry > advanceEntry);

  const schedule = world.kernel.lastReport;
  const completedContracts = schedule.systems
    .filter(entry => entry.status === 'completed')
    .map(entry => entry.id);
  assert.ok(completedContracts.includes('world.advance'));
  assert.ok(completedContracts.includes('finalize.report'));

  const summary = getSystemContractSummary(world);
  assert.ok(summary.validations >= 6, 'completed systems should validate input, output and postconditions');
  assert.strictEqual(summary.violations, 0);
  assert.ok(summary.systems.some(system => system.id === 'world.advance'));
  assert.ok(summary.systems.some(system => system.id === 'finalize.report'));

  const warningWorld = buildWorld('warning-world');
  const warningKernel = createDeterministicSimulationKernel();
  attachSimulationPipelineContracts(warningKernel.registry, {
    policy: 'warn',
    contracts: {
      ...createSimulationPipelineContracts(warningKernel.registry),
      'finalize.report': {
        output: { type: 'object', required: ['missingField'] },
      },
    },
  });
  runDeterministicSimulationTick(warningWorld, {
    simulation: disabledSimulationOptions(),
  }, warningKernel);
  const warningSummary = getSystemContractSummary(warningWorld);
  assert.ok(warningSummary.warnings >= 1, 'warn policy should record contract warnings');
  assert.strictEqual(warningSummary.failures, 0, 'warn policy should not fail the schedule');

  console.log('simulation pipeline contracts test passed');
}

function buildWorld(id = 'contract-pipeline-world') {
  const world = createWorld({ id, seed: 'contract-pipeline-seed' });
  registerLocation(world, {
    id: 'origin',
    name: 'Origin',
    resources: { food: 100, wood: 100 },
  });
  const entity = registerEntity(world, {
    id: `${id}_entity`,
    name: 'Contract Entity',
    locationId: 'origin',
    stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10 },
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
