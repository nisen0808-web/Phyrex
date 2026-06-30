'use strict';

const { recordLifeEvent, LIFE_EVENT_TYPES } = require('./history-engine');
const { nextWorldId } = require('./world-id-engine');

const SETTLEMENT_TYPES = {
  CAMP: 'camp',
  VILLAGE: 'village',
  TOWN: 'town',
  CITY: 'city',
  METROPOLIS: 'metropolis',
  CAPITAL: 'capital',
};

const CITY_STATUS = {
  ACTIVE: 'active',
  STRAINED: 'strained',
  DECLINING: 'declining',
  FAILING: 'failing',
};

const SETTLEMENT_THRESHOLDS = [
  { type: SETTLEMENT_TYPES.CAMP, minPopulation: 1 },
  { type: SETTLEMENT_TYPES.VILLAGE, minPopulation: 50 },
  { type: SETTLEMENT_TYPES.TOWN, minPopulation: 500 },
  { type: SETTLEMENT_TYPES.CITY, minPopulation: 5000 },
  { type: SETTLEMENT_TYPES.METROPOLIS, minPopulation: 50000 },
  { type: SETTLEMENT_TYPES.CAPITAL, minPopulation: 120000 },
];

const DEFAULT_CITY_PRESSURE_OPTIONS = {
  foodDemandPerPerson: 0.35,
  waterDemandPerPerson: 0.45,
  minimumFoodDemand: 10,
  minimumWaterDemand: 10,
  pressureMemoryLimit: 120,
  infrastructureRepairRate: 1,
  infrastructureDecayRate: 2,
  wealthStressRate: 0.02,
  securityStressRate: 2,
};

function ensureCityState(world) {
  if (!world.cities) {
    world.cities = {
      byId: {},
      indexes: { byType: {}, byLocation: {}, byStatus: {} },
      pressure: createEmptyCityPressureSummary(world.tick),
      stats: { created: 0, upgraded: 0, declined: 0, pressureUpdates: 0, degraded: 0, maintained: 0, statusChanged: 0 },
    };
  }
  if (!world.cities.indexes) world.cities.indexes = { byType: {}, byLocation: {}, byStatus: {} };
  if (!world.cities.stats) world.cities.stats = { created: 0, upgraded: 0, declined: 0 };
  if (!world.cities.pressure) world.cities.pressure = createEmptyCityPressureSummary(world.tick);
  ensureCityStats(world.cities);
  return world.cities;
}

function createSettlement(world, input = {}) {
  const cities = ensureCityState(world);
  const id = input.id || nextWorldId(world, 'city', 'city.create');
  const settlement = {
    id,
    name: input.name || `Settlement ${String(id).slice(-6)}`,
    type: input.type || SETTLEMENT_TYPES.CAMP,
    status: input.status || CITY_STATUS.ACTIVE,
    locationId: input.locationId || id,
    foundedTick: input.foundedTick ?? world.tick,
    population: Number(input.population || 0),
    wealth: Number(input.wealth || 0),
    infrastructure: Number(input.infrastructure || 5),
    security: Number(input.security || 50),
    culture: Number(input.culture || 5),
    stability: Number(input.stability ?? 70),
    risk: Number(input.risk || 0),
    migrationAppeal: Number(input.migrationAppeal ?? 50),
    pressure: createEmptySettlementPressure(world.tick),
    maintenance: { demand: 0, capacity: 0, gap: 0 },
    marketId: input.marketId || 'global',
    rulerOrganizationId: input.rulerOrganizationId || null,
    organizationIds: Array.isArray(input.organizationIds) ? [...input.organizationIds] : [],
    industryIds: Array.isArray(input.industryIds) ? [...input.industryIds] : [],
    memory: [],
    meta: { ...(input.meta || {}) },
  };
  cities.byId[id] = settlement;
  cities.stats.created += 1;
  recordCityMemory(world, settlement, 'city.created', {});
  rebuildCityIndexes(world);
  return settlement;
}

