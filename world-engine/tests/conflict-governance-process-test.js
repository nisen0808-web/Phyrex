'use strict';

const assert = require('assert');
const { createWorld, registerLocation, registerEntity } = require('../core/world-engine');
const { assignSpecies } = require('../core/species-engine');
const { createOrganization } = require('../core/organization-engine');
const { createGovernment } = require('../core/governance-engine');
const {
  CONFLICT_TYPES,
  CONFLICT_STATUS,
  createConflict,
  processConflictTick,
  getConflictStats,
  getConflictChronicle,
} = require('../core/conflict-engine');
const {
  createDeterministicSimulationKernel,
  initializeDeterministicSimulation,
  runDeterministicSimulationTick,
} = require('../core/deterministic-simulation-engine');

function main() {
  testSecurityCrackdownSuppressesRevolt();
  testMobilizationEscalatesOrganizationConflict();
  testConflictGovernanceProcessInPipeline();
  console.log('conflict governance process test passed');
}

function testSecurityCrackdownSuppressesRevolt() {
  const { world, government, state } = buildWorld('conflict-gov-crackdown');
  const conflict = createConflict(world, {
    type: CONFLICT_TYPES.REVOLT,
    status: CONFLICT_STATUS.ACTIVE,
    title: 'Revolt against Capital State',
    sideA: { type: 'government', id: government.id, entityIds: state.members.slice(0, 4) },
    sideB: { type: 'subjects', id: government.id, entityIds: government.subjectEntityIds.slice(4) },
    locationIds: ['capital'],
    intensity: 120,
    causes: ['unrest'],
    tags: ['governance', 'revolt'],
  });
  seedGovernanceProcess(world, { responseType: 'security_crackdown', governmentId: government.id, organizationId: state.id, severity: 0.85, progress: 40 });

  const before = conflict.intensity;
  const report = processConflictTick(world, { battleChance: 0, decayRate: 0, resolveThreshold: 1 });
  assert.strictEqual(report.governanceProcessEffects.length, 1, 'crackdown should create one conflict effect');
  assert.strictEqual(report.governanceProcessEffects[0].effect, 'suppress_revolt');
  assert.ok(conflict.intensity < before, `revolt intensity should drop from ${before}, got ${conflict.intensity}`);
  assert.ok(conflict.tags.includes('governance_suppressed'), 'conflict should be tagged as governance suppressed');
  assert.ok(conflict.causes.includes('security_crackdown'), 'conflict should record crackdown cause');
  assert.ok(conflict.memory.some(item => item.type === 'conflict.governance_process.suppress_revolt'), 'conflict should record crackdown memory');
  const stats = getConflictStats(world);
  assert.strictEqual(stats.governanceProcessEffects, 1);
  assert.strictEqual(stats.governanceSuppressions, 1);
}

function testMobilizationEscalatesOrganizationConflict() {
  const { world, government, state, rival } = buildWorld('conflict-gov-mobilization');
  const conflict = createConflict(world, {
    type: CONFLICT_TYPES.ORGANIZATION_RIVALRY,
    status: CONFLICT_STATUS.TENSION,
    title: 'State versus Rival Guild',
    sideA: { type: 'organization', id: state.id, entityIds: state.members.slice(0, 4) },
    sideB: { type: 'organization', id: rival.id, entityIds: rival.members.slice(0, 4) },
    locationIds: ['capital'],
    intensity: 70,
    causes: ['rivalry'],
    tags: ['organization'],
  });
  seedGovernanceProcess(world, { responseType: 'mobilization', governmentId: government.id, organizationId: state.id, severity: 0.8, progress: 50 });

  const before = conflict.intensity;
  const report = processConflictTick(world, { battleChance: 0, decayRate: 0, activeThreshold: 500, resolveThreshold: 1 });
  assert.strictEqual(report.governanceProcessEffects.length, 1, 'mobilization should create one conflict effect');
  assert.strictEqual(report.governanceProcessEffects[0].effect, 'mobilize_conflict');
  assert.ok(conflict.intensity > before, `mobilization should raise intensity from ${before}, got ${conflict.intensity}`);
  assert.ok(conflict.tags.includes('governance_mobilization'), 'conflict should be tagged as governance mobilization');
  assert.ok(conflict.causes.includes('mobilization'), 'conflict should record mobilization cause');
  assert.ok(conflict.memory.some(item => item.type === 'conflict.governance_process.mobilize_conflict'), 'conflict should record mobilization memory');
  const chronicle = getConflictChronicle(world, conflict.id);
  assert.ok(chronicle.tags.includes('governance_mobilization'));
  const stats = getConflictStats(world);
  assert.strictEqual(stats.governanceMobilizations, 1);
}

