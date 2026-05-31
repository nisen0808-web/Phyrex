'use strict';

const assert = require('assert');
const { createWorld, registerEntity, registerLocation } = require('../core/world-engine');
const { initializeSimulation, runSimulationTicks, getSimulationSummary } = require('../core/simulation-engine');
const { assignSpecies } = require('../core/species-engine');
const { syncFamiliesFromPopulation } = require('../core/family-engine');
const { createOrganization } = require('../core/organization-engine');
const { createReligion, getReligionStats } = require('../core/religion-engine');
const { getCivilizationStats, getCivilizationChronicle } = require('../core/civilization-engine');

function main() {
  const world = createWorld({ id: 'religion-civilization-test-world' });
  registerLocation(world, { id: 'temple_city', name: 'Temple City', resources: { food: 500 } });

  for (let i = 0; i < 6; i += 1) {
    registerEntity(world, {
      id: `person_${i}`,
      name: `Person ${i}`,
      locationId: 'temple_city',
      traits: { ambition: 50, social: 50 },
      stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10 + i, defense: 5, speed: 10, intelligence: 12, social: 50 },
      resources: { currency: 100 },
    });
    assignSpecies(world, `person_${i}`, 'human');
  }

  initializeSimulation(world, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0 },
    city: { minPopulationForSettlement: 1 },
    civilization: { minPopulation: 1 },
  });

  const familySync = syncFamiliesFromPopulation(world, { createForUnassigned: true });
  assert.ok(familySync.created.length >= 1, 'families should be created');

  const church = createOrganization(world, {
    type: 'church',
    name: 'Temple Order',
    leaderId: 'person_0',
    homeLocationId: 'temple_city',
    currency: 1000,
  });
  assert.ok(church.id, 'church organization should be created');

  const religion = createReligion(world, {
    type: 'deity_worship',
    name: 'Temple Faith',
    originLocationId: 'temple_city',
    organizationIds: [church.id],
    believers: ['person_0', 'person_1'],
    doctrines: ['faith', 'ritual'],
    virtues: ['order'],
  });
  assert.ok(religion.id, 'religion should be created');

  const reports = runSimulationTicks(world, 5, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0 },
    city: { minPopulationForSettlement: 1 },
    civilization: { minPopulation: 1 },
  });

  assert.strictEqual(reports.length, 5, 'simulation should return reports');
  assert.ok(reports.every(report => report.religions), 'religion tick should run');
  assert.ok(reports.every(report => report.civilizations), 'civilization tick should run');

  const religionStats = getReligionStats(world);
  assert.ok(religionStats.total >= 1, 'religion stats should include at least one religion');
  assert.ok(religionStats.believers >= 2, 'religion should have believers');

  const civStats = getCivilizationStats(world);
  assert.ok(civStats.total >= 1, 'at least one civilization should be created');
  const civId = Object.keys(world.civilizations.byId)[0];
  const chronicle = getCivilizationChronicle(world, civId);
  assert.ok(chronicle.score >= 0, 'civilization chronicle should include score');
  assert.ok(chronicle.metrics.population >= 1, 'civilization should track population');

  const summary = getSimulationSummary(world);
  assert.ok(summary.counters.religionsCreated >= 0, 'religion counter should exist');
  assert.ok(summary.counters.civilizationsCreated >= 1, 'civilization creation should be counted');
  assert.ok(summary.counters.civilizationsUpdated >= 1, 'civilization updates should be counted');

  console.log('religion-civilization integration test passed');
}

main();
