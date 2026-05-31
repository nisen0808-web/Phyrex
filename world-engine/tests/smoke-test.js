'use strict';

const assert = require('assert');

const {
  createWorld,
  registerEntity,
  registerLocation,
  connectLocations,
} = require('../core/world-engine');
const { initializeSimulation, runSimulationTicks, getSimulationSummary } = require('../core/simulation-engine');
const { assignSpecies } = require('../core/species-engine');
const { getPopulationStats } = require('../core/population-engine');
const { syncFamiliesFromPopulation } = require('../core/family-engine');
const { createOrganization } = require('../core/organization-engine');
const { seedIndustriesFromOrganizations, processEconomyTick } = require('../core/economy-engine');
const { processCityTick } = require('../core/city-engine');

function main() {
  const world = createWorld({ id: 'smoke-test-world' });

  registerLocation(world, { id: 'village', name: 'Village', resources: { food: 100, wood: 50 } });
  registerLocation(world, { id: 'forest', name: 'Forest', resources: { food: 300, wood: 300 } });
  connectLocations(world, 'village', 'forest');

  const alice = registerEntity(world, {
    id: 'alice',
    name: 'Alice',
    locationId: 'village',
    traits: { ambition: 80, social: 60 },
    stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 20, defense: 5, speed: 10, intelligence: 20, social: 60 },
    resources: { currency: 50 },
    meta: { age: 25 },
  });

  const bob = registerEntity(world, {
    id: 'bob',
    name: 'Bob',
    locationId: 'village',
    traits: { ambition: 50, social: 40 },
    stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 12, defense: 5, speed: 10, intelligence: 12, social: 40 },
    resources: { currency: 20 },
    meta: { age: 26 },
  });

  assignSpecies(world, alice.id, 'human');
  assignSpecies(world, bob.id, 'human');

  initializeSimulation(world, {
    autoNovel: false,
    autoNarrative: false,
    maxActionPlansPerTick: 20,
    population: { baseBirthChance: 0 },
  });

  const familySync = syncFamiliesFromPopulation(world, { createForUnassigned: true });
  assert.ok(familySync.created.length >= 1, 'families should be created for first-generation entities');

  const org = createOrganization(world, {
    type: 'guild',
    leaderId: 'alice',
    homeLocationId: 'village',
    currency: 100,
  });
  assert.ok(org.id, 'organization should be created');

  const industries = seedIndustriesFromOrganizations(world);
  assert.ok(industries.length >= 1, 'organization should seed at least one industry');

  const economyReport = processEconomyTick(world);
  assert.ok(economyReport.markets.global, 'global market snapshot should exist');

  const cityReport = processCityTick(world, { minPopulationForSettlement: 1 });
  assert.ok(cityReport.created.length >= 1 || cityReport.updated.length >= 1, 'settlement should be created or updated');

  const reports = runSimulationTicks(world, 5, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0 },
  });

  assert.strictEqual(reports.length, 5, 'simulation should return one report per tick');
  assert.ok(world.tick >= 5, 'world tick should advance');
  assert.ok(world.memory.length > 0, 'world memory should be populated');
  assert.ok(world.history, 'history state should exist');
  assert.ok(world.simulation, 'simulation state should exist');

  const populationStats = getPopulationStats(world);
  assert.ok(populationStats.alive >= 2, 'initial entities should remain alive in smoke test');

  const summary = getSimulationSummary(world);
  assert.ok(summary.counters.ticks >= 5, 'simulation summary should count ticks');

  console.log('world-engine smoke test passed');
}

main();
