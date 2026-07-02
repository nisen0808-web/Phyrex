'use strict';

const assert = require('assert');
const { createWorld, registerEntity, registerLocation } = require('../core/world-engine');
const { upsertCulture, getCultureByOwner } = require('../core/culture-engine');
const { createReligion, getReligion } = require('../core/religion-engine');
const {
  buildCultureBeliefLinks,
  processCultureBeliefFlowTick,
  ensureCultureBeliefFlowState,
} = require('../core/culture-belief-flow-engine');

function main() {
  const world = buildWorld();
  const links = buildCultureBeliefLinks(world, { maxLinksPerTick: 50 });
  assert.ok(links.some(link => link.reason === 'city_to_organization'));
  assert.ok(links.some(link => link.reason === 'organization_to_city'));
  assert.ok(links.some(link => link.reason === 'belief_to_city'));

  const result = processCultureBeliefFlowTick(world, { organizationFaithThreshold: 20 });
  const cityCulture = getCultureByOwner(world, 'city', 'city_qingyun');
  const orgCulture = getCultureByOwner(world, 'organization', 'org_school');
  const religion = getReligion(world, 'religion_qingyun');

  assert.ok(cityCulture.traits.faith > 0);
  assert.ok(cityCulture.traits.knowledge > 0);
  assert.ok(orgCulture.traits.trade > 0);
  assert.ok(religion.organizationIds.includes('org_church'));
  assert.ok(result.links > 0);
  assert.ok(result.transfers.length > 0);
  assert.ok(result.beliefCulture.length > 0);
  assert.ok(result.organizationLinks.length > 0);
  assert.ok(ensureCultureBeliefFlowState(world).events.length > 0);
  console.log('culture belief flow test passed');
}

function buildWorld() {
  const world = createWorld({ id: 'culture-belief-flow-world', seed: 'culture-belief-flow-seed' });
  world.tick = 30;
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

main();
