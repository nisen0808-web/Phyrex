'use strict';

const assert = require('assert');
const { createWorld, registerLocation, registerEntity } = require('../core/world-engine');
const { assignSpecies } = require('../core/species-engine');
const { createOrganization } = require('../core/organization-engine');
const { createGovernment } = require('../core/governance-engine');
const { createConflict, CONFLICT_TYPES, CONFLICT_STATUS } = require('../core/conflict-engine');
const {
  OPPORTUNITY_TYPES,
  generateOpportunities,
  processOpportunityTick,
  getOpportunityStats,
} = require('../core/opportunity-engine');
const {
  createDeterministicSimulationKernel,
  initializeDeterministicSimulation,
  runDeterministicSimulationTick,
} = require('../core/deterministic-simulation-engine');

function main() {
  testGovernanceOpportunitiesGenerated();
  testGovernanceOpportunityDeduplication();
  testGovernanceOpportunityPipeline();
  console.log('opportunity governance linkage test passed');
}

function testGovernanceOpportunitiesGenerated() {
  const { world, government } = buildWorld('opportunity-governance-direct');
  seedGovernanceEnvironment(world, government);
  seedGovernanceProcesses(world, government);
  seedConflict(world, government);

  const generated = generateOpportunities(world, { discoveryChance: 0, crisisChance: 0, claimChance: 0, maxGovernanceOpportunitiesPerTick: 20 });
  const governance = generated.filter(opp => opp.tags.includes('governance_generated'));
  assert.ok(governance.length >= 6, `expected governance opportunities, got ${governance.length}`);
  assert.ok(governance.some(opp => opp.type === OPPORTUNITY_TYPES.CRISIS && opp.title.includes('public relief')));
  assert.ok(governance.some(opp => opp.type === OPPORTUNITY_TYPES.TRADE && opp.title.includes('relief supply')));
  assert.ok(governance.some(opp => opp.type === OPPORTUNITY_TYPES.MIGRATION && opp.title.includes('migration support')));
  assert.ok(governance.some(opp => opp.title.includes('public works contract')));
  assert.ok(governance.some(opp => opp.type === OPPORTUNITY_TYPES.ALLIANCE && opp.title.includes('conflict mediation')));
  assert.ok(governance.every(opp => opp.payload.governanceOpportunityKey), 'governance opportunities should have dedupe keys');
  assert.strictEqual(getOpportunityStats(world).governanceGenerated, governance.length);
}

function testGovernanceOpportunityDeduplication() {
  const { world, government } = buildWorld('opportunity-governance-dedupe');
  seedGovernanceEnvironment(world, government);
  seedGovernanceProcesses(world, government);
  seedConflict(world, government);

  const first = generateOpportunities(world, { discoveryChance: 0, crisisChance: 0, claimChance: 0, maxGovernanceOpportunitiesPerTick: 20 }).filter(opp => opp.tags.includes('governance_generated'));
  const second = generateOpportunities(world, { discoveryChance: 0, crisisChance: 0, claimChance: 0, maxGovernanceOpportunitiesPerTick: 20 }).filter(opp => opp.tags.includes('governance_generated'));
  assert.ok(first.length >= 6, 'first generation should create governance opportunities');
  assert.strictEqual(second.length, 0, 'second generation should not duplicate active governance opportunities');
}

function testGovernanceOpportunityPipeline() {
  const { world, government } = buildWorld('opportunity-governance-pipeline');
  seedGovernanceEnvironment(world, government);
  seedGovernanceProcesses(world, government);
  seedConflict(world, government);
  const kernel = createDeterministicSimulationKernel({ contractPolicy: 'error' });
  initializeDeterministicSimulation(world, deterministicOptions());

  const report = runDeterministicSimulationTick(world, { simulation: deterministicOptions() }, kernel);
  assert.strictEqual(report.kernel.contracts.violations, 0, 'opportunity output should satisfy system contract');
  assert.ok(report.opportunities.generated.some(opp => opp.tags.includes('governance_generated')), 'pipeline should create governance opportunities');
  assert.ok(getOpportunityStats(world).governanceGenerated >= 1, 'stats should record governance opportunities');
}

