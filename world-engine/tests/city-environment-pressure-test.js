'use strict';

const assert = require('assert');
const { createWorld, registerLocation, registerEntity } = require('../core/world-engine');
const { assignSpecies } = require('../core/species-engine');
const {
  CITY_STATUS,
  createSettlement,
  calculateCityPressure,
  processCityTick,
  getSettlementChronicle,
} = require('../core/city-engine');

function main() {
  testHarshPressureVsCalmPressure();
  testCityTickAppliesPressureEffects();
  console.log('city environment pressure test passed');
}

function testHarshPressureVsCalmPressure() {
  const harsh = buildCityWorld('harsh-city');
  applyHarshEnvironment(harsh);
  const harshSettlement = createSettlement(harsh, {
    locationId: 'origin',
    population: 12,
    infrastructure: 4,
    security: 20,
    wealth: 15,
  });
  const harshPressure = calculateCityPressure(harsh, harshSettlement);
  assert.ok(harshPressure.riskScore > 0.5, `expected high risk, got ${harshPressure.riskScore}`);
  assert.ok(harshPressure.stability < 55, `expected low stability, got ${harshPressure.stability}`);
  assert.ok(harshPressure.migrationAppeal < 45, `expected weak migration appeal, got ${harshPressure.migrationAppeal}`);
  assert.ok(harshPressure.maintenance.gap > 0.2, `expected maintenance gap, got ${harshPressure.maintenance.gap}`);

  const calm = buildCityWorld('calm-city');
  applyCalmEnvironment(calm);
  const calmSettlement = createSettlement(calm, {
    locationId: 'origin',
    population: 12,
    infrastructure: 35,
    security: 80,
    wealth: 800,
  });
  const calmPressure = calculateCityPressure(calm, calmSettlement);
  assert.ok(calmPressure.riskScore < harshPressure.riskScore, 'calm city should have lower risk');
  assert.ok(calmPressure.stability > harshPressure.stability, 'calm city should have higher stability');
  assert.ok(calmPressure.migrationAppeal > harshPressure.migrationAppeal, 'calm city should have stronger migration appeal');
}

function testCityTickAppliesPressureEffects() {
  const world = buildCityWorld('pressure-tick-city');
  applyHarshEnvironment(world);
  const settlement = createSettlement(world, {
    locationId: 'origin',
    population: 12,
    infrastructure: 6,
    security: 25,
    wealth: 30,
  });
  const beforeInfrastructure = settlement.infrastructure;
  const report = processCityTick(world, { minPopulationForSettlement: 1 });
  const updated = world.cities.byId[settlement.id];
  assert.ok(report.pressure.settlements >= 1);
  assert.ok(report.pressure.highRisk >= 1);
  assert.ok(report.degraded.length >= 1);
  assert.ok(updated.infrastructure < beforeInfrastructure, 'pressure should degrade infrastructure');
  assert.notStrictEqual(updated.status, CITY_STATUS.ACTIVE);
  assert.ok(updated.pressure.riskScore > 0);
  assert.ok(world.cities.pressure.bySettlement[settlement.id]);
  assert.ok(world.cities.stats.pressureUpdates >= 1);
  assert.ok(getSettlementChronicle(world, settlement.id).pressure.riskScore > 0);
}

function buildCityWorld(id) {
  const world = createWorld({ id, seed: 'city-pressure-seed' });
  world.tick = 10;
  registerLocation(world, {
    id: 'origin',
    name: 'Origin City',
    resources: { food: 8, water: 8, wood: 50 },
  });
  for (let index = 0; index < 12; index += 1) {
    const entity = registerEntity(world, {
      id: `person_${index}`,
      name: `Person ${index}`,
      locationId: 'origin',
      status: 'alive',
      stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10 },
      resources: { currency: index % 2 === 0 ? 1 : 0 },
      demographics: { birthTick: -30, age: 30, ageGroup: 'adult', sex: index % 2 === 0 ? 'female' : 'male', fertility: 1, lifeExpectancy: 80, generation: 1 },
    });
    assignSpecies(world, entity.id, 'human');
  }
  return world;
}

function applyHarshEnvironment(world) {
  world.population = {
    environment: {
      byLocation: {
        origin: { averageRisk: 0.82, averageMortalityMultiplier: 3.4, averageBirthMultiplier: 0.35 },
      },
    },
  };
  world.natural = {
    weather: { byLocation: { origin: { type: 'heatwave', severity: 0.9 } } },
    disasters: { active: { d1: { locationId: 'origin', type: 'drought', severity: 0.85 } } },
  };
  world.ecology = {
    habitats: { byLocation: { origin: { suitability: { human: 0.2 } } } },
    populations: { byKey: { 'origin:human': { pressure: 2.4, diseaseLoad: 0.65, health: 0.25 } } },
  };
}

function applyCalmEnvironment(world) {
  world.locations.origin.resources.food = 500;
  world.locations.origin.resources.water = 500;
  world.population = {
    environment: {
      byLocation: {
        origin: { averageRisk: 0.05, averageMortalityMultiplier: 1.05, averageBirthMultiplier: 1.05 },
      },
    },
  };
  world.natural = {
    weather: { byLocation: { origin: { type: 'clear', severity: 0 } } },
    disasters: { active: {} },
  };
  world.ecology = {
    habitats: { byLocation: { origin: { suitability: { human: 0.95 } } } },
    populations: { byKey: { 'origin:human': { pressure: 0.45, diseaseLoad: 0, health: 1 } } },
  };
}

main();
