'use strict';

const assert = require('assert');
const { createWorld, registerLocation, connectLocations, registerEntity, enqueueAction, advanceOneTick } = require('../core/world-engine');
const { assignSpecies } = require('../core/species-engine');
const {
  processDesireTick,
  calculateEntityEnvironmentSignal,
  getEntityDesireProfile,
} = require('../core/desire-engine');
const {
  assignGoal,
  goalToActionIntent,
  planEntityAction,
} = require('../core/goal-engine');

function main() {
  testEnvironmentSignalAndGoalGeneration();
  testEnvironmentGoalActionPlanning();
  testStockpileAndWorkGoals();
  console.log('ai environment goals test passed');
}

function testEnvironmentSignalAndGoalGeneration() {
  const world = buildPressureWorld('ai-env-goals');
  const entity = world.entities.alice;
  const signal = calculateEntityEnvironmentSignal(world, entity);
  assert.ok(signal.totalRisk > 0.5, `expected high total risk, got ${signal.totalRisk}`);
  assert.strictEqual(signal.safeLocationId, 'haven');
  assert.strictEqual(signal.localIndustryStalled, true);

  const report = processDesireTick(world, {
    environmentGoalThreshold: 0.2,
    maxEnvironmentGoalsPerTick: 4,
    maxGeneratedGoalsPerTick: 0,
    goalThreshold: 101,
    fearGoalThreshold: 101,
  });
  const goals = report.generatedGoals.map(goal => goal.type);
  assert.ok(goals.includes('seek_shelter'), `expected seek_shelter goal, got ${goals.join(',')}`);
  assert.ok(goals.includes('stockpile_resource'), `expected stockpile_resource goal, got ${goals.join(',')}`);
  assert.ok(goals.includes('find_work'), `expected find_work goal, got ${goals.join(',')}`);
  const profile = getEntityDesireProfile(world, 'alice');
  assert.ok(profile.environment.totalRisk > 0.5);
  assert.ok(profile.fears.death > 40, 'environment should raise death fear');
  assert.ok(profile.desires.security > 45, 'environment should raise security desire');
}

function testEnvironmentGoalActionPlanning() {
  const world = buildPressureWorld('ai-env-plan');
  processDesireTick(world, {
    environmentGoalThreshold: 0.2,
    maxEnvironmentGoalsPerTick: 1,
    maxGeneratedGoalsPerTick: 0,
    goalThreshold: 101,
    fearGoalThreshold: 101,
  });
  const plan = planEntityAction(world, 'alice');
  assert.ok(plan, 'expected a planned action');
  assert.strictEqual(plan.goal.type, 'seek_shelter');
  assert.strictEqual(plan.action.type, 'move');
  assert.strictEqual(plan.action.payload.to, 'haven');
  enqueueAction(world, plan.action);
  advanceOneTick(world, { recordReports: false });
  assert.strictEqual(world.entities.alice.locationId, 'haven');
}

function testStockpileAndWorkGoals() {
  const world = buildPressureWorld('ai-env-stockpile');
  const stockpile = assignGoal(world, 'alice', {
    type: 'stockpile_resource',
    priority: 90,
    payload: { resource: 'food', amount: 10, gatherAmount: 3 },
    tags: ['environment_generated'],
  });
  const stockpileAction = goalToActionIntent(world, 'alice', stockpile);
  assert.strictEqual(stockpileAction.type, 'gather');
  assert.strictEqual(stockpileAction.payload.resource, 'food');

  const work = assignGoal(world, 'alice', {
    type: 'find_work',
    priority: 80,
    payload: { amount: 30 },
    tags: ['environment_generated'],
  });
  const workAction = goalToActionIntent(world, 'alice', work);
  assert.strictEqual(workAction.type, 'work');
  assert.strictEqual(workAction.payload.resource, 'currency');
}

function buildPressureWorld(id) {
  const world = createWorld({ id, seed: 'ai-env-seed' });
  world.tick = 20;
  registerLocation(world, { id: 'origin', name: 'Burning City', resources: { food: 3, water: 4 } });
  registerLocation(world, { id: 'haven', name: 'Safe Haven', resources: { food: 500, water: 500 } });
  connectLocations(world, 'origin', 'haven');
  const entity = registerEntity(world, {
    id: 'alice',
    name: 'Alice',
    locationId: 'origin',
    status: 'alive',
    traits: { ambition: 50, social: 40 },
    stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10, social: 40 },
    resources: { currency: 0, food: 0 },
  });
  assignSpecies(world, entity.id, 'human');

  world.cities = {
    byId: {
      city_origin: { id: 'city_origin', locationId: 'origin', risk: 0.85, migrationAppeal: 15, status: 'failing' },
      city_haven: { id: 'city_haven', locationId: 'haven', risk: 0.05, migrationAppeal: 90, status: 'active' },
    },
    indexes: { byLocation: { origin: ['city_origin'], haven: ['city_haven'] } },
    pressure: {
      averageRisk: 0.5,
      bySettlement: {
        city_origin: { locationId: 'origin', riskScore: 0.85, migrationAppeal: 15 },
        city_haven: { locationId: 'haven', riskScore: 0.05, migrationAppeal: 90 },
      },
    },
  };
  world.population = { environment: { averageRisk: 0.7, byLocation: { origin: { averageRisk: 0.7 }, haven: { averageRisk: 0.02 } } } };
  world.natural = {
    weather: { byLocation: { origin: { type: 'heatwave', severity: 0.9 }, haven: { type: 'clear', severity: 0 } } },
    disasters: { active: { d1: { locationId: 'origin', type: 'wildfire', severity: 0.8 } } },
  };
  world.economy = {
    environment: { averageRisk: 0.75, averagePricePressure: 0.7 },
    industries: {
      industry_1: { id: 'industry_1', locationId: 'origin', status: 'stalled' },
    },
  };
  world.ecology = {
    habitats: { byLocation: { origin: { suitability: { human: 0.2 } }, haven: { suitability: { human: 0.95 } } } },
    populations: { byKey: { 'origin:human': { pressure: 2.1, diseaseLoad: 0.4, health: 0.4 } } },
  };
  return world;
}

main();
