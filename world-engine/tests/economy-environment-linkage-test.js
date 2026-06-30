'use strict';

const assert = require('assert');
const { createWorld, registerLocation, registerEntity } = require('../core/world-engine');
const { assignSpecies } = require('../core/species-engine');
const {
  INDUSTRY_STATUS,
  createIndustry,
  processEconomyTick,
  calculateIndustryEnvironment,
  getIndustry,
  getMarket,
} = require('../core/economy-engine');

function main() {
  testEnvironmentRiskCalculation();
  testEconomyTickAppliesEnvironment();
  testDeterministicEconomyIds();
  console.log('economy environment linkage test passed');
}

function testEnvironmentRiskCalculation() {
  const harsh = buildEconomyWorld('harsh-economy');
  applyHarshEnvironment(harsh);
  const harshIndustry = createIndustry(harsh, {
    type: 'agriculture',
    ownerType: 'entity',
    ownerId: 'worker_0',
    locationId: 'origin',
    scale: 2,
    efficiency: 1,
    workforce: ['worker_0', 'worker_1', 'worker_2', 'worker_3'],
  });
  const harshEnvironment = calculateIndustryEnvironment(harsh, harshIndustry);
  assert.ok(harshEnvironment.riskScore > 0.55, `expected high risk, got ${harshEnvironment.riskScore}`);
  assert.ok(harshEnvironment.productionMultiplier < 0.6, `expected production drag, got ${harshEnvironment.productionMultiplier}`);
  assert.ok([INDUSTRY_STATUS.CONSTRAINED, INDUSTRY_STATUS.DECLINING, INDUSTRY_STATUS.STALLED].includes(harshEnvironment.status));

  const calm = buildEconomyWorld('calm-economy');
  applyCalmEnvironment(calm);
  const calmIndustry = createIndustry(calm, {
    type: 'agriculture',
    ownerType: 'entity',
    ownerId: 'worker_0',
    locationId: 'origin',
    scale: 2,
    efficiency: 1,
    workforce: ['worker_0', 'worker_1', 'worker_2', 'worker_3'],
  });
  const calmEnvironment = calculateIndustryEnvironment(calm, calmIndustry);
  assert.ok(calmEnvironment.riskScore < harshEnvironment.riskScore, 'calm industry should have lower risk');
  assert.ok(calmEnvironment.productionMultiplier > harshEnvironment.productionMultiplier, 'calm industry should produce more efficiently');
  assert.strictEqual(calmEnvironment.status, INDUSTRY_STATUS.ACTIVE);
}

function testEconomyTickAppliesEnvironment() {
  const world = buildEconomyWorld('economy-tick');
  applyHarshEnvironment(world);
  const industry = createIndustry(world, {
    type: 'agriculture',
    ownerType: 'entity',
    ownerId: 'worker_0',
    locationId: 'origin',
    scale: 2,
    efficiency: 1,
    workforce: ['worker_0', 'worker_1', 'worker_2', 'worker_3'],
  });
  const report = processEconomyTick(world, { sellRatio: 0.25 });
  const updated = getIndustry(world, industry.id);
  assert.ok(report.environment.industries >= 1);
  assert.ok(report.environment.averageRisk > 0.4);
  assert.ok(report.environment.averageProductionMultiplier < 1);
  assert.ok(report.environmentUpdates[0].riskScore > 0);
  assert.ok(updated.environment.riskScore > 0);
  assert.ok(updated.status !== INDUSTRY_STATUS.ACTIVE);
  assert.ok(world.economy.stats.environmentUpdates >= 1);
  assert.ok(world.economy.indexes.industriesByStatus[updated.status].includes(updated.id));
  const food = getMarket(world, 'global').resources.food;
  assert.ok(food.history.length >= 1);
  assert.ok(food.history[0].environmentPressure >= 0);
}

function testDeterministicEconomyIds() {
  const world = buildEconomyWorld('economy-ids');
  const first = createIndustry(world, { type: 'service', ownerType: 'entity', ownerId: 'worker_0', locationId: 'origin' });
  const second = createIndustry(world, { type: 'service', ownerType: 'entity', ownerId: 'worker_1', locationId: 'origin' });
  assert.ok(first.id.startsWith('industry_'));
  assert.ok(second.id.startsWith('industry_'));
  assert.notStrictEqual(first.id, second.id);
  assert.ok(!first.id.includes('0.'));
}

function buildEconomyWorld(id) {
  const world = createWorld({ id, seed: 'economy-linkage-seed' });
  world.tick = 12;
  registerLocation(world, {
    id: 'origin',
    name: 'Origin Market',
    resources: { food: 12, water: 12, wood: 20, service: 5 },
  });
  for (let index = 0; index < 4; index += 1) {
    const entity = registerEntity(world, {
      id: `worker_${index}`,
      name: `Worker ${index}`,
      locationId: 'origin',
      status: 'alive',
      resources: { currency: 0 },
      stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10 },
    });
    assignSpecies(world, entity.id, 'human');
  }
  return world;
}

function applyHarshEnvironment(world) {
  world.cities = {
    byId: { city_1: { id: 'city_1', locationId: 'origin', risk: 0.72, status: 'declining' } },
    indexes: { byLocation: { origin: ['city_1'] } },
    pressure: { averageRisk: 0.72, bySettlement: { city_1: { locationId: 'origin', riskScore: 0.72 } } },
  };
  world.population = {
    environment: { averageRisk: 0.6, byLocation: { origin: { averageRisk: 0.6 } } },
  };
  world.natural = {
    weather: { byLocation: { origin: { type: 'heatwave', severity: 0.8 } } },
    disasters: { active: { d1: { locationId: 'origin', type: 'drought', severity: 0.35 } } },
  };
  world.ecology = {
    habitats: { byLocation: { origin: { suitability: { human: 0.25 } } } },
    populations: { byKey: { 'origin:human': { pressure: 2.1, diseaseLoad: 0.45, health: 0.35 } } },
  };
}

function applyCalmEnvironment(world) {
  world.locations.origin.resources.food = 600;
  world.locations.origin.resources.water = 600;
  world.locations.origin.resources.service = 300;
  world.cities = {
    byId: { city_1: { id: 'city_1', locationId: 'origin', risk: 0.05, status: 'active' } },
    indexes: { byLocation: { origin: ['city_1'] } },
    pressure: { averageRisk: 0.05, bySettlement: { city_1: { locationId: 'origin', riskScore: 0.05 } } },
  };
  world.population = {
    environment: { averageRisk: 0.04, byLocation: { origin: { averageRisk: 0.04 } } },
  };
  world.natural = {
    weather: { byLocation: { origin: { type: 'clear', severity: 0 } } },
    disasters: { active: {} },
  };
  world.ecology = {
    habitats: { byLocation: { origin: { suitability: { human: 0.95 } } } },
    populations: { byKey: { 'origin:human': { pressure: 0.4, diseaseLoad: 0, health: 1 } } },
  };
}

main();
