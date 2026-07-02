'use strict';

const assert = require('assert');
const { createWorld, registerEntity, registerLocation } = require('../core/world-engine');
const { createInformation, revealInformation, getKnownInformation } = require('../core/information-engine');
const { createReligion, getReligion } = require('../core/religion-engine');
const { INFO_FLOW_SYSTEM_ID } = require('../core/info-flow-system-engine');
const {
  createInfoFlowDeterministicKernel,
  runDeterministicSimulationTickWithInfoFlow,
} = require('../core/info-flow-runtime-engine');

function main() {
  const world = buildWorld();
  const info = createInformation(world, {
    id: 'info_runtime_flow',
    type: 'report',
    summary: 'Ritual trade report',
    content: 'A ritual trade report is shared locally.',
    confidence: 95,
    secrecy: 0,
    spreadability: 100,
    originEntityId: 'entity_a',
    originLocationId: 'loc_qingyun',
    tags: ['ritual', 'trade'],
  });
  revealInformation(world, info.id, 'entity', 'entity_a', { confidence: 95 });

  const kernel = createInfoFlowDeterministicKernel({ includeNaturalWorld: false, includeEcologyWorld: false, includeConsistencyWorld: false });
  assert.ok(kernel.registry.systems[INFO_FLOW_SYSTEM_ID]);

  const report = runDeterministicSimulationTickWithInfoFlow(world, { ...disabledOptions(), autoInfoFlow: true, infoFlow: { minShareScore: 5, memoryConfidenceThreshold: 30, cultureConfidenceThreshold: 30, religionConfidenceThreshold: 30 } }, kernel);
  assert.ok(report.kernel.order.includes(INFO_FLOW_SYSTEM_ID));
  assert.ok(report.infoFlow.shared.length > 0);
  assert.ok(getKnownInformation(world, 'entity', 'entity_b').some(entry => entry.informationId === info.id));
  assert.ok(getReligion(world, 'religion_qingyun').believers.includes('entity_b'));
  console.log('info flow runtime test passed');
}

function buildWorld() {
  const world = createWorld({ id: 'info-flow-runtime-world', seed: 'info-flow-runtime-seed' });
  world.tick = 21;
  registerLocation(world, { id: 'loc_qingyun', name: 'Qingyun City', type: 'city' });
  registerEntity(world, { id: 'entity_a', name: 'Entity A', species: 'human', status: 'alive', locationId: 'loc_qingyun', stats: { social: 80 } });
  registerEntity(world, { id: 'entity_b', name: 'Entity B', species: 'human', status: 'alive', locationId: 'loc_qingyun', stats: { social: 60 } });
  world.cities = { byId: { city_qingyun: { id: 'city_qingyun', name: 'Qingyun', type: 'city', locationId: 'loc_qingyun', population: 2, wealth: 1200, security: 65, culture: 40, infrastructureIds: [], organizationIds: ['org_school'] } } };
  world.organizations = { byId: { org_school: { id: 'org_school', name: 'Qingyun School', type: 'school', status: 'active', homeLocationId: 'loc_qingyun', members: ['entity_a'], assets: { currency: 1500 }, culture: ['teaching'], goals: [] } } };
  createReligion(world, { id: 'religion_qingyun', name: 'Qingyun Rite', type: 'doctrine', originLocationId: 'loc_qingyun', doctrines: ['ritual'], virtues: ['faith'], believers: ['entity_a'], influence: 40 });
  return world;
}

function disabledOptions() {
  return { autoPopulation: false, autoFamilies: false, autoLegacy: false, autoContracts: false, autoOrganizations: false, autoEconomy: false, autoCity: false, autoIdentity: false, autoDesire: false, autoOpportunity: false, autoPlanActions: false, autoInformation: false, autoMemory: false, autoCulture: false, autoReligion: false, autoCivilization: false, autoTechnology: false, autoInfrastructure: false, autoGovernance: false, autoProcess: false, autoEmergence: false, autoConflict: false, autoPlayers: false, autoHistory: false, autoNarrative: false, autoNovel: false };
}

main();