function buildWorld(id) {
  const world = createWorld({ id, seed: 'opportunity-governance-seed' });
  world.tick = 80;
  registerLocation(world, { id: 'capital', name: 'Capital', resources: { food: 20, water: 20, wood: 200 } });
  registerLocation(world, { id: 'safe_hill', name: 'Safe Hill', resources: { food: 500, water: 500 } });

  for (let index = 0; index < 12; index += 1) {
    const entity = registerEntity(world, {
      id: `${id}_citizen_${index}`,
      name: `Citizen ${index}`,
      locationId: 'capital',
      status: 'alive',
      stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10 + index, social: 55, intelligence: 50 },
      resources: { currency: 100 },
      meta: { dominantDesire: index % 3 === 0 ? 'recognition' : 'security' },
      demographics: { birthTick: -720 * 25, age: 25, ageGroup: 'adult', sex: index % 2 ? 'female' : 'male', fertility: 1, lifeExpectancy: 80, generation: 1 },
    });
    assignSpecies(world, entity.id, 'human');
  }

  const state = createOrganization(world, { id: `${id}_state`, type: 'state', name: 'Capital State', leaderId: `${id}_citizen_0`, homeLocationId: 'capital', currency: 1000, authority: 80, reputation: 100, cohesion: 60 });
  for (let index = 1; index < 12; index += 1) if (!state.members.includes(`${id}_citizen_${index}`)) state.members.push(`${id}_citizen_${index}`);

  world.cities = {
    byId: {
      city_capital: { id: 'city_capital', name: 'Capital', locationId: 'capital', population: 12, security: 25, risk: 0.8, migrationAppeal: 10, rulerOrganizationId: state.id, organizationIds: [state.id], pressure: { riskScore: 0.8, resourcePressure: 0.75 } },
    },
    indexes: { byLocation: { capital: ['city_capital'] } },
    pressure: { averageRisk: 0.8, bySettlement: { city_capital: { locationId: 'capital', riskScore: 0.8, migrationAppeal: 10 } } },
  };
  world.economy = { markets: { global: { id: 'global', resources: { food: { demand: 300, supply: 30, price: 5, basePrice: 1, history: [] } } } }, environment: { averageRisk: 0.7, averagePricePressure: 0.7 }, industries: {}, transactions: [], stats: { production: {}, consumption: {} } };
  const government = createGovernment(world, { id: `${id}_government`, organizationId: state.id, cityIds: ['city_capital'], treasury: 1000, legitimacy: 40, unrest: 70, enforcement: 35, services: 10 });
  government.subjectEntityIds = Object.keys(world.entities);
  return { world, state, government };
}

function seedGovernanceEnvironment(world, government) {
  world.governance.environment = {
    tick: world.tick,
    governments: 1,
    highRisk: 1,
    averageRisk: 0.82,
    averageCityRisk: 0.8,
    averageEconomyRisk: 0.7,
    averagePricePressure: 0.72,
    activeDisasters: 1,
    stalledIndustries: 1,
    migrationPressure: 0.6,
    responses: 3,
    byResponseType: { disaster_relief: 1, public_works: 1, rationing: 1 },
    byGovernment: {
      [government.id]: {
        totalRisk: 0.82,
        cityRisk: 0.8,
        economyRisk: 0.7,
        pricePressure: 0.72,
        disasterRisk: 0.75,
        resourcePressure: 0.77,
        migrationPressure: 0.6,
        recommendedResponses: ['disaster_relief', 'public_works', 'rationing'],
      },
    },
  };
}

function seedGovernanceProcesses(world, government) {
  world.processes = { byId: {}, indexes: { byType: {}, byStatus: {}, byParticipant: {}, byOwner: {} }, consumedMemoryIds: [], consumedGovernanceResponseIds: [], stats: { created: 0, updated: 0, resolved: 0, stalled: 0, pruned: 0 } };
  for (const type of ['disaster_relief', 'public_works', 'rationing', 'security_crackdown']) {
    world.processes.byId[`${world.id}_${type}_process`] = {
      id: `${world.id}_${type}_process`,
      type: 'governance_response',
      status: 'active',
      title: type,
      ownerType: 'government',
      ownerId: government.id,
      startedAt: world.tick - 2,
      lastUpdatedAt: world.tick,
      progress: 30,
      strength: 2,
      participants: [],
      sourceIds: [],
      steps: [],
      tags: ['governance', type],
      payload: { responseType: type, governmentId: government.id, organizationId: government.organizationId, cityIds: ['city_capital'], locationIds: ['capital'], severity: 0.8 },
    };
  }
}

function seedConflict(world, government) {
  createConflict(world, {
    id: `${world.id}_conflict`,
    type: CONFLICT_TYPES.REVOLT,
    status: CONFLICT_STATUS.ACTIVE,
    title: 'Capital instability',
    sideA: { type: 'government', id: government.id, entityIds: government.subjectEntityIds.slice(0, 4) },
    sideB: { type: 'subjects', id: government.id, entityIds: government.subjectEntityIds.slice(4) },
    locationIds: ['capital'],
    intensity: 100,
    causes: ['unrest'],
    tags: ['governance_suppressed'],
  });
}

function deterministicOptions() {
  return { ...disabledOptions(), autoOpportunity: true, opportunity: { discoveryChance: 0, crisisChance: 0, claimChance: 0, maxGovernanceOpportunitiesPerTick: 20 } };
}

function disabledOptions() {
  return { seedIndustries: false, autoNatural: false, autoEcology: false, autoConsistency: false, autoPlanActions: false, autoPopulation: false, autoFamilies: false, autoLegacy: false, autoContracts: false, autoOrganizations: false, autoEconomy: false, autoCity: false, autoIdentity: false, autoDesire: false, autoInformation: false, autoMemory: false, autoCulture: false, autoReligion: false, autoCivilization: false, autoTechnology: false, autoInfrastructure: false, autoGovernance: false, autoProcess: false, autoEmergence: false, autoConflict: false, autoPlayers: false, autoHistory: false, autoNarrative: false, autoNovel: false };
}

main();
