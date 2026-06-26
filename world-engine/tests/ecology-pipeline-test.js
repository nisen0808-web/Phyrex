'use strict';

const assert = require('assert');
const { createWorld, registerLocation, connectLocations, registerEntity } = require('../core/world-engine');
const { assignSpecies } = require('../core/species-engine');
const {
  createDeterministicSimulationKernel,
  initializeDeterministicSimulation,
  runDeterministicSimulationTick,
  getDeterministicSimulationSummary,
} = require('../core/deterministic-simulation-engine');
const { getEcologySummary } = require('../core/ecology-engine');
const { hashWorldState } = require('../core/state-integrity-engine');

function main() {
  const first = buildWorld('ecology-pipeline');
  const second = buildWorld('ecology-pipeline');
  const firstKernel = createDeterministicSimulationKernel();
  const secondKernel = createDeterministicSimulationKernel();
  const options = { simulation: disabledOptions() };
  initializeDeterministicSimulation(first, disabledOptions());
  initializeDeterministicSimulation(second, disabledOptions());

  for (let index = 0; index < 6; index += 1) {
    const firstReport = runDeterministicSimulationTick(first, options, firstKernel);
    const secondReport = runDeterministicSimulationTick(second, options, secondKernel);
    assert.ok(firstReport.kernel.order.indexOf('natural.world') < firstReport.kernel.order.indexOf('ecology.world'));
    assert.ok(firstReport.kernel.order.indexOf('ecology.world') < firstReport.kernel.order.indexOf('world.advance'));
    assert.ok(firstReport.ecology.habitats);
    assert.ok(secondReport.ecology.habitats);
    assert.strictEqual(hashWorldState(first), hashWorldState(second));
  }

  const summary = getEcologySummary(first);
  assert.ok(summary.habitats.locations >= 3);
  assert.ok(summary.populations.populations > 0);
  assert.strictEqual(first.simulation.counters.ecologyTicks, 6);

  const kernelSummary = getDeterministicSimulationSummary(first, firstKernel);
  assert.ok(kernelSummary.registry.order.includes('ecology.world'));
  assert.strictEqual(kernelSummary.contractCoverage.uncontracted, 0);

  const noEcologyWorld = buildWorld('no-ecology-world');
  const noEcologyKernel = createDeterministicSimulationKernel({ includeEcologyWorld: false });
  initializeDeterministicSimulation(noEcologyWorld, disabledOptions());
  const report = runDeterministicSimulationTick(noEcologyWorld, options, noEcologyKernel);
  assert.strictEqual(report.ecology, undefined);
  assert.strictEqual(noEcologyKernel.registry.systems['ecology.world'], undefined);

  console.log('ecology pipeline test passed');
}

function buildWorld(id) {
  const world = createWorld({ id, seed: 'ecology-pipeline-seed' });
  registerLocation(world, { id: 'forest', name: 'Old Forest', resources: { food: 180, water: 160, wood: 100, herbs: 40 } });
  registerLocation(world, { id: 'plains', name: 'Green Plains', resources: { food: 150, water: 120, herbs: 20 } });
  registerLocation(world, { id: 'desert', name: 'Red Desert', resources: { food: 20, water: 15, stone: 120, ore: 60 } });
  connectLocations(world, 'forest', 'plains');
  connectLocations(world, 'plains', 'desert');
  const human = registerEntity(world, {
    id: `${id}_human`,
    name: 'Ecology Human',
    locationId: 'forest',
    stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10 },
  });
  assignSpecies(world, human.id, 'human');
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
    ecology: { baseDiseaseRisk: 0.02 },
    natural: { disasterChance: 0 },
  };
}

main();
