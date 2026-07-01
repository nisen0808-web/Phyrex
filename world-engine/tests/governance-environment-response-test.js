'use strict';

const assert = require('assert');
const { createWorld, registerLocation, registerEntity } = require('../core/world-engine');
const { assignSpecies } = require('../core/species-engine');
const { createOrganization } = require('../core/organization-engine');
const {
  createGovernment,
  processGovernanceTick,
  calculateGovernmentEnvironment,
  getGovernanceEnvironmentSummary,
} = require('../core/governance-engine');
const {
  createDeterministicSimulationKernel,
  initializeDeterministicSimulation,
  runDeterministicSimulationTick,
} = require('../core/deterministic-simulation-engine');

function main() {
  testDirectGovernanceEnvironmentResponses();
  testGovernanceEnvironmentInDeterministicPipeline();
  console.log('governance environment response test passed');
}

function testDirectGovernanceEnvironmentResponses() {
  const { world, government } = buildGovernancePressureWorld('governance-env-direct');
  const city = world.cities.byId.city_capital;
  const location = world.locations.capital;
  const market = world.economy.markets.global;
  const before = {
    treasury: government.treasury,
    taxRate: government.policies.taxRate,
    food: location.resources.food,
    water: location.resources.water,
    infrastructure: city.infrastructure,
    security: city.security,
    foodDemand: market.resources.food.demand,
  };

  const environment = calculateGovernmentEnvironment(world, government, governanceTestOptions());
  assert.ok(environment.totalRisk >= 0.65, `expected high governance risk, got ${environment.totalRisk}`);
  assert.strictEqual(environment.activeDisasters, 1);
  assert.ok(environment.recommendedResponses.length >= 4, 'high risk should recommend several responses');

  const report = processGovernanceTick(world, governanceTestOptions());
  assert.ok(report.responses.length >= 4, 'governance should trigger emergency responses');
  assert.strictEqual(new Set(report.responses.map(response => response.id)).size, report.responses.length, 'response ids should be unique');
  assert.ok(report.environment.averageRisk >= 0.65, 'world governance environment summary should retain high risk');
  assert.strictEqual(report.environment.responses, report.responses.length);

  assert.ok(government.treasury < before.treasury, 'responses should spend treasury');
  assert.ok(government.policies.taxRate < before.taxRate, 'high social pressure should lower tax rate');
  assert.ok(location.resources.food > before.food, 'relief should add emergency food');
  assert.ok(location.resources.water > before.water, 'relief should add emergency water');
  assert.ok(city.infrastructure > before.infrastructure, 'public works should improve infrastructure');
  assert.ok(city.security > before.security, 'order response should improve security');
  assert.ok(market.resources.food.demand < before.foodDemand, 'rationing should reduce immediate food demand');
  assert.ok(government.responses.length >= report.responses.length, 'government should retain response log');

  const summary = getGovernanceEnvironmentSummary(world);
  assert.strictEqual(summary.responses, report.responses.length);
  assert.ok(summary.byGovernment[government.id].recommendedResponses.length >= 4);
}

function testGovernanceEnvironmentInDeterministicPipeline() {
  const { world, government } = buildGovernancePressureWorld('governance-env-pipeline');
  const kernel = createDeterministicSimulationKernel({ contractPolicy: 'error' });
  initializeDeterministicSimulation(world, deterministicGovernanceOptions());

  const report = runDeterministicSimulationTick(world, {
    simulation: deterministicGovernanceOptions(),
  }, kernel);

  assert.strictEqual(report.kernel.pipeline, 'modular');
  assert.strictEqual(report.kernel.contracts.violations, 0, 'governance environment output should satisfy system contract');
  assert.ok(report.kernel.order.includes('civilization.governance'));
  assert.ok(report.governance, 'governance report should be present');
  assert.ok(report.governance.environment.averageRisk >= 0.65, 'pipeline should persist governance environment pressure');
  assert.ok(report.governance.responses.length >= 1, 'pipeline should trigger governance responses');
  assert.ok(world.governance.environment.responses >= 1, 'world governance summary should record responses');
  assert.ok(world.governance.environment.byGovernment[government.id], 'world summary should be indexed by government');
}

