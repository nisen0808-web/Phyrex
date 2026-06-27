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
const { getNaturalWorldSummary } = require('../core/natural-world-engine');
const { hashWorldState } = require('../core/state-integrity-engine');

function main() {
  const first = buildWorld('natural-pipeline-a');
  const second = buildWorld('natural-pipeline-a');
  const firstKernel = createDeterministicSimulationKernel();
  const secondKernel = createDeterministicSimulationKernel();
  const options = { simulation: disabledOptions() };

  initializeDeterministicSimulation(first, disabledOptions());
  initializeDeterministicSimulation(second, disabledOptions());

  for (let index = 0; index < 8; index += 1) {
    const firstReport = runDeterministicSimulationTick(first, options, firstKernel);
    const secondReport = runDeterministicSimulationTick(second, options, secondKernel);
    assert.strictEqual(firstReport.kernel.order[0], 'natural.world');
    assert.strictEqual(firstReport.kernel.order[1], 'ecology.world');
    assert.strictEqual(secondReport.kernel.order[0], 'natural.world');
    assert.strictEqual(secondReport.kernel.order[1], 'ecology.world');
    assert.ok(firstReport.natural.calendar);
    assert.ok(firstReport.ecology.habitats);
    assert.ok(firstReport.consistency);
    assert.strictEqual(hashWorldState(first), hashWorldState(second));
  }

  const summary = getNaturalWorldSummary(first);
  assert.strictEqual(summary.weather.updated, 3);
  assert.ok(summary.resources.regenerated.food >= 0);
  assert.strictEqual(first.simulation.counters.naturalTicks, 8);
  assert.strictEqual(first.simulation.counters.ecologyTicks, 8);
  assert.strictEqual(first.simulation.counters.consistencyChecks, 8);

  const kernelSummary = getDeterministicSimulationSummary(first, firstKernel);
  assert.ok(kernelSummary.registry.order.includes('natural.world'));
  assert.ok(kernelSummary.registry.order.includes('ecology.world'));
  assert.ok(kernelSummary.registry.order.includes('world.consistency'));
  assert.strictEqual(kernelSummary.contractCoverage.systems, 31);
  assert.strictEqual(kernelSummary.contractCoverage.uncontracted, 0);

  console.log('natural world pipeline test passed');
}

function buildWorld(id) {
  const world = createWorld({ id, seed: 'natural-pipeline-seed' });
  registerLocation(world, { id: 'forest', name: 'Old Forest', biome: 'forest', resources: { food: 80, water: 120, wood: 100, herbs: 20 } });
  registerLocation(world, { id: 'desert', name: 'Red Desert', biome: 'desert', resources: { food: 5, water: 4, stone: 60, ore: 20 } });
  registerLocation(world, { id: 'coast', name: 'West Coast', biome: 'coast', resources: { food: 60, water: 100, salt: 40 } });
  const entity = registerEntity(world, {
    id: `${id}_entity`,
    name: 'Natural Pipeline Entity',
    locationId: 'forest',
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
    natural: { disasterChance: 0.05 },
    ecology: { baseDiseaseRisk: 0.02 },
    consistency: { repair: true },
  };
}

main();