function syncSettlementsFromWorld(world, options = {}) {
  const byLocation = groupAliveEntitiesByLocation(world);
  const created = [];
  const updated = [];
  ensureCityState(world);
  for (const [locationId, entityIds] of Object.entries(byLocation)) {
    let settlement = findSettlementByLocation(world, locationId);
    if (!settlement && entityIds.length >= (options.minPopulationForSettlement || 5)) {
      settlement = createSettlement(world, { locationId, population: entityIds.length, type: inferSettlementType(entityIds.length) });
      created.push(settlement);
    }
    if (!settlement) continue;
    ensureSettlementEnvironmentFields(world, settlement);
    settlement.population = entityIds.length;
    settlement.type = inferSettlementType(settlement.population);
    settlement.wealth = calculateSettlementWealth(world, settlement.id);
    settlement.infrastructure = Math.max(settlement.infrastructure, Math.round(Math.sqrt(settlement.population)));
    settlement.security = calculateSettlementSecurity(world, settlement);
    settlement.organizationIds = findOrganizationsAtLocation(world, locationId);
    settlement.industryIds = findIndustriesAtLocation(world, locationId);
    updated.push(settlement);
  }
  updateSettlementGrowth(world);
  rebuildCityIndexes(world);
  return { created, updated };
}

function updateSettlementGrowth(world) {
  const cities = ensureCityState(world);
  for (const settlement of Object.values(cities.byId)) {
    const previousType = settlement.meta.lastType || settlement.type;
    const inferred = inferSettlementType(settlement.population);
    settlement.type = inferred;
    if (rankSettlementType(inferred) > rankSettlementType(previousType)) {
      cities.stats.upgraded += 1;
      recordCityMemory(world, settlement, 'city.upgraded', { from: previousType, to: inferred });
      recordRepresentativeLifeEvent(world, settlement, 'city upgraded', `Settlement ${settlement.name} grew from ${previousType} to ${inferred}.`);
    }
    if (rankSettlementType(inferred) < rankSettlementType(previousType)) {
      cities.stats.declined += 1;
      recordCityMemory(world, settlement, 'city.declined', { from: previousType, to: inferred });
    }
    settlement.meta.lastType = inferred;
  }
}

function processCityTick(world, options = {}) {
  const config = mergeCityPressureOptions(options);
  const sync = syncSettlementsFromWorld(world, config);
  const pressureUpdates = [];
  const maintained = [];
  const degraded = [];
  const statusChanged = [];
  for (const settlement of Object.values(ensureCityState(world).byId)) {
    ensureSettlementEnvironmentFields(world, settlement);
    const pressure = calculateCityPressure(world, settlement, config);
    const effect = applyCityPressureEffects(world, settlement, pressure, config);
    pressureUpdates.push({ settlementId: settlement.id, locationId: settlement.locationId, ...pressure });
    if (effect.maintained) maintained.push(effect.maintained);
    if (effect.degraded) degraded.push(effect.degraded);
    if (effect.statusChanged) statusChanged.push(effect.statusChanged);
    settlement.wealth += Math.round((settlement.infrastructure + settlement.organizationIds.length * 3 + settlement.industryIds.length * 5) * 0.1 * (1 - pressure.riskScore * 0.55));
    settlement.culture += Math.round((settlement.organizationIds.length + settlement.industryIds.length) * 0.02 * (1 - pressure.riskScore * 0.25));
    settlement.security = calculateSettlementSecurity(world, settlement);
  }
  const summary = summarizeCityPressure(world, pressureUpdates);
  const cities = ensureCityState(world);
  cities.pressure = summary;
  cities.stats.pressureUpdates += pressureUpdates.length;
  cities.stats.maintained += maintained.length;
  cities.stats.degraded += degraded.length;
  cities.stats.statusChanged += statusChanged.length;
  rebuildCityIndexes(world);
  return { ...sync, pressure: summary, pressureUpdates, maintained, degraded, statusChanged };
}