function buildGovernancePressureWorld(id) {
  const world = createWorld({ id, seed: 'governance-environment-seed' });
  world.tick = 20;
  registerLocation(world, { id: 'capital', name: 'Storm Capital', resources: { food: 4, water: 3, wood: 25 } });

  for (let index = 0; index < 12; index += 1) {
    const entity = registerEntity(world, {
      id: `citizen_${index}`,
      name: `Citizen ${index}`,
      locationId: 'capital',
      status: 'alive',
      stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10 + index, social: 35 },
      resources: { currency: 100, food: 0 },
      meta: { happiness: 32 },
      demographics: { birthTick: -720 * 25, age: 25, ageGroup: 'adult', sex: index % 2 ? 'female' : 'male', fertility: 1, lifeExpectancy: 80, generation: 1 },
    });
    assignSpecies(world, entity.id, 'human');
  }

  const state = createOrganization(world, {
    id: `${id}_state`,
    type: 'state',
    name: 'Storm State',
    leaderId: 'citizen_0',
    homeLocationId: 'capital',
    currency: 1500,
    authority: 82,
    reputation: 120,
    cohesion: 60,
  });
  for (let index = 1; index < 12; index += 1) if (!state.members.includes(`citizen_${index}`)) state.members.push(`citizen_${index}`);

  world.cities = {
    byId: {
      city_capital: {
        id: 'city_capital',
        name: 'Storm Capital',
        type: 'city',
        status: 'failing',
        locationId: 'capital',
        population: 12,
        wealth: 120,
        infrastructure: 8,
        security: 18,
        culture: 10,
        stability: 22,
        risk: 0.9,
        migrationAppeal: 8,
        pressure: {
          tick: world.tick,
          riskScore: 0.9,
          resourcePressure: 0.88,
          foodCoverage: 0.18,
          waterCoverage: 0.12,
          disasterRisk: 0.85,
          populationPressure: 0.72,
          ecologyPressure: 0.45,
          maintenance: { demand: 30, capacity: 5, gap: 0.72 },
        },
        maintenance: { demand: 30, capacity: 5, gap: 0.72 },
        marketId: 'global',
        rulerOrganizationId: state.id,
        organizationIds: [state.id],
        industryIds: ['farm_1', 'service_1'],
        memory: [],
        meta: {},
      },
    },
    indexes: { byType: { city: ['city_capital'] }, byLocation: { capital: ['city_capital'] }, byStatus: { failing: ['city_capital'] } },
    pressure: {
      tick: world.tick,
      settlements: 1,
      highRisk: 1,
      averageRisk: 0.9,
      averageStability: 22,
      averageMigrationAppeal: 8,
      bySettlement: {
        city_capital: {
          locationId: 'capital',
          riskScore: 0.9,
          stability: 22,
          migrationAppeal: 8,
          resourcePressure: 0.88,
          disasterRisk: 0.85,
          ecologyPressure: 0.45,
          populationPressure: 0.72,
        },
      },
    },
    stats: { created: 1, upgraded: 0, declined: 0, pressureUpdates: 1, degraded: 0, maintained: 0, statusChanged: 0 },
  };

  world.population = { environment: { tick: world.tick, entities: 12, highRisk: 12, averageRisk: 0.74, averageMortalityMultiplier: 3.1, averageBirthMultiplier: 0.4, byLocation: { capital: { entities: 12, averageRisk: 0.74, averageMortalityMultiplier: 3.1, averageBirthMultiplier: 0.4 } } } };
  world.natural = { weather: { byLocation: { capital: { locationId: 'capital', type: 'storm', severity: 0.9, temperature: 18, precipitation: 0.8 } } }, disasters: { active: { disaster_1: { id: 'disaster_1', type: 'flood', locationId: 'capital', status: 'active', severity: 0.9, remainingTicks: 4 } } } };
  world.economy = {
    markets: { global: { id: 'global', name: 'Global Market', resources: { food: { resource: 'food', price: 5, basePrice: 1, supply: 20, demand: 300, environmentalDemand: 0, environmentalSupplyShock: 0, volatility: 0.08, history: [] }, water: { resource: 'water', price: 3, basePrice: 1, supply: 15, demand: 250, environmentalDemand: 0, environmentalSupplyShock: 0, volatility: 0.08, history: [] }, service: { resource: 'service', price: 6, basePrice: 6, supply: 40, demand: 140, environmentalDemand: 0, environmentalSupplyShock: 0, volatility: 0.12, history: [] } }, memory: [] } },
    industries: { farm_1: { id: 'farm_1', type: 'agriculture', ownerType: 'organization', ownerId: state.id, locationId: 'capital', status: 'stalled', environment: { riskScore: 0.95 }, workforce: [], inventory: {}, memory: [] }, service_1: { id: 'service_1', type: 'service', ownerType: 'organization', ownerId: state.id, locationId: 'capital', status: 'declining', environment: { riskScore: 0.7 }, workforce: [], inventory: {}, memory: [] } },
    transactions: [],
    environment: { tick: world.tick, industries: 2, highRisk: 2, stalled: 1, averageRisk: 0.82, averageProductionMultiplier: 0.2, averagePricePressure: 0.78, byIndustry: {} },
    indexes: { industriesByLocation: { capital: ['farm_1', 'service_1'] }, industriesByType: { agriculture: ['farm_1'], service: ['service_1'] }, industriesByStatus: { stalled: ['farm_1'], declining: ['service_1'] } },
    stats: { ticks: 0, production: {}, consumption: {}, transactionVolume: 0, environmentUpdates: 2, constrainedIndustries: 1, stalledIndustries: 1 },
  };

  const government = createGovernment(world, { id: `${id}_government`, organizationId: state.id, cityIds: ['city_capital'], policies: { taxRate: 55, lawLevel: 18, welfare: 4, military: 20, openness: 50 }, treasury: 1500, legitimacy: 45, unrest: 62, enforcement: 25, services: 10 });
  return { world, state, government };
}

function governanceTestOptions() {
  return { responseCooldownTicks: 0, maxResponsesPerGovernmentPerTick: 6, minimumTreasuryReserve: 50, disasterReliefThreshold: 0.3, publicWorksThreshold: 0.3, rationingThreshold: 0.3, securityThreshold: 0.3, taxAdjustmentThreshold: 0.3, mobilizationThreshold: 0.3 };
}

function deterministicGovernanceOptions() {
  return { ...disabledSimulationOptions(), autoGovernance: true, governance: governanceTestOptions() };
}

function disabledSimulationOptions() {
  return { seedIndustries: false, autoNatural: false, autoEcology: false, autoConsistency: false, autoPlanActions: false, autoPopulation: false, autoFamilies: false, autoLegacy: false, autoContracts: false, autoOrganizations: false, autoEconomy: false, autoCity: false, autoIdentity: false, autoDesire: false, autoOpportunity: false, autoInformation: false, autoMemory: false, autoCulture: false, autoReligion: false, autoCivilization: false, autoTechnology: false, autoInfrastructure: false, autoProcess: false, autoEmergence: false, autoConflict: false, autoPlayers: false, autoHistory: false, autoNarrative: false, autoNovel: false };
}

main();
