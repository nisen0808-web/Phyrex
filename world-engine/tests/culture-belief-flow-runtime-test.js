'use strict';

const assert = require('assert');
const { createWorld, registerEntity, registerLocation } = require('../core/world-engine');
const { upsertCulture, getCultureByOwner } = require('../core/culture-engine');
const { createReligion, getReligion } = require('../core/religion-engine');
const { INFO_FLOW_SYSTEM_ID } = require('../core/info-flow-system-engine');
const { CULTURE_BELIEF_FLOW_SYSTEM_ID } = require('../core/culture-belief-flow-system-engine');
const {
  createCultureBeliefFlowDeterministicKernel,
  runDeterministicSimulationTickWithCultureBeliefFlow,
} = require('../core/culture-belief-flow-runtime-engine');

function main() {
  const world = buildWorld();
  const kernel = createCultureBeliefFlowDeterministicKernel({ includeNaturalWorld: false, includeEcologyWorld: false, includeConsistencyWorld: false });
  assert.ok(kernel.registry.systems[INFO_FLOW_SYSTEM_ID]);
  assert.ok(kernel.registry.systems[CULTURE_BELIEF_FLOW_SYSTEM_ID]);

  const report = runDeterministicSimulationTickWithCultureBeliefFlow(world, { ...disabledOptions(), autoCultureBeliefFlow: true, cultureBeliefFlow: { organizationFaithThreshold: 20 } }, kernel);
  assert.ok(report.kernel.order.includes(INFO_FLOW_SYSTEM_ID));
  assert.ok(report.kernel.order.includes(CULTURE_BELIEF_FLOW_SYSTEM_ID));
  assert.ok(report.cultureBeliefFlow.links > 0);
  assert.ok(report.cultureBeliefFlow.transfers.length > 0);
  assert.ok(report.cultureBeliefFlow.beliefCulture.length > 0);
  assert.ok(getCultureByOwner(world, 'city', 'city_qingyun').traits.faith > 0);
  assert.ok(getReligion(world, 'religion_qingyun').organizationIds.includes('org_church'));
  console.log('culture belief flow runtime test passed');
}

function buildWorld() {
  const world = createWorld({ id: 'culture-belief-runtime-world', seed: 'culture-belief-runtime-seed' });
  world.tick = 44;
  registerLocation(world, { id: 'loc_qingyun', name: 'Qingyun City', type: 'city' });
  registerEntity(world, { id: 'entity_a', name: 'Entity A', species: 'human', status: 'alive', locationId: 'loc_qingyun', stats: { social: 80 } });
  registerEntity(world, { id: 'entity_b', name: 'Entity B', species: 'human', status: 'alive', locationId: 'loc_qingyun', stats: { social: 60 } });
  world.cities = { byId: { city_qingyun: { id: 'city_qingyun', name: 'Qingyun', type: 'city', locationId: 'loc_qingyun', population: 2, wealth: 1200, security: 65, culture: 70, infrastructureIds: [], organizationIds: ['org_school', 'org_church'] } } };
  world.organizations = { byId: {
    org_school: { id: 'org_school', name: 'Qingyun School', type: 'school', status: 'active', homeLocationId: 'loc_qingyun', members: ['entity_a'], reputation: 60, assets: { currency: 1500 }, culture: ['teaching'], goals: [] },
    org_church: { id: 'org_church', name: 'Qingyun Shrine', type: 'church', status: 'active', homeLocationId: 'loc_qingyun', members: ['entity_b'], reputation: 70, assets: { currency: 500 }, culture: ['ritual'], goals: [] },
  } };
  upsertCulture(world, { ownerType: 'city', ownerId: 'city_qingyun', scope: 'city', traits: { trade: 60, faith: 35 }, values: ['market'] });
  upsertCulture(world, { ownerType: 'organization', ownerId: 'org_school', scope: 'organization', traits: { knowledge: 70, faith: 25 }, values: ['teaching'] });
  upsertCulture(world, { ownerType: 'organization', ownerId: 'org_church', scope: 'organization', traits: { faith: 80 }, values: ['ritual'] });
  createReligion(world, { id: 'religion_qingyun', name: 'Qingyun Rite', type: 'doctrine', originLocationId: 'loc_qingyun', doctrines: ['ritual'], virtues: ['faith'], believers: ['entity_a'], influence: 50, zeal: 60, organizationIds: [] });
  return world;
}

function disabledOptions() {
  return { autoPopulation: false, autoFamilies: false, autoLegacy: false, autoContracts: false, autoOrganizations: false, autoEconomy: false, autoCity: false, autoIdentity: false, autoDesire: false, autoOpportunity: false, autoPlanActions: false, autoInformation: false, autoMemory: false, autoCulture: false, autoReligion: false, autoCivilization: false, autoTechnology: false, autoInfrastructure: false, autoGovernance: false, autoProcess: false, autoEmergence: false, autoConflict: false, autoPlayers: false, autoHistory: false, autoNarrative: false, autoNovel: false };
}

main();