function calculateCityPressure(world, settlement, options = {}) {
  const config = mergeCityPressureOptions(options);
  const location = world.locations?.[settlement.locationId] || {};
  const resources = location.resources || {};
  const populationEnvironment = world.population?.environment?.byLocation?.[settlement.locationId] || null;
  const weather = world.natural?.weather?.byLocation?.[settlement.locationId] || { type: 'clear', severity: 0 };
  const ecologyHabitat = world.ecology?.habitats?.byLocation?.[settlement.locationId] || null;
  const humanPopulation = world.ecology?.populations?.byKey?.[`${settlement.locationId}:human`] || null;
  const resourcePressure = calculateCityResourcePressure(settlement, resources, config);
  const populationPressure = populationEnvironment ? clamp(Number(populationEnvironment.averageRisk || 0), 0, 1) : 0;
  const disasterRisk = calculateCityDisasterRisk(world, settlement.locationId, weather);
  const ecologyPressure = calculateCityEcologyPressure(ecologyHabitat, humanPopulation);
  const infrastructurePressure = calculateInfrastructurePressure(settlement);
  const securityPressure = clamp(1 - Number(settlement.security || 0) / 100, 0, 1);
  const maintenance = calculateCityMaintenance(settlement, resourcePressure, disasterRisk, ecologyPressure);
  const riskScore = clamp(resourcePressure.total * 0.25 + populationPressure * 0.18 + disasterRisk * 0.22 + ecologyPressure * 0.14 + infrastructurePressure * 0.13 + securityPressure * 0.08, 0, 1);
  const wealthPerCapita = settlement.population > 0 ? Number(settlement.wealth || 0) / settlement.population : Number(settlement.wealth || 0);
  const stability = clamp(100 - riskScore * 85 - maintenance.gap * 18 + Number(settlement.security || 0) * 0.18 + Number(settlement.infrastructure || 0) * 0.12 + Math.min(20, wealthPerCapita * 0.2), 0, 100);
  const migrationAppeal = clamp(stability * 0.55 + Number(settlement.security || 0) * 0.2 + Math.min(25, wealthPerCapita * 0.25) - resourcePressure.total * 35 - disasterRisk * 25, 0, 100);
  return { tick: Number(world.tick || 0), resourcePressure: round(resourcePressure.total, 3), foodCoverage: round(resourcePressure.foodCoverage, 3), waterCoverage: round(resourcePressure.waterCoverage, 3), populationPressure: round(populationPressure, 3), disasterRisk: round(disasterRisk, 3), ecologyPressure: round(ecologyPressure, 3), infrastructurePressure: round(infrastructurePressure, 3), securityPressure: round(securityPressure, 3), riskScore: round(riskScore, 3), stability: round(stability, 2), migrationAppeal: round(migrationAppeal, 2), maintenance };
}

function applyCityPressureEffects(world, settlement, pressure, options = {}) {
  const config = mergeCityPressureOptions(options);
  const beforeStatus = settlement.status;
  const beforeInfrastructure = settlement.infrastructure;
  const beforeWealth = settlement.wealth;
  settlement.pressure = pressure;
  settlement.risk = pressure.riskScore;
  settlement.stability = pressure.stability;
  settlement.migrationAppeal = pressure.migrationAppeal;
  settlement.maintenance = pressure.maintenance;
  settlement.status = inferCityStatus(pressure);
  const effect = { settlementId: settlement.id };
  if (pressure.maintenance.gap > 0.35 || pressure.riskScore > 0.65) {
    const infrastructureLoss = Math.max(1, Math.round(config.infrastructureDecayRate * pressure.riskScore + pressure.maintenance.gap));
    const wealthLoss = Math.max(0, Math.round(settlement.population * config.wealthStressRate * pressure.riskScore + pressure.maintenance.gap * 3));
    settlement.infrastructure = clamp(settlement.infrastructure - infrastructureLoss, 0, 1000000);
    settlement.wealth = Math.max(0, Math.round(settlement.wealth - wealthLoss));
    effect.degraded = { settlementId: settlement.id, infrastructureLoss, wealthLoss };
    recordCityMemory(world, settlement, 'city.pressure.degraded', { riskScore: pressure.riskScore, infrastructureLoss, wealthLoss });
  } else if (pressure.riskScore < 0.25 && pressure.maintenance.gap <= 0.05) {
    settlement.infrastructure += config.infrastructureRepairRate;
    effect.maintained = { settlementId: settlement.id, infrastructureGain: config.infrastructureRepairRate };
    recordCityMemory(world, settlement, 'city.pressure.maintained', { riskScore: pressure.riskScore, infrastructureGain: config.infrastructureRepairRate });
  }
  if (beforeStatus !== settlement.status) {
    effect.statusChanged = { settlementId: settlement.id, from: beforeStatus, to: settlement.status };
    recordCityMemory(world, settlement, 'city.status.changed', { from: beforeStatus, to: settlement.status, riskScore: pressure.riskScore });
  }
  settlement.security = clamp(settlement.security - pressure.riskScore * config.securityStressRate + Math.max(0, 0.4 - pressure.riskScore), 0, 100);
  settlement.meta.lastPressure = pressure;
  settlement.meta.lastPressureTick = Number(world.tick || 0);
  settlement.meta.lastInfrastructureDelta = round(settlement.infrastructure - beforeInfrastructure, 3);
  settlement.meta.lastWealthDelta = round(settlement.wealth - beforeWealth, 3);
  return effect;
}

