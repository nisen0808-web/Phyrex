'use strict';

const assert = require('assert');
const { createWorld, registerEntity, registerLocation } = require('../core/world-engine');
const { initializeSimulation, runSimulationTicks, getSimulationSummary } = require('../core/simulation-engine');
const { assignSpecies } = require('../core/species-engine');
const { createOrganization } = require('../core/organization-engine');
const { createContract, CONTRACT_TYPES } = require('../core/contract-engine');
const { processCityTick } = require('../core/city-engine');
const { getProcessStats } = require('../core/process-engine');

function main() {
  const world = createWorld({ id: 'stability-1000-test-world' });
  registerLocation(world, { id: 'hub', name: 'Hub', resources: { food: 5000, wood: 5000, stone: 5000, metal: 1000 } });
  registerLocation(world, { id: 'field', name: 'Field', resources: { food: 5000, wood: 1000 } });

  for (let i = 0; i < 30; i += 1) {
    registerEntity(world, {
      id: `entity_${i}`,
      name: `Entity ${i}`,
      locationId: i % 2 === 0 ? 'hub' : 'field',
      traits: { ambition: 40 + (i % 50), social: 30 + (i % 40) },
      stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10 + (i % 20), defense: 5, speed: 10, intelligence: 20 + (i % 60), social: 30 + (i % 40) },
      resources: { currency: 200 + i },
      demographics: { age: 20 + (i % 30), generation: 1, sex: i % 2 === 0 ? 'male' : 'female' },
    });
    assignSpecies(world, `entity_${i}`, 'human');
  }

  initializeSimulation(world, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0, baseMortalityChance: 0 },
    city: { minPopulationForSettlement: 1 },
    information: { maxInformationItems: 1000, maxKnownItemsPerOwner: 120 },
    memory: { maxGlobalMemories: 3000, maxMemoriesPerOwner: 50 },
    process: { maxProcesses: 500, maxInactiveProcesses: 150, staleAfterTicks: 120 },
    opportunity: { discoveryChance: 0.01, crisisChance: 0.005, claimChance: 0.2 },
    conflict: { battleChance: 0.01 },
  });

  const org = createOrganization(world, {
    type: 'state',
    name: 'Hub State',
    leaderId: 'entity_0',
    homeLocationId: 'hub',
    currency: 10000,
  });

  for (let i = 1; i < 10; i += 1) {
    if (!org.members.includes(`entity_${i}`)) org.members.push(`entity_${i}`);
  }

  createContract(world, {
    type: CONTRACT_TYPES.EMPLOYMENT,
    controllerId: 'entity_0',
    subjectId: 'entity_1',
    durationTicks: 2000,
  });

  processCityTick(world, { minPopulationForSettlement: 1 });

  runSimulationTicks(world, 1000, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0, baseMortalityChance: 0 },
    city: { minPopulationForSettlement: 1 },
    information: { maxInformationItems: 1000, maxKnownItemsPerOwner: 120 },
    memory: { maxGlobalMemories: 3000, maxMemoriesPerOwner: 50 },
    process: { maxProcesses: 500, maxInactiveProcesses: 150, staleAfterTicks: 120 },
    opportunity: { discoveryChance: 0.01, crisisChance: 0.005, claimChance: 0.2 },
    conflict: { battleChance: 0.01 },
  });

  const summary = getSimulationSummary(world);
  const processStats = getProcessStats(world);
  const informationCount = Object.keys(world.information?.items || {}).length;
  const memoryCount = Object.keys(world.memories?.byId || {}).length;

  assert.strictEqual(world.tick, 1000, 'world should advance exactly 1000 ticks');
  assert.ok(world.simulation.reports.length <= 200, 'simulation reports should be capped at 200');
  assert.ok(world.memory.length <= 1000, 'world memory should be capped at 1000');
  assert.ok(Object.keys(world.processes?.byId || {}).length <= 500, 'process count should be capped at 500');
  assert.ok(processStats.total <= 500, 'process stats should respect process cap');
  assert.ok(informationCount <= 1000, 'information items should be capped at 1000');
  assert.ok(memoryCount <= 3000, 'memory byId should be capped at 3000');
  assert.ok(summary.counters.ticks >= 1000, 'simulation counters should count ticks');
  assert.ok(world.economy?.markets?.global, 'economy should remain available');
  assert.ok(world.cities?.byId && Object.keys(world.cities.byId).length >= 1, 'cities should remain available');
  assert.ok(world.civilizations?.byId && Object.keys(world.civilizations.byId).length >= 1, 'civilizations should remain available');

  console.log('1000 tick stability test passed');
}

main();
