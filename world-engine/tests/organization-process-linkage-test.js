'use strict';

const assert = require('assert');
const { createWorld, registerLocation, registerEntity } = require('../core/world-engine');
const { assignSpecies } = require('../core/species-engine');
const {
  ORGANIZATION_TYPES,
  createOrganization,
  processOrganizationsTick,
  getOrganizationChronicle,
} = require('../core/organization-engine');
const { createGovernment } = require('../core/governance-engine');
const {
  createDeterministicSimulationKernel,
  initializeDeterministicSimulation,
  runDeterministicSimulationTick,
} = require('../core/deterministic-simulation-engine');

function main() {
  testOrganizationReadsLinkedProcesses();
  testOrganizationProcessLinkagePipeline();
  console.log('organization process linkage test passed');
}

function testOrganizationReadsLinkedProcesses() {
  const { world, org, government } = buildWorld('organization-process-direct');
  seedLinkedProcesses(world, org, government);
  const before = {
    members: org.members.length,
    reputation: org.reputation,
    authority: org.authority,
    cohesion: org.cohesion,
  };

  const changed = processOrganizationsTick(world, testOptions());
  assert.ok(changed.some(item => item.id === org.id), 'organization should be processed');
  assert.ok(org.members.length > before.members, 'organization should add members from linked processes');
  assert.ok(org.reputation > before.reputation, 'support process should improve reputation');
  assert.ok(org.authority > before.authority, 'mobilization process should improve authority');
  assert.ok(org.cohesion >= before.cohesion, 'linked processes should not reduce cohesion in this scenario');
  assert.ok(Object.values(org.roles).includes('relief_worker'), 'disaster relief process should recruit relief worker');
  assert.ok(Object.values(org.roles).includes('auxiliary'), 'mobilization process should recruit auxiliary');
  assert.ok(org.memory.some(memory => memory.type === 'organization.process_link'), 'organization should record linked process memory');
  assert.ok(world.organizations.stats.processLinkedRecruits >= 2, 'organization stats should count process linked recruits');
  assert.ok(world.organizations.stats.processSupportActions >= 2, 'organization stats should count process support actions');

  const chronicle = getOrganizationChronicle(world, org.id);
  assert.ok(chronicle.meta.lastProcessLinkActions.length >= 2, 'chronicle should expose last process link actions');
}

function testOrganizationProcessLinkagePipeline() {
  const { world, org, government } = buildWorld('organization-process-pipeline');
  seedLinkedProcesses(world, org, government);
  const kernel = createDeterministicSimulationKernel({ contractPolicy: 'error' });
  initializeDeterministicSimulation(world, deterministicOptions());
  const beforeMembers = org.members.length;

  const report = runDeterministicSimulationTick(world, { simulation: deterministicOptions() }, kernel);
  assert.strictEqual(report.kernel.contracts.violations, 0, 'organization output should satisfy system contract');
  assert.ok(report.organizations.length >= 1, 'pipeline should process organizations');
  assert.ok(org.members.length > beforeMembers, 'pipeline should recruit via linked processes');
  assert.ok(world.organizations.stats.processLinkedRecruits >= 1, 'pipeline should update process linked recruit stats');
}

function buildWorld(id) {
  const world = createWorld({ id, seed: 'organization-process-linkage-seed' });
  world.tick = 120;
  registerLocation(world, { id: 'capital', name: 'Capital', resources: { food: 40, water: 40 } });

  for (let index = 0; index < 8; index += 1) {
    const entity = registerEntity(world, {
      id: `${id}_citizen_${index}`,
      name: `Citizen ${index}`,
      locationId: 'capital',
      status: 'alive',
      stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 20 + index * 3, social: 45 + index, intelligence: 40 + index },
      resources: { currency: 100 },
      traits: { law: 20, mutual_aid: 30 },
      demographics: { birthTick: -720 * 25, age: 25, ageGroup: 'adult', sex: index % 2 ? 'female' : 'male', fertility: 1, lifeExpectancy: 80, generation: 1 },
    });
    assignSpecies(world, entity.id, 'human');
  }

  const org = createOrganization(world, {
    id: `${id}_state`,
    type: ORGANIZATION_TYPES.STATE,
    name: 'Capital State',
    leaderId: `${id}_citizen_0`,
    homeLocationId: 'capital',
    currency: 1000,
    authority: 70,
    reputation: 80,
    cohesion: 55,
    goals: [],
  });
  const government = createGovernment(world, { id: `${id}_government`, organizationId: org.id, cityIds: [], treasury: 1000, legitimacy: 45, unrest: 50, enforcement: 35, services: 20 });
  return { world, org, government };
}

function seedLinkedProcesses(world, org, government) {
  world.processes = { byId: {}, indexes: { byType: {}, byStatus: {}, byParticipant: {}, byOwner: {} }, consumedMemoryIds: [], consumedGovernanceResponseIds: [], stats: { created: 0, updated: 0, resolved: 0, stalled: 0, pruned: 0 } };
  for (const [index, type] of ['disaster_relief', 'mobilization'].entries()) {
    world.processes.byId[`${world.id}_${type}_process`] = {
      id: `${world.id}_${type}_process`,
      type: 'governance_response',
      status: 'active',
      title: type,
      ownerType: 'government',
      ownerId: government.id,
      startedAt: world.tick - index - 1,
      lastUpdatedAt: world.tick,
      resolvedAt: null,
      progress: 35 + index * 15,
      strength: 2,
      participants: [],
      sourceIds: [],
      steps: [],
      tags: ['organization_linkage', type],
      payload: { responseType: type, governmentId: government.id, organizationId: org.id, cityIds: [], locationIds: ['capital'], severity: 0.8 },
    };
  }
}

function testOptions() {
  return { maxProcessRecruitsPerOrganizationTick: 2, minProcessRecruitScore: 20 };
}

function deterministicOptions() {
  return { ...disabledOptions(), autoOrganizations: true, organization: testOptions() };
}

function disabledOptions() {
  return { seedIndustries: false, autoNatural: false, autoEcology: false, autoConsistency: false, autoPlanActions: false, autoPopulation: false, autoFamilies: false, autoLegacy: false, autoContracts: false, autoEconomy: false, autoCity: false, autoIdentity: false, autoDesire: false, autoOpportunity: false, autoInformation: false, autoMemory: false, autoCulture: false, autoReligion: false, autoCivilization: false, autoTechnology: false, autoInfrastructure: false, autoGovernance: false, autoProcess: false, autoEmergence: false, autoConflict: false, autoPlayers: false, autoHistory: false, autoNarrative: false, autoNovel: false };
}

main();
