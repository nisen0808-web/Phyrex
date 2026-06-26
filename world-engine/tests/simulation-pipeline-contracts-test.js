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
  createSimulationSystemContracts,
  attachSimulationSystemContracts,
  getSimulationContractCoverage,
} = require('../core/simulation-system-contracts-engine');
const {
  analyzeContractCoverage,
  getSystemContractSummary,
} = require('../core/system-contract-engine');

function main() {
  const world = buildWorld();
  const kernel = createDeterministicSimulationKernel();
  const contracts = createSimulationSystemContracts();

  assert.strictEqual(Object.keys(contracts).length, 30, 'every built-in, natural and ecology system should receive a contract');
  assert.ok(contracts['natural.world']);
  assert.ok(contracts['ecology.world']);
  assert.ok(contracts['population.lifecycle']);
  assert.ok(contracts['world.advance']);
  assert.ok(contracts['finalize.report']);
  assert.ok(contracts['world.advance'].postconditions.some(rule => rule.path === 'world.tick'));
  assert.ok(contracts['finalize.report'].postconditions.some(rule => rule.path === 'world.simulation.lastTickReport'));

  const coverage = getSimulationContractCoverage(kernel.registry);
  assert.strictEqual(coverage.systems, 30);
  assert.strictEqual(coverage.contracted, 30, 'kernel should attach contracts by default');
  assert.strictEqual(coverage.uncontracted, 0);
  assert.strictEqual(coverage.coverage, 1);
  assert.strictEqual(analyzeContractCoverage(kernel.registry).uncontracted, 0);

  const attachment = attachSimulationSystemContracts(kernel.registry, { policy: 'error' });
  assert.strictEqual(attachment.version, 1);
  assert.strictEqual(attachment.attached.length, 30);
  assert.strictEqual(attachment.missingContracts.length, 0);

  const report = runDeterministicSimulationTick(world, {
    simulation: disabledSimulationOptions(),
    scheduler: { recordResults: true },
  }, kernel);

  assert.strictEqual(report.kernel.pipeline, 'modular');
  assert.strictEqual(report.tickAfter, 1);
  assert.ok(report.natural);
  assert.ok(report.ecology);
  assert.strictEqual(report.kernel.contracts.policy, 'error');
  assert.strictEqual(report.kernel.contracts.violations, 0);
  const naturalEntry = report.kernel.order.indexOf('natural.world');
  const ecologyEntry = report.kernel.order.indexOf('ecology.world');
  const advanceEntry = report.kernel.order.indexOf('world.advance');
  const finalizeEntry = report.kernel.order.indexOf('finalize.report');
  assert.ok(naturalEntry >= 0);
  assert.ok(ecologyEntry > naturalEntry);
  assert.ok(advanceEntry > ecologyEntry);
  assert.ok(finalizeEntry > advanceEntry);

  const completedContracts = world.kernel.lastReport.systems
    .filter(entry => entry.status === 'completed')
    .map(entry => entry.id);
  assert.ok(completedContracts.includes('natural.world'));
  assert.ok(completedContracts.includes('ecology.world'));
  assert.ok(completedContracts.includes('world.advance'));
  assert.ok(completedContracts.includes('finalize.report'));

  const summary = getSystemContractSummary(world);
  assert.ok(summary.validations >= 11, 'completed systems should validate input, output and postconditions');
  assert.strictEqual(summary.violations, 0);
  assert.ok(summary.systems.some(system => system.id === 'natural.world'));
  assert.ok(summary.systems.some(system => system.id === 'ecology.world'));
  assert.ok(summary.systems.some(system => system.id === 'world.advance'));
  assert.ok(summary.systems.some(system => system.id === 'finalize.report'));

  const disabledWorld = buildWorld('disabled-contract-world');
  const disabledKernel = createDeterministicSimulationKernel({ contractPolicy: 'off' });
  runDeterministicSimulationTick(disabledWorld, {
    simulation: disabledSimulationOptions(),
  }, disabledKernel);
  const disabledSummary = getSystemContractSummary(disabledWorld);
  assert.strictEqual(disabledSummary.validations, 0, 'off policy should skip contract validation bookkeeping');

  console.log('simulation pipeline contracts test passed');
}

function buildWorld(id = 'contract-pipeline-world') {
  const world = createWorld({ id, seed: 'contract-pipeline-seed' });
  registerLocation(world, {
    id: 'origin',
    name: 'Origin',
    resources: { food: 100, water: 100, wood: 100 },
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
    natural: { disasterChance: 0 },
    ecology: { baseDiseaseRisk: 0 },
  };
}

main();
