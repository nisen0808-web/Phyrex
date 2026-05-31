'use strict';

const assert = require('assert');
const { createWorld, registerEntity, registerLocation } = require('../core/world-engine');
const { initializeSimulation, runSimulationTicks, getSimulationSummary } = require('../core/simulation-engine');
const { assignSpecies } = require('../core/species-engine');
const { syncFamiliesFromPopulation, addFamilyTradition } = require('../core/family-engine');
const { createOrganization } = require('../core/organization-engine');
const { createContract, CONTRACT_TYPES } = require('../core/contract-engine');
const { getEntityIdentities, calculateIdentityScore } = require('../core/identity-engine');
const { getCultureByOwner, getCultureSummary } = require('../core/culture-engine');

function main() {
  const world = createWorld({ id: 'identity-culture-test-world' });
  registerLocation(world, { id: 'city_gate', name: 'City Gate', resources: { food: 100 } });

  registerEntity(world, {
    id: 'leader',
    name: 'Leader',
    locationId: 'city_gate',
    traits: { ambition: 90, social: 80 },
    stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 30, defense: 5, speed: 10, intelligence: 30, social: 80 },
    resources: { currency: 1000 },
  });

  registerEntity(world, {
    id: 'member',
    name: 'Member',
    locationId: 'city_gate',
    traits: { ambition: 40, social: 35 },
    stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10, defense: 5, speed: 10, intelligence: 10, social: 35 },
    resources: { currency: 50 },
  });

  assignSpecies(world, 'leader', 'human');
  assignSpecies(world, 'member', 'human');

  initializeSimulation(world, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0 },
    city: { minPopulationForSettlement: 1 },
  });

  const familySync = syncFamiliesFromPopulation(world, { createForUnassigned: true });
  const family = familySync.created[0];
  assert.ok(family, 'family should exist');
  addFamilyTradition(world, family.id, 'martial');

  const org = createOrganization(world, {
    type: 'state',
    name: 'Test State',
    leaderId: 'leader',
    homeLocationId: 'city_gate',
    currency: 5000,
  });
  assert.ok(org.id, 'organization should be created');

  const contract = createContract(world, {
    type: CONTRACT_TYPES.VASSALAGE,
    controllerId: 'leader',
    subjectId: 'member',
    durationTicks: 20,
  });
  assert.ok(contract.id, 'contract should be created');

  const reports = runSimulationTicks(world, 3, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0 },
    city: { minPopulationForSettlement: 1 },
  });

  assert.ok(reports.every(report => report.identities), 'identity tick should run');
  assert.ok(reports.every(report => report.cultures), 'culture tick should run');

  const leaderIdentities = getEntityIdentities(world, 'leader');
  const memberIdentities = getEntityIdentities(world, 'member');
  assert.ok(leaderIdentities.length > 0, 'leader should have identities');
  assert.ok(memberIdentities.length > 0, 'member should have identities');

  const leaderScore = calculateIdentityScore(world, 'leader');
  assert.ok(leaderScore.authority > 0, 'leader should have authority from organization or contract');

  assert.ok(getCultureByOwner(world, 'family', family.id), 'family culture should exist');
  assert.ok(getCultureByOwner(world, 'organization', org.id), 'organization culture should exist');
  const familyCulture = getCultureSummary(world, 'family', family.id);
  assert.ok(familyCulture.dominantTraits.length > 0, 'family culture should have dominant traits');

  const summary = getSimulationSummary(world);
  assert.ok(summary.counters.identitiesSynced > 0, 'identity sync should be counted');
  assert.ok(summary.counters.culturesSynced > 0, 'culture sync should be counted');

  console.log('identity-culture integration test passed');
}

main();
