'use strict';

const assert = require('assert');
const { createWorld, registerEntity, registerLocation } = require('../core/world-engine');
const { initializeSimulation, runSimulationTicks, getSimulationSummary } = require('../core/simulation-engine');
const { assignSpecies } = require('../core/species-engine');
const { createOrganization, setOrganizationRelation } = require('../core/organization-engine');
const { processCityTick } = require('../core/city-engine');
const { createGovernment, setPolicy, getGovernanceStats } = require('../core/governance-engine');
const { createConflict, CONFLICT_TYPES, getConflictStats } = require('../core/conflict-engine');

function main() {
  const world = createWorld({ id: 'governance-conflict-test-world' });
  registerLocation(world, { id: 'fortress', name: 'Fortress', resources: { food: 1000, metal: 300 } });

  for (let i = 0; i < 12; i += 1) {
    registerEntity(world, {
      id: `soldier_${i}`,
      name: `Soldier ${i}`,
      locationId: 'fortress',
      traits: { ambition: 60, social: 40 },
      stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 20 + i, defense: 10, speed: 10, intelligence: 10, social: 40 },
      resources: { currency: 100 },
    });
    assignSpecies(world, `soldier_${i}`, 'human');
  }

  initializeSimulation(world, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0 },
    city: { minPopulationForSettlement: 1 },
    conflict: { battleChance: 1 },
  });

  processCityTick(world, { minPopulationForSettlement: 1 });

  const state = createOrganization(world, {
    type: 'state',
    name: 'Fortress State',
    leaderId: 'soldier_0',
    homeLocationId: 'fortress',
    currency: 1000,
  });

  const rival = createOrganization(world, {
    type: 'gang',
    name: 'Rival Gang',
    leaderId: 'soldier_6',
    homeLocationId: 'fortress',
    currency: 500,
  });

  for (let i = 1; i < 6; i += 1) state.members.push(`soldier_${i}`);
  for (let i = 7; i < 12; i += 1) rival.members.push(`soldier_${i}`);
  setOrganizationRelation(world, state.id, rival.id, 'rival', 120);

  const government = createGovernment(world, {
    organizationId: state.id,
    policies: { taxRate: 60, lawLevel: 20, welfare: 0, military: 30, openness: 20 },
    legitimacy: 20,
    unrest: 80,
  });
  assert.ok(government.id, 'government should be created');
  setPolicy(world, government.id, 'taxRate', 65);

  const conflict = createConflict(world, {
    type: CONFLICT_TYPES.ORGANIZATION_RIVALRY,
    title: 'Fortress State vs Rival Gang',
    sideA: { type: 'organization', id: state.id, entityIds: state.members },
    sideB: { type: 'organization', id: rival.id, entityIds: rival.members },
    locationIds: ['fortress'],
    intensity: 120,
  });
  assert.ok(conflict.id, 'conflict should be created');

  const reports = runSimulationTicks(world, 3, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0 },
    city: { minPopulationForSettlement: 1 },
    conflict: { battleChance: 1, activeThreshold: 50 },
  });

  assert.strictEqual(reports.length, 3, 'simulation should return reports');
  assert.ok(reports.every(report => report.governance), 'governance tick should run');
  assert.ok(reports.every(report => report.conflicts), 'conflict tick should run');

  const governanceStats = getGovernanceStats(world);
  assert.ok(governanceStats.total >= 1, 'governance stats should include government');

  const conflictStats = getConflictStats(world);
  assert.ok(conflictStats.total >= 1, 'conflict stats should include conflict');

  const summary = getSimulationSummary(world);
  assert.ok(summary.counters.governmentsUpdated >= 1, 'government updates should be counted');
  assert.ok(summary.counters.taxCollected >= 0, 'tax counter should exist');
  assert.ok(summary.counters.conflictsCreated >= 0, 'conflict creation counter should exist');
  assert.ok(summary.counters.conflictEvents >= 0, 'conflict event counter should exist');

  console.log('governance-conflict integration test passed');
}

main();
