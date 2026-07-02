'use strict';

const assert = require('assert');
const { createWorld, registerEntity, registerLocation } = require('../core/world-engine');
const { createInformation, revealInformation, getKnownInformation } = require('../core/information-engine');
const { getMemories } = require('../core/memory-engine');
const { getCultureByOwner } = require('../core/culture-engine');
const { createReligion, getReligion } = require('../core/religion-engine');
const { buildInfoFlowLinks, processInfoFlowTick, ensureInfoFlowState } = require('../core/info-flow-engine');

function main() {
  const world = buildWorld();
  const links = buildInfoFlowLinks(world, { maxLinksPerTick: 20 });
  assert.ok(links.some(link => link.sourceId === 'entity_a' && link.targetId === 'entity_b'));
  assert.ok(links.some(link => link.targetId === 'org_school'));
  assert.ok(links.some(link => link.targetId === 'city_qingyun'));

  const info = createInformation(world, {
    id: 'info_ritual_trade',
    type: 'report',
    summary: 'Ritual market note',
    content: 'A public ritual market note is known in the city.',
    confidence: 95,
    secrecy: 0,
    spreadability: 100,
    originEntityId: 'entity_a',
    originLocationId: 'loc_qingyun',
    tags: ['ritual', 'trade', 'discovery', 'city'],
  });
  revealInformation(world, info.id, 'entity', 'entity_a', { confidence: 95 });

  const result = processInfoFlowTick(world, { minShareScore: 5, memoryConfidenceThreshold: 30, cultureConfidenceThreshold: 30, religionConfidenceThreshold: 30 });
  assert.ok(getKnownInformation(world, 'entity', 'entity_b').some(entry => entry.informationId === info.id));
  assert.ok(getKnownInformation(world, 'organization', 'org_school').some(entry => entry.informationId === info.id));
  assert.ok(getKnownInformation(world, 'city', 'city_qingyun').some(entry => entry.informationId === info.id));
  assert.ok(getMemories(world, 'entity', 'entity_b').some(memory => memory.payload?.informationId === info.id));
  assert.ok(getCultureByOwner(world, 'city', 'city_qingyun').traits.trade > 0);
  assert.ok(getReligion(world, 'religion_qingyun').believers.includes('entity_b'));
  assert.ok(result.shared.length > 0 && result.memories.length > 0 && result.culture.length > 0 && result.religion.length > 0);
  assert.ok(ensureInfoFlowState(world).events.length > 0);
  console.log('info flow test passed');
}

function buildWorld() {
  const world = createWorld({ id: 'info-flow-world', seed: 'info-flow-seed' });
  world.tick = 12;
  registerLocation(world, { id: 'loc_qingyun', name: 'Qingyun City', type: 'city' });
  registerEntity(world, { id: 'entity_a', name: 'Entity A', species: 'human', status: 'alive', locationId: 'loc_qingyun', stats: { social: 80, intelligence: 50, power: 20 }, organizationIds: ['org_school'] });
  registerEntity(world, { id: 'entity_b', name: 'Entity B', species: 'human', status: 'alive', locationId: 'loc_qingyun', stats: { social: 60, intelligence: 40, power: 15 }, organizationIds: [] });
  world.cities = { byId: { city_qingyun: { id: 'city_qingyun', name: 'Qingyun', type: 'city', locationId: 'loc_qingyun', population: 2, wealth: 1200, security: 65, culture: 40, infrastructureIds: [], organizationIds: ['org_school'] } } };
  world.organizations = { byId: { org_school: { id: 'org_school', name: 'Qingyun School', type: 'school', status: 'active', homeLocationId: 'loc_qingyun', members: ['entity_a'], assets: { currency: 1500 }, culture: ['teaching'], goals: [] } } };
  createReligion(world, { id: 'religion_qingyun', name: 'Qingyun Rite', type: 'doctrine', originLocationId: 'loc_qingyun', doctrines: ['ritual', 'community'], virtues: ['faith'], believers: ['entity_a'], influence: 40 });
  return world;
}

main();