function testConflictGovernanceProcessInPipeline() {
  const { world, government, state } = buildWorld('conflict-gov-pipeline');
  createConflict(world, {
    type: CONFLICT_TYPES.REVOLT,
    status: CONFLICT_STATUS.ACTIVE,
    title: 'Pipeline Revolt',
    sideA: { type: 'government', id: government.id, entityIds: state.members.slice(0, 4) },
    sideB: { type: 'subjects', id: government.id, entityIds: government.subjectEntityIds.slice(4) },
    locationIds: ['capital'],
    intensity: 110,
    causes: ['unrest'],
    tags: ['governance', 'revolt'],
  });
  seedGovernanceProcess(world, { responseType: 'security_crackdown', governmentId: government.id, organizationId: state.id, severity: 0.75, progress: 25 });
  const kernel = createDeterministicSimulationKernel({ contractPolicy: 'error' });
  initializeDeterministicSimulation(world, deterministicOptions());

  const report = runDeterministicSimulationTick(world, { simulation: deterministicOptions() }, kernel);
  assert.strictEqual(report.kernel.contracts.violations, 0, 'conflict output should satisfy system contract');
  assert.ok(report.conflicts.governanceProcessEffects.length >= 1, 'pipeline should apply governance conflict effects');
  assert.strictEqual(getConflictStats(world).governanceSuppressions, 1);
}

function buildWorld(id) {
  const world = createWorld({ id, seed: 'conflict-governance-process-seed' });
  world.tick = 50;
  registerLocation(world, { id: 'capital', name: 'Capital', resources: { food: 300, water: 300 } });

  for (let index = 0; index < 12; index += 1) {
    const entity = registerEntity(world, {
      id: `${id}_citizen_${index}`,
      name: `Citizen ${index}`,
      locationId: 'capital',
      status: 'alive',
      stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10 + index, social: 40 },
      resources: { currency: 100 },
      demographics: { birthTick: -720 * 25, age: 25, ageGroup: 'adult', sex: index % 2 ? 'female' : 'male', fertility: 1, lifeExpectancy: 80, generation: 1 },
    });
    assignSpecies(world, entity.id, 'human');
  }

  const state = createOrganization(world, { id: `${id}_state`, type: 'state', name: 'Capital State', leaderId: `${id}_citizen_0`, homeLocationId: 'capital', currency: 1000, authority: 80, reputation: 100, cohesion: 60 });
  const rival = createOrganization(world, { id: `${id}_rival`, type: 'guild', name: 'Rival Guild', leaderId: `${id}_citizen_8`, homeLocationId: 'capital', currency: 600, authority: 50, reputation: 80, cohesion: 50 });
  for (let index = 1; index < 8; index += 1) if (!state.members.includes(`${id}_citizen_${index}`)) state.members.push(`${id}_citizen_${index}`);
  for (let index = 8; index < 12; index += 1) if (!rival.members.includes(`${id}_citizen_${index}`)) rival.members.push(`${id}_citizen_${index}`);

  world.cities = { byId: { city_capital: { id: 'city_capital', locationId: 'capital', rulerOrganizationId: state.id, organizationIds: [state.id], population: 12, security: 25, risk: 0.6 } }, indexes: { byLocation: { capital: ['city_capital'] } }, pressure: { averageRisk: 0.6, bySettlement: { city_capital: { locationId: 'capital', riskScore: 0.6 } } } };
  const government = createGovernment(world, { id: `${id}_government`, organizationId: state.id, cityIds: ['city_capital'], treasury: 1000, legitimacy: 35, unrest: 80, enforcement: 35, services: 10 });
  government.subjectEntityIds = Object.keys(world.entities);
  return { world, state, rival, government };
}

function seedGovernanceProcess(world, input) {
  world.processes = world.processes || { byId: {}, indexes: { byType: {}, byStatus: {}, byParticipant: {}, byOwner: {} }, consumedMemoryIds: [], consumedGovernanceResponseIds: [], stats: { created: 0, updated: 0, resolved: 0, stalled: 0, pruned: 0 } };
  world.processes.byId[`${world.id}_${input.responseType}_process`] = {
    id: `${world.id}_${input.responseType}_process`,
    type: 'governance_response',
    status: 'active',
    title: input.responseType,
    ownerType: 'government',
    ownerId: input.governmentId,
    startedAt: world.tick - 2,
    lastUpdatedAt: world.tick,
    resolvedAt: null,
    progress: input.progress || 0,
    strength: 2,
    participants: [],
    sourceIds: [],
    steps: [],
    tags: ['governance', input.responseType],
    payload: { responseType: input.responseType, governmentId: input.governmentId, organizationId: input.organizationId, cityIds: ['city_capital'], locationIds: ['capital'], severity: input.severity || 0.5 },
  };
}

function deterministicOptions() {
  return { ...disabledOptions(), autoConflict: true, conflict: { battleChance: 0, decayRate: 0, resolveThreshold: 1 } };
}

function disabledOptions() {
  return { seedIndustries: false, autoNatural: false, autoEcology: false, autoConsistency: false, autoPlanActions: false, autoPopulation: false, autoFamilies: false, autoLegacy: false, autoContracts: false, autoOrganizations: false, autoEconomy: false, autoCity: false, autoIdentity: false, autoDesire: false, autoOpportunity: false, autoInformation: false, autoMemory: false, autoCulture: false, autoReligion: false, autoCivilization: false, autoTechnology: false, autoInfrastructure: false, autoGovernance: false, autoProcess: false, autoEmergence: false, autoPlayers: false, autoHistory: false, autoNarrative: false, autoNovel: false };
}

main();
