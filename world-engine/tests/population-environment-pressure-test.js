'use strict';

const assert = require('assert');
const { createWorld, registerLocation, registerEntity } = require('../core/world-engine');
const { assignSpecies } = require('../core/species-engine');
const {
  initializePopulation,
  processPopulationTick,
  calculatePopulationEnvironmentalPressure,
} = require('../core/population-engine');

function main() {
  testPressureCalculation();
  testPopulationTickRecordsEnvironmentSummary();
  console.log('population environment pressure test passed');
}

function testPressureCalculation() {
  const harsh = buildPressureWorld('harsh-world');
  applyHarshEnvironment(harsh);
  initializePopulation(harsh, { ticksPerYear: 1, baseBirthChance: 0, baseMortalityChance: 0 });
  const harshPressure = calculatePopulationEnvironmentalPressure(harsh, harsh.entities.alice);
  assert.ok(harshPressure.totalRisk > 0.45, `expected harsh risk > 0.45, got ${harshPressure.totalRisk}`);
  assert.ok(harshPressure.mortalityMultiplier > 2, `expected high mortality multiplier, got ${harshPressure.mortalityMultiplier}`);
  assert.ok(harshPressure.birthMultiplier < 0.8, `expected reduced birth multiplier, got ${harshPressure.birthMultiplier}`);
  assert.strictEqual(harshPressure.locationId, 'origin');
  assert.strictEqual(harshPressure.speciesId, 'human');

  const calm = buildPressureWorld('calm-world');
  applyCalmEnvironment(calm);
  initializePopulation(calm, { ticksPerYear: 1, baseBirthChance: 0, baseMortalityChance: 0 });
  const calmPressure = calculatePopulationEnvironmentalPressure(calm, calm.entities.alice);
  assert.ok(calmPressure.totalRisk < harshPressure.totalRisk, 'calm world should have lower pressure');
  assert.ok(calmPressure.mortalityMultiplier < harshPressure.mortalityMultiplier, 'calm world should have lower mortality multiplier');
  assert.ok(calmPressure.birthMultiplier > harshPressure.birthMultiplier, 'calm world should have higher birth multiplier');
}

function testPopulationTickRecordsEnvironmentSummary() {
  const world = buildPressureWorld('summary-world');
  applyHarshEnvironment(world);
  initializePopulation(world, { ticksPerYear: 1, baseBirthChance: 0, baseMortalityChance: 0 });
  const report = processPopulationTick(world, {
    ticksPerYear: 1,
    baseBirthChance: 0,
    baseMortalityChance: 0,
  });
  assert.strictEqual(report.births.length, 0);
  assert.strictEqual(report.deaths.length, 0);
  assert.strictEqual(report.environment.entities, 2);
  assert.strictEqual(world.population.environment.entities, 2);
  assert.ok(report.environment.highRisk >= 1);
  assert.ok(report.stats.environment.averageMortalityMultiplier >= report.environment.averageMortalityMultiplier);
  assert.ok(world.population.environment.byLocation.origin.averageRisk > 0);
}

function buildPressureWorld(id) {
  const world = createWorld({ id, seed: 'population-pressure-seed' });
  world.tick = 30;
  registerLocation(world, {
    id: 'origin',
    name: 'Origin Plains',
    resources: { food: 5, water: 10, wood: 50 },
  });
  const alice = registerEntity(world, {
    id: 'alice',
    name: 'Alice',
    locationId: 'origin',
    status: 'alive',
    stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10 },
    demographics: { birthTick: 0, age: 30, sex: 'female', fertility: 1, lifeExpectancy: 80, generation: 1 },
  });
  const bob = registerEntity(world, {
    id: 'bob',
    name: 'Bob',
    locationId: 'origin',
    status: 'alive',
    stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10 },
    demographics: { birthTick: 0, age: 30, sex: 'male', fertility: 1, lifeExpectancy: 80, generation: 1 },
  });
  assignSpecies(world, alice.id, 'human');
  assignSpecies(world, bob.id, 'human');
  return world;
}

function applyHarshEnvironment(world) {
  world.natural = {
    weather: { byLocation: { origin: { type: 'heatwave', severity: 0.9 } } },
    disasters: { active: { disaster_1: { locationId: 'origin', severity: 0.8, type: 'drought' } } },
  };
  world.ecology = {
    habitats: { byLocation: { origin: { suitability: { human: 0.2 } } } },
    populations: { byKey: { 'origin:human': { pressure: 2.6, diseaseLoad: 0.7, health: 0.2 } } },
  };
}

function applyCalmEnvironment(world) {
  world.locations.origin.resources.food = 500;
  world.locations.origin.resources.water = 500;
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
