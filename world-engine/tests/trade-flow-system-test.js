'use strict';

const assert = require('assert');
const { createWorld, registerLocation, registerEntity } = require('../core/world-engine');
const { assignSpecies } = require('../core/species-engine');
const { ensureEconomyState, processEconomyTick } = require('../core/economy-engine');
const { processTradeFlows, buildTradeFlowCandidates } = require('../core/trade-flow-engine');
const {
  createDeterministicSimulationKernel,
  initializeDeterministicSimulation,
  runDeterministicSimulationTick,
} = require('../core/deterministic-simulation-engine');

function main() {
  testTradeFlowMovesResources();
  testEconomyTickIncludesTradeFlows();
  testTradeFlowInDeterministicPipeline();
  console.log('trade flow system test passed');
}

function testTradeFlowMovesResources() {
  const world = buildWorld('trade-flow-direct');
  const before = snapshotResources(world);
  const candidates = buildTradeFlowCandidates(world, testOptions());
  assert.ok(candidates.some(candidate => candidate.resource === 'food' && candidate.toLocationId === 'capital'), 'should plan food flow into pressured city');

  const transactions = [];
  const summary = processTradeFlows(world, testOptions(), { recordTransaction: (_world, tx) => { transactions.push(tx); return tx; } });
  assert.ok(summary.count >= 1, 'trade flow summary should contain flows');
  assert.ok(summary.byResource.food > 0, 'food should move');
  assert.ok(world.locations.granary.resources.food < before.granaryFood, 'source food should decrease');
  assert.ok(world.locations.capital.resources.food > before.capitalFood, 'target food should increase');
  assert.ok(world.economy.tradeFlowLog.length >= 1, 'trade flow log should retain flows');
  assert.ok(transactions.some(tx => tx.type === 'trade_flow' && tx.resource === 'food'), 'trade flow should record transaction when helper is provided');
}

function testEconomyTickIncludesTradeFlows() {
  const world = buildWorld('trade-flow-economy');
  ensureEconomyState(world);
  const beforeFood = world.locations.capital.resources.food;
  const report = processEconomyTick(world, testOptions());
  assert.ok(report.tradeFlows.count >= 1, 'economy tick should run trade flows');
  assert.ok(report.tradeFlows.volume > 0, 'trade flow volume should be positive');
  assert.ok(world.locations.capital.resources.food > beforeFood, 'economy tick should move food into pressured location');
  assert.ok(world.economy.transactions.some(tx => tx.type === 'trade_flow'), 'economy transaction log should include trade flow transactions');
  assert.ok(world.economy.stats.tradeFlowCount >= report.tradeFlows.count, 'economy stats should count trade flows');
}

function testTradeFlowInDeterministicPipeline() {
  const world = buildWorld('trade-flow-pipeline');
  const kernel = createDeterministicSimulationKernel({ contractPolicy: 'error' });
  initializeDeterministicSimulation(world, deterministicOptions());
  const beforeFood = world.locations.capital.resources.food;

  const report = runDeterministicSimulationTick(world, { simulation: deterministicOptions() }, kernel);
  assert.strictEqual(report.kernel.contracts.violations, 0, 'economy output should satisfy system contract');
  assert.ok(report.economy.tradeFlows.count >= 1, 'pipeline economy report should include trade flows');
  assert.ok(world.locations.capital.resources.food > beforeFood, 'pipeline should move resources');
}

function buildWorld(id) {
  const world = createWorld({ id, seed: 'trade-flow-seed' });
  world.tick = 100;
  registerLocation(world, { id: 'granary', name: 'Granary', resources: { food: 1000, water: 900, wood: 300 } });
  registerLocation(world, { id: 'capital', name: 'Capital', resources: { food: 5, water: 4, wood: 20 } });

  for (let index = 0; index < 30; index += 1) {
    const entity = registerEntity(world, {
      id: `${id}_citizen_${index}`,
      name: `Citizen ${index}`,
      locationId: 'capital',
      status: 'alive',
      stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10, social: 40, intelligence: 30 },
      resources: { currency: 50 },
      demographics: { birthTick: -720 * 25, age: 25, ageGroup: 'adult', sex: index % 2 ? 'female' : 'male', fertility: 1, lifeExpectancy: 80, generation: 1 },
    });
    assignSpecies(world, entity.id, 'human');
  }

  world.cities = {
    byId: {
      city_capital: {
        id: 'city_capital',
        name: 'Capital',
        locationId: 'capital',
        population: 30,
        risk: 0.82,
        security: 20,
        pressure: { riskScore: 0.82, resourcePressure: 0.9, foodCoverage: 0.08, waterCoverage: 0.07 },
      },
      city_granary: {
        id: 'city_granary',
        name: 'Granary Town',
        locationId: 'granary',
        population: 2,
        risk: 0.1,
        security: 75,
        pressure: { riskScore: 0.1, resourcePressure: 0.05, foodCoverage: 2, waterCoverage: 2 },
      },
    },
    indexes: { byLocation: { capital: ['city_capital'], granary: ['city_granary'] }, byType: { city: ['city_capital', 'city_granary'] } },
    pressure: {
      averageRisk: 0.46,
      bySettlement: {
        city_capital: { locationId: 'capital', riskScore: 0.82, resourcePressure: 0.9, migrationAppeal: 12 },
        city_granary: { locationId: 'granary', riskScore: 0.1, resourcePressure: 0.05, migrationAppeal: 80 },
      },
    },
  };

  world.population = { environment: { averageRisk: 0.55, byLocation: { capital: { averageRisk: 0.75 }, granary: { averageRisk: 0.1 } } } };
  world.natural = { disasters: { active: {} }, weather: { byLocation: { capital: { type: 'clear', severity: 0 }, granary: { type: 'clear', severity: 0 } } } };
  ensureEconomyState(world);
  world.economy.markets.global.resources.food.supply = 30;
  world.economy.markets.global.resources.food.demand = 300;
  world.economy.markets.global.resources.food.price = 5;
  return world;
}

function snapshotResources(world) {
  return {
    granaryFood: world.locations.granary.resources.food,
    capitalFood: world.locations.capital.resources.food,
  };
}

function testOptions() {
  return { maxTradeFlowsPerTick: 6, minimumSurplus: 20, minimumDeficit: 5, discoveryChance: 0, crisisChance: 0, claimChance: 0 };
}

function deterministicOptions() {
  return { ...disabledOptions(), autoEconomy: true, economy: testOptions() };
}

function disabledOptions() {
  return { seedIndustries: false, autoNatural: false, autoEcology: false, autoConsistency: false, autoPlanActions: false, autoPopulation: false, autoFamilies: false, autoLegacy: false, autoContracts: false, autoOrganizations: false, autoCity: false, autoIdentity: false, autoDesire: false, autoOpportunity: false, autoInformation: false, autoMemory: false, autoCulture: false, autoReligion: false, autoCivilization: false, autoTechnology: false, autoInfrastructure: false, autoGovernance: false, autoProcess: false, autoEmergence: false, autoConflict: false, autoPlayers: false, autoHistory: false, autoNarrative: false, autoNovel: false };
}

main();