function summarizeCityPressure(world, pressureUpdates) {
  const updates = pressureUpdates || [];
  if (!updates.length) return createEmptyCityPressureSummary(world.tick);
  const highRisk = updates.filter(item => item.riskScore >= 0.65).length;
  return { tick: Number(world.tick || 0), settlements: updates.length, highRisk, averageRisk: round(average(updates.map(item => item.riskScore)), 3), averageStability: round(average(updates.map(item => item.stability)), 2), averageMigrationAppeal: round(average(updates.map(item => item.migrationAppeal)), 2), bySettlement: Object.fromEntries(updates.map(item => [item.settlementId, { locationId: item.locationId, riskScore: item.riskScore, stability: item.stability, migrationAppeal: item.migrationAppeal, resourcePressure: item.resourcePressure, disasterRisk: item.disasterRisk, ecologyPressure: item.ecologyPressure, populationPressure: item.populationPressure }])) };
}

function groupAliveEntitiesByLocation(world) { const out = {}; for (const entity of Object.values(world.entities || {})) { if (entity.status !== 'alive') continue; const locationId = entity.locationId || 'unknown'; if (!out[locationId]) out[locationId] = []; out[locationId].push(entity.id); } return out; }
function calculateSettlementWealth(world, settlementId) { const settlement = getSettlement(world, settlementId); if (!settlement) return 0; const entities = Object.values(world.entities || {}).filter(entity => entity.locationId === settlement.locationId && entity.status === 'alive'); const entityWealth = entities.reduce((sum, entity) => sum + Object.values(entity.resources || {}).reduce((a, b) => a + Number(b || 0), 0), 0); const orgWealth = findOrganizationsAtLocation(world, settlement.locationId).reduce((sum, orgId) => { const org = world.organizations?.byId?.[orgId]; return sum + Number(org?.assets?.currency || 0); }, 0); return Math.round(entityWealth + orgWealth + Number(settlement.wealth || 0) * 0.98); }
function calculateSettlementSecurity(world, settlement) { const orgs = findOrganizationsAtLocation(world, settlement.locationId).map(id => world.organizations?.byId?.[id]).filter(Boolean); const authority = orgs.reduce((sum, org) => sum + Number(org.authority || 0), 0); const gangPenalty = orgs.filter(org => org.type === 'gang').length * 8; const riskPenalty = Number(settlement.risk || 0) * 12; return clamp(40 + authority * 0.2 - gangPenalty + settlement.infrastructure * 0.1 - riskPenalty, 0, 100); }
function calculateCityResourcePressure(settlement, resources, config) { const population = Math.max(1, Number(settlement.population || 0)); const foodDemand = Math.max(config.minimumFoodDemand, population * config.foodDemandPerPerson); const waterDemand = Math.max(config.minimumWaterDemand, population * config.waterDemandPerPerson); const foodCoverage = clamp(Number(resources.food || 0) / foodDemand, 0, 2); const waterCoverage = clamp(Number(resources.water || 0) / waterDemand, 0, 2); const foodPressure = clamp(1 - foodCoverage, 0, 1); const waterPressure = clamp(1 - waterCoverage, 0, 1); return { total: clamp(foodPressure * 0.48 + waterPressure * 0.52, 0, 1), foodCoverage, waterCoverage }; }
function calculateCityDisasterRisk(world, locationId, weather) { const weatherRisk = weatherRiskScore(weather.type, weather.severity); const activeDisasterRisk = Object.values(world.natural?.disasters?.active || {}).filter(disaster => disaster.locationId === locationId).reduce((sum, disaster) => sum + Number(disaster.severity || 0) * 0.55, 0); return clamp(weatherRisk + activeDisasterRisk, 0, 1); }
function calculateCityEcologyPressure(habitat, population) { const suitability = habitat ? Number(habitat.suitability?.human ?? habitat.suitability?.sentient ?? 0.5) : 0.5; const carryingPressure = population ? clamp(Math.max(0, Number(population.pressure || 0) - 1), 0, 2) / 2 : 0; const diseaseLoad = population ? clamp(Number(population.diseaseLoad || 0), 0, 1) : 0; const healthPenalty = population ? clamp(1 - Number(population.health ?? 0.75), 0, 1) : 0; return clamp((1 - suitability) * 0.35 + carryingPressure * 0.35 + diseaseLoad * 0.2 + healthPenalty * 0.1, 0, 1); }
function calculateInfrastructurePressure(settlement) { const desired = Math.max(5, Math.sqrt(Math.max(1, Number(settlement.population || 0))) * 2); return clamp(1 - Number(settlement.infrastructure || 0) / desired, 0, 1); }
function calculateCityMaintenance(settlement, resourcePressure, disasterRisk, ecologyPressure) { const demand = Number(settlement.infrastructure || 0) * (0.02 + disasterRisk * 0.06 + resourcePressure.total * 0.03) + Number(settlement.population || 0) * 0.004; const capacity = Number(settlement.wealth || 0) * 0.002 + Number(settlement.security || 0) * 0.03 + (settlement.organizationIds || []).length * 1.5 + (settlement.industryIds || []).length * 1.2 + Math.max(0, 1 - ecologyPressure) * 2; const gap = demand <= 0 ? 0 : clamp((demand - capacity) / demand, 0, 1); return { demand: round(demand, 3), capacity: round(capacity, 3), gap: round(gap, 3) }; }
function inferCityStatus(pressure) { if (pressure.stability <= 20 || pressure.riskScore >= 0.85) return CITY_STATUS.FAILING; if (pressure.stability <= 40 || pressure.riskScore >= 0.68) return CITY_STATUS.DECLINING; if (pressure.stability <= 60 || pressure.riskScore >= 0.45) return CITY_STATUS.STRAINED; return CITY_STATUS.ACTIVE; }
function weatherRiskScore(type, severity) { const base = { clear: 0, cloudy: 0.02, rain: 0.08, storm: 0.55, snow: 0.22, drought: 0.6, heatwave: 0.55, cold_snap: 0.45 }[type] || 0.03; return clamp(base + Number(severity || 0) * 0.3, 0, 1); }
function findOrganizationsAtLocation(world, locationId) { return Object.values(world.organizations?.byId || {}).filter(org => org.homeLocationId === locationId && org.status !== 'dissolved').map(org => org.id); }
function findIndustriesAtLocation(world, locationId) { return Object.values(world.economy?.industries || {}).filter(industry => industry.locationId === locationId && industry.status !== 'stalled').map(industry => industry.id); }
function findSettlementByLocation(world, locationId) { return Object.values(ensureCityState(world).byId).find(city => city.locationId === locationId) || null; }
function inferSettlementType(population) { let type = SETTLEMENT_TYPES.CAMP; for (const threshold of SETTLEMENT_THRESHOLDS) if (population >= threshold.minPopulation) type = threshold.type; return type; }
function rankSettlementType(type) { return SETTLEMENT_THRESHOLDS.findIndex(item => item.type === type); }
function getSettlement(world, settlementId) { return ensureCityState(world).byId[settlementId] || null; }
function getSettlementChronicle(world, settlementId) { const settlement = getSettlement(world, settlementId); if (!settlement) return null; return { settlementId, name: settlement.name, type: settlement.type, status: settlement.status, foundedTick: settlement.foundedTick, locationId: settlement.locationId, population: settlement.population, wealth: settlement.wealth, infrastructure: settlement.infrastructure, security: settlement.security, culture: settlement.culture, stability: settlement.stability, risk: settlement.risk, migrationAppeal: settlement.migrationAppeal, pressure: settlement.pressure, maintenance: settlement.maintenance, organizationIds: [...settlement.organizationIds], industryIds: [...settlement.industryIds], memory: [...settlement.memory] }; }
function recordCityMemory(world, settlement, type, payload = {}) { const memory = { id: `city_memory_${world.tick}_${settlement.memory.length + 1}`, tick: world.tick, type, payload: { settlementId: settlement.id, ...payload } }; settlement.memory.push(memory); if (settlement.memory.length > 500) settlement.memory.shift(); return memory; }
function recordRepresentativeLifeEvent(world, settlement, title, summary) { const entity = Object.values(world.entities || {}).find(item => item.locationId === settlement.locationId && item.status === 'alive'); if (!entity) return null; return recordLifeEvent(world, { entityId: entity.id, type: LIFE_EVENT_TYPES.WORLD_EVENT, title, summary, importance: 90, locationId: settlement.locationId, tags: ['city', settlement.type], payload: { settlementId: settlement.id } }); }
function rebuildCityIndexes(world) { const cities = ensureCityState(world); cities.indexes = { byType: {}, byLocation: {}, byStatus: {} }; for (const city of Object.values(cities.byId)) { addIndex(cities.indexes.byType, city.type, city.id); addIndex(cities.indexes.byLocation, city.locationId, city.id); addIndex(cities.indexes.byStatus, city.status, city.id); } }
function ensureSettlementEnvironmentFields(world, settlement) { if (settlement.stability === undefined) settlement.stability = 70; if (settlement.risk === undefined) settlement.risk = 0; if (settlement.migrationAppeal === undefined) settlement.migrationAppeal = 50; if (!settlement.pressure) settlement.pressure = createEmptySettlementPressure(world.tick); if (!settlement.maintenance) settlement.maintenance = { demand: 0, capacity: 0, gap: 0 }; if (!settlement.meta) settlement.meta = {}; }
function createEmptySettlementPressure(tick = 0) { return { tick, resourcePressure: 0, foodCoverage: 1, waterCoverage: 1, populationPressure: 0, disasterRisk: 0, ecologyPressure: 0, infrastructurePressure: 0, securityPressure: 0, riskScore: 0, stability: 70, migrationAppeal: 50, maintenance: { demand: 0, capacity: 0, gap: 0 } }; }
function createEmptyCityPressureSummary(tick = 0) { return { tick, settlements: 0, highRisk: 0, averageRisk: 0, averageStability: 0, averageMigrationAppeal: 0, bySettlement: {} }; }
function ensureCityStats(cities) { for (const key of ['created', 'upgraded', 'declined', 'pressureUpdates', 'degraded', 'maintained', 'statusChanged']) if (cities.stats[key] === undefined) cities.stats[key] = 0; }
function mergeCityPressureOptions(options = {}) { return { ...DEFAULT_CITY_PRESSURE_OPTIONS, ...(options || {}) }; }
function addIndex(index, key, value) { if (!index[key]) index[key] = []; if (!index[key].includes(value)) index[key].push(value); }
function average(values) { const filtered = (values || []).filter(Number.isFinite); return filtered.length ? filtered.reduce((sum, value) => sum + value, 0) / filtered.length : 0; }
function round(value, digits = 3) { const factor = 10 ** digits; return Math.round(Number(value || 0) * factor) / factor; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value || 0))); }

module.exports = { SETTLEMENT_TYPES, CITY_STATUS, SETTLEMENT_THRESHOLDS, DEFAULT_CITY_PRESSURE_OPTIONS, ensureCityState, createSettlement, syncSettlementsFromWorld, processCityTick, updateSettlementGrowth, calculateCityPressure, applyCityPressureEffects, summarizeCityPressure, inferSettlementType, getSettlement, getSettlementChronicle, findSettlementByLocation, rebuildCityIndexes };
