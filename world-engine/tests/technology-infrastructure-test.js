'use strict';

const assert = require('assert');
const { createWorld, registerEntity, registerLocation } = require('../core/world-engine');
const { initializeSimulation, runSimulationTicks, getSimulationSummary } = require('../core/simulation-engine');
const { assignSpecies } = require('../core/species-engine');
const { createOrganization } = require('../core/organization-engine');
const { processCityTick } = require('../core/city-engine');
const { getTechnologyStats, getCivilizationTechnologies } = require('../core/technology-engine');
const { createInfrastructure, INFRASTRUCTURE_TYPES, getInfrastructureStats, getCityInfrastructure } = require('../core/infrastructure-engine');

function main() {
  const world = createWorld({ id: 'technology-infrastructure-test-world' });
  registerLocation(world, { id: 'academy_city', name: 'Academy City', resources: { food: 1000, wood: 1000, stone: 1000 } });

  for (let i = 0; i < 10; i += 1) {
    registerEntity(world, {
      id: `scholar_${i}`,
      name: `Scholar ${i}`,
      locationId: 'academy_city',
      traits: { ambition: 50, social: 40 },
      stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 8, defense: 5, speed: 10, intelligence: 80, social: 40 },
      resources: { currency: 300 },
    });
    assignSpecies(world, `scholar_${i}`, 'human');
  }

  initializeSimulation(world, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0 },
    city: { minPopulationForSettlement: 1 },
    technology: { passiveResearch: 100, maxResearchPerTick: 200 },
    infrastructure: { autoPlan: true, buildRate: 200 },
    civilization: { minPopulation: 1 },
  });

  const school = createOrganization(world, {
    type: 'school',
    name: 'Academy',
    leaderId: 'scholar_0',
    homeLocationId: 'academy_city',
    currency: 5000,
  });
  assert.ok(school.id, 'school organization should be created');

  processCityTick(world, { minPopulationForSettlement: 1 });
  const city = Object.values(world.cities.byId)[0];
  assert.ok(city, 'city should exist');
  city.wealth = 5000;

  const infra = createInfrastructure(world, { cityId: city.id, type: INFRASTRUCTURE_TYPES.SCHOOL, progress: 0 });
  assert.ok(infra.id, 'infrastructure should be created');

  const reports = runSimulationTicks(world, 5, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0 },
    city: { minPopulationForSettlement: 1 },
    technology: { passiveResearch: 100, maxResearchPerTick: 200 },
    infrastructure: { autoPlan: true, buildRate: 200 },
    civilization: { minPopulation: 1 },
  });

  assert.strictEqual(reports.length, 5, 'simulation should return reports');
  assert.ok(reports.every(report => report.technologies), 'technology tick should run');
  assert.ok(reports.every(report => report.infrastructure), 'infrastructure tick should run');

  const techStats = getTechnologyStats(world);
  assert.ok(techStats.definitions >= 1, 'technology definitions should exist');
  assert.ok(techStats.civilizations >= 1, 'civilization technology state should exist');

  const civId = Object.keys(world.civilizations.byId)[0];
  const civTechs = getCivilizationTechnologies(world, civId);
  assert.ok(civTechs.length >= 1, 'civilization technologies should be queryable');

  const infraStats = getInfrastructureStats(world);
  assert.ok(infraStats.total >= 1, 'infrastructure stats should include infrastructure');
  const cityInfra = getCityInfrastructure(world, city.id);
  assert.ok(cityInfra.length >= 1, 'city infrastructure should be queryable');
  assert.ok(cityInfra.some(item => ['active', 'building', 'planned'].includes(item.status)), 'infrastructure should have valid status');

  const summary = getSimulationSummary(world);
  assert.ok(summary.counters.technologiesResearched >= 1 || summary.counters.technologiesInitialized >= 1, 'technology counters should update');
  assert.ok(summary.counters.infrastructurePlanned >= 0, 'infrastructure planned counter should exist');
  assert.ok(summary.counters.infrastructureBuilt >= 0, 'infrastructure built counter should exist');

  console.log('technology-infrastructure integration test passed');
}

main();
