'use strict';

const assert = require('assert');
const { createWorld, registerLocation, registerEntity } = require('../core/world-engine');
const { assignSpecies } = require('../core/species-engine');
const { createOrganization } = require('../core/organization-engine');
const { createGovernment } = require('../core/governance-engine');
const {
  PROCESS_TYPES,
  processProcessesTick,
  getProcessStats,
  getProcessChronicle,
} = require('../core/process-engine');
const {
  createDeterministicSimulationKernel,
  initializeDeterministicSimulation,
  runDeterministicSimulationTick,
} = require('../core/deterministic-simulation-engine');

function main() {
  testGovernanceResponsesBecomeProcesses();
  testGovernanceProcessesRunInDeterministicPipeline();
  console.log('governance process execution test passed');
}

function testGovernanceResponsesBecomeProcesses() {
  const { world, government } = buildWorld('governance-process-direct');
  seedGovernanceResponses(world, government);
  const city = world.cities.byId.city_capital;
  const location = world.locations.capital;
  const before = {
    food: location.resources.food,
    water: location.resources.water,
    infrastructure: city.infrastructure,
    security: city.security,
  };

  const first = processProcessesTick(world, { resolveProgress: 100 });
  assert.strictEqual(first.created.length, 3, 'three governance responses should create three processes');
  assert.strictEqual(world.processes.consumedGovernanceResponseIds.length, 3, 'governance response ids should be consumed');
  assert.ok(first.created.every(process => process.type === PROCESS_TYPES.GOVERNANCE_RESPONSE), 'created processes should be governance response processes');
  assert.ok(location.resources.food > before.food, 'disaster relief process should add food over time');
  assert.ok(location.resources.water > before.water, 'disaster relief process should add water over time');
  assert.ok(city.infrastructure > before.infrastructure, 'public works process should improve infrastructure');
  assert.ok(city.security > before.security, 'security process should improve city security');

  const stats = getProcessStats(world);
  assert.strictEqual(stats.byType[PROCESS_TYPES.GOVERNANCE_RESPONSE], 3);
  assert.strictEqual(stats.governanceResponsesIngested, 3);
  assert.ok(stats.governanceProcessesAdvanced >= 3, 'governance processes should advance during process tick');

  const chronicle = getProcessChronicle(world, first.created[0].id);
  assert.ok(chronicle.payload.responseType, 'chronicle should expose governance response payload');
  assert.ok(chronicle.progress > 0, 'process should make progress');

  for (let index = 0; index < 12; index += 1) {
    world.tick += 1;
    processProcessesTick(world, { resolveProgress: 100 });
  }
  const after = getProcessStats(world);
  assert.ok(after.resolved >= 1, 'governance processes should eventually resolve');
}

function testGovernanceProcessesRunInDeterministicPipeline() {
  const { world, government } = buildWorld('governance-process-pipeline');
  seedGovernanceResponses(world, government, ['public_works']);
  const kernel = createDeterministicSimulationKernel({ contractPolicy: 'error' });
  initializeDeterministicSimulation(world, deterministicOptions());

  const report = runDeterministicSimulationTick(world, { simulation: deterministicOptions() }, kernel);
  assert.strictEqual(report.kernel.pipeline, 'modular');
  assert.strictEqual(report.kernel.contracts.violations, 0, 'process output should satisfy system contract');
  assert.ok(report.kernel.order.includes('civilization.processes'));
  assert.ok(report.processes.created.length >= 1, 'pipeline should create process from governance response');
  assert.strictEqual(world.processes.consumedGovernanceResponseIds.length, 1);
  assert.strictEqual(getProcessStats(world).byType[PROCESS_TYPES.GOVERNANCE_RESPONSE], 1);
}

