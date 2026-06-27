'use strict';

const assert = require('assert');
const { createWorld, registerLocation, registerEntity } = require('../core/world-engine');
const { assignSpecies } = require('../core/species-engine');
const {
  createDeterministicSimulationKernel,
  initializeDeterministicSimulation,
  runDeterministicSimulationTick,
  getDeterministicSimulationSummary,
} = require('../core/deterministic-simulation-engine');

function main() {
  const world = buildPipelineWorld();
  const kernel = createDeterministicSimulationKernel();
  initializeDeterministicSimulation(world, disabledOptions());
  world.locations.origin.resources.food = -5;
  world.entities.runner.locationId = 'missing';
  world.ecology = { populations: { byKey: { 'missing:human': { locationId: 'missing', speciesId: 'human', population: 5, carryingCapacity: 5 } }, byLocation: { missing: ['human'] } } };

  const report = runDeterministicSimulationTick(world, { simulation: disabledOptions() }, kernel);
  assert.ok(report.consistency);
  assert.ok(report.kernel.order.indexOf('world.consistency') < report.kernel.order.indexOf('finalize.report'));
  assert.ok(report.consistency.repairedCount >= 3, `expected repairs, got ${report.consistency.repairedCount}`);
  assert.strictEqual(world.locations.origin.resources.food, 0);
  assert.strictEqual(world.entities.runner.locationId, 'origin');
  assert.ok(!world.ecology.populations.byKey['missing:human']);
  assert.strictEqual(world.simulation.counters.consistencyChecks, 1);
  assert.ok(world.simulation.counters.consistencyIssues >= 1);
  assert.ok(world.consistency.lastReport);

  const summary = getDeterministicSimulationSummary(world, kernel);
  assert.strictEqual(summary.consistency.stats.checks, 1);
  assert.ok(summary.registry.order.includes('world.consistency'));
  assert.strictEqual(summary.contractCoverage.uncontracted, 0);

  const noConsistencyWorld = buildPipelineWorld('no-consistency-world');
  const noConsistencyKernel = createDeterministicSimulationKernel({ includeConsistencyWorld: false });
  initializeDeterministicSimulation(noConsistencyWorld, disabledOptions());
  const noConsistencyReport = runDeterministicSimulationTick(noConsistencyWorld, { simulation: disabledOptions() }, noConsistencyKernel);
  assert.strictEqual(noConsistencyReport.consistency, undefined);
  assert.strictEqual(noConsistencyKernel.registry.systems['world.consistency'], undefined);

  console.log('world consistency pipeline test passed');
}

function buildPipelineWorld(id = 'consistency-pipeline-world') {
  const world = createWorld({ id, seed: 'consistency-pipeline-seed' });
  registerLocation(world, { id: 'origin', name: 'Origin', resources: { food: 100, water: 100 } });
  const entity = registerEntity(world, {
    id: 'runner',
    name: 'Runner',
    locationId: 'origin',
    stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10 },
    demographics: { birthTick: -20, age: 20, ageGroup: 'adult', sex: 'female', fertility: 1, lifeExpectancy: 80, generation: 1 },
  });
  assignSpecies(world, entity.id, 'human');
  return world;
}

function disabledOptions() {
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
    consistency: { repair: true },
  };
}

main();
