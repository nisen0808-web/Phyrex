'use strict';

const assert = require('assert');
const { createWorld, registerEntity, registerLocation } = require('../core/world-engine');
const { initializeSimulation, runSimulationTicks, getSimulationSummary } = require('../core/simulation-engine');
const { assignSpecies } = require('../core/species-engine');
const { getEntityDesireProfile } = require('../core/desire-engine');
const { createOpportunity, getOpportunityStats } = require('../core/opportunity-engine');

function main() {
  const world = createWorld({ id: 'desire-opportunity-test-world' });
  registerLocation(world, { id: 'market', name: 'Market', resources: { food: 100, metal: 50 } });

  registerEntity(world, {
    id: 'seeker',
    name: 'Seeker',
    locationId: 'market',
    traits: { ambition: 95, social: 70 },
    stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 20, defense: 5, speed: 10, intelligence: 40, social: 70 },
    resources: { currency: 5 },
  });

  assignSpecies(world, 'seeker', 'human');

  initializeSimulation(world, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0 },
    desire: { goalThreshold: 45, fearGoalThreshold: 45, maxGeneratedGoalsPerTick: 3 },
    opportunity: { discoveryChance: 0, crisisChance: 0, claimChance: 1 },
  });

  createOpportunity(world, {
    type: 'trade',
    title: 'easy trade',
    locationId: 'market',
    difficulty: 1,
    reward: { currency: 50 },
    visibility: 100,
  });

  const reports = runSimulationTicks(world, 3, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0 },
    desire: { goalThreshold: 45, fearGoalThreshold: 45, maxGeneratedGoalsPerTick: 3 },
    opportunity: { discoveryChance: 0, crisisChance: 0, claimChance: 1 },
  });

  assert.strictEqual(reports.length, 3, 'simulation should return reports');
  assert.ok(reports.every(report => report.desires), 'desire tick should run');
  assert.ok(reports.every(report => report.opportunities), 'opportunity tick should run');

  const profile = getEntityDesireProfile(world, 'seeker');
  assert.ok(profile.happiness >= 0 && profile.happiness <= 100, 'happiness should be bounded');
  assert.ok(profile.dominantDesire, 'dominant desire should be calculated');
  assert.ok(world.entities.seeker.meta.happiness !== undefined, 'happiness should be written to entity meta');

  const stats = getOpportunityStats(world);
  assert.ok(stats.claimed >= 1, 'at least one opportunity should be claimed');
  assert.ok(Number(world.entities.seeker.resources.currency || 0) >= 55, 'opportunity reward should increase currency');

  const summary = getSimulationSummary(world);
  assert.ok(summary.counters.desiresUpdated >= 1, 'desire updates should be counted');
  assert.ok(summary.counters.opportunitiesClaimed >= 1, 'opportunity claims should be counted');

  console.log('desire-opportunity integration test passed');
}

main();
