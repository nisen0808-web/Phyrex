'use strict';

const assert = require('assert');
const { createWorld, registerEntity, registerLocation } = require('../core/world-engine');
const { initializeSimulation, runSimulationTicks, getSimulationSummary } = require('../core/simulation-engine');
const { assignSpecies } = require('../core/species-engine');
const { createOrganization } = require('../core/organization-engine');
const { processCityTick } = require('../core/city-engine');
const { createProcess, getProcessStats } = require('../core/process-engine');
const { getEmergenceStats } = require('../core/emergence-engine');

function main() {
  const world = createWorld({ id: 'process-emergence-test-world' });
  registerLocation(world, { id: 'capital', name: 'Capital', resources: { food: 1000, wood: 500 } });

  for (let i = 0; i < 60; i += 1) {
    registerEntity(world, {
      id: `citizen_${i}`,
      name: `Citizen ${i}`,
      locationId: 'capital',
      traits: { ambition: 50, social: 50 },
      stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10, defense: 5, speed: 10, intelligence: 10, social: 50 },
      resources: { currency: 20 },
    });
    assignSpecies(world, `citizen_${i}`, 'human');
  }

  initializeSimulation(world, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0 },
    city: { minPopulationForSettlement: 1 },
    emergence: { minCityPopulation: 10, civilizationScoreThreshold: 50 },
  });

  const org = createOrganization(world, {
    type: 'state',
    name: 'Capital State',
    leaderId: 'citizen_0',
    homeLocationId: 'capital',
    currency: 10000,
  });
  assert.ok(org.id, 'organization should exist');

  processCityTick(world, { minPopulationForSettlement: 1 });

  const manualProcess = createProcess(world, {
    type: 'rise',
    title: 'manual rise process',
    ownerType: 'organization',
    ownerId: org.id,
    participants: ['citizen_0'],
  });
  assert.ok(manualProcess.id, 'manual process should be created');

  const reports = runSimulationTicks(world, 5, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0 },
    city: { minPopulationForSettlement: 1 },
    emergence: { minCityPopulation: 10, civilizationScoreThreshold: 50 },
  });

  assert.strictEqual(reports.length, 5, 'simulation should return reports');
  assert.ok(reports.every(report => report.processes), 'process tick should run');
  assert.ok(reports.every(report => report.emergences), 'emergence tick should run');

  const processStats = getProcessStats(world);
  assert.ok(processStats.total >= 1, 'process stats should show processes');

  const emergenceStats = getEmergenceStats(world);
  assert.ok(emergenceStats.total >= 1, 'emergence stats should show detected emergences');

  const summary = getSimulationSummary(world);
  assert.ok(summary.counters.processesUpdated >= 1 || summary.counters.processesCreated >= 1, 'process counters should update');
  assert.ok(summary.counters.emergencesDetected >= 1, 'emergence detection should be counted');

  console.log('process-emergence integration test passed');
}

main();