function buildWorld(id) {
  const world = createWorld({ id, seed: 'governance-process-seed' });
  world.tick = 30;
  registerLocation(world, { id: 'capital', name: 'Capital', resources: { food: 10, water: 8, wood: 100 } });

  for (let index = 0; index < 8; index += 1) {
    const entity = registerEntity(world, {
      id: `${id}_citizen_${index}`,
      name: `Citizen ${index}`,
      locationId: 'capital',
      status: 'alive',
      stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10, social: 40 },
      resources: { currency: 100 },
      demographics: { birthTick: -720 * 25, age: 25, ageGroup: 'adult', sex: index % 2 ? 'female' : 'male', fertility: 1, lifeExpectancy: 80, generation: 1 },
    });
    assignSpecies(world, entity.id, 'human');
  }

  const org = createOrganization(world, {
    id: `${id}_state`,
    type: 'state',
    name: 'Capital State',
    leaderId: `${id}_citizen_0`,
    homeLocationId: 'capital',
    currency: 1000,
    authority: 80,
    reputation: 100,
    cohesion: 50,
  });
  for (let index = 1; index < 8; index += 1) if (!org.members.includes(`${id}_citizen_${index}`)) org.members.push(`${id}_citizen_${index}`);

  world.cities = {
    byId: {
      city_capital: {
        id: 'city_capital',
        name: 'Capital',
        type: 'city',
        status: 'strained',
        locationId: 'capital',
        population: 8,
        wealth: 100,
        infrastructure: 5,
        security: 20,
        stability: 25,
        risk: 0.75,
        migrationAppeal: 20,
        maintenance: { demand: 20, capacity: 5, gap: 0.6 },
        pressure: { riskScore: 0.75, resourcePressure: 0.7, foodCoverage: 0.2, waterCoverage: 0.2, maintenance: { demand: 20, capacity: 5, gap: 0.6 } },
        rulerOrganizationId: org.id,
        organizationIds: [org.id],
        industryIds: [],
        memory: [],
        meta: {},
      },
    },
    indexes: { byLocation: { capital: ['city_capital'] }, byType: { city: ['city_capital'] }, byStatus: { strained: ['city_capital'] } },
    pressure: { averageRisk: 0.75, bySettlement: { city_capital: { locationId: 'capital', riskScore: 0.75, migrationAppeal: 20 } } },
    stats: { created: 1 },
  };

  world.economy = { markets: { global: { id: 'global', resources: { food: { demand: 200, supply: 20, price: 5, basePrice: 1, history: [] } } } }, industries: {}, transactions: [], environment: { averageRisk: 0.7, averagePricePressure: 0.6 }, stats: { production: {}, consumption: {} } };
  const government = createGovernment(world, { id: `${id}_government`, organizationId: org.id, cityIds: ['city_capital'], treasury: 1000, legitimacy: 50, unrest: 55, enforcement: 20, services: 10 });
  return { world, org, government };
}

function seedGovernanceResponses(world, government, types = ['disaster_relief', 'public_works', 'security_crackdown']) {
  world.governance.responseLog = types.map((type, index) => ({
    id: `${world.id}_response_${index}`,
    tick: world.tick,
    type,
    status: 'active',
    governmentId: government.id,
    organizationId: government.organizationId,
    cityIds: ['city_capital'],
    locationIds: ['capital'],
    severity: 0.8,
    reason: 'test response',
    inputs: { totalRisk: 0.8, cityRisk: 0.75, resourcePressure: 0.7 },
    effects: {},
  }));
}

function deterministicOptions() {
  return { ...disabledOptions(), autoProcess: true };
}

function disabledOptions() {
  return {
    seedIndustries: false,
    autoNatural: false,
    autoEcology: false,
    autoConsistency: false,
    autoPlanActions: false,
    autoPopulation: false,
    autoFamilies: false,
    autoLegacy: false,
    autoContracts: false,
    autoOrganizations: false,
    autoEconomy: false,
    autoCity: false,
    autoIdentity: false,
    autoDesire: false,
    autoOpportunity: false,
    autoInformation: false,
    autoMemory: false,
    autoCulture: false,
    autoReligion: false,
    autoCivilization: false,
    autoTechnology: false,
    autoInfrastructure: false,
    autoGovernance: false,
    autoEmergence: false,
    autoConflict: false,
    autoPlayers: false,
    autoHistory: false,
    autoNarrative: false,
    autoNovel: false,
  };
}

main();
