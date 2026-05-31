'use strict';

const { recordLifeEvent, LIFE_EVENT_TYPES } = require('./history-engine');

const SETTLEMENT_TYPES = {
  CAMP: 'camp',
  VILLAGE: 'village',
  TOWN: 'town',
  CITY: 'city',
  METROPOLIS: 'metropolis',
  CAPITAL: 'capital',
};

const SETTLEMENT_THRESHOLDS = [
  { type: SETTLEMENT_TYPES.CAMP, minPopulation: 1 },
  { type: SETTLEMENT_TYPES.VILLAGE, minPopulation: 50 },
  { type: SETTLEMENT_TYPES.TOWN, minPopulation: 500 },
  { type: SETTLEMENT_TYPES.CITY, minPopulation: 5000 },
  { type: SETTLEMENT_TYPES.METROPOLIS, minPopulation: 50000 },
  { type: SETTLEMENT_TYPES.CAPITAL, minPopulation: 120000 },
];

function ensureCityState(world) {
  if (!world.cities) {
    world.cities = {
      byId: {},
      indexes: { byType: {}, byLocation: {}, byStatus: {} },
      stats: { created: 0, upgraded: 0, declined: 0 },
    };
  }
  return world.cities;
}

function createSettlement(world, input = {}) {
  const cities = ensureCityState(world);
  const id = input.id || `city_${world.tick}_${Math.random().toString(16).slice(2)}`;
  const settlement = {
    id,
    name: input.name || `Settlement ${id.slice(-6)}`,
    type: input.type || SETTLEMENT_TYPES.CAMP,
    status: input.status || 'active',
    locationId: input.locationId || id,
    foundedTick: input.foundedTick ?? world.tick,
    population: Number(input.population || 0),
    wealth: Number(input.wealth || 0),
    infrastructure: Number(input.infrastructure || 5),
    security: Number(input.security || 50),
    culture: Number(input.culture || 5),
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
  const cities = ensureCityState(world);
  const byLocation = groupAliveEntitiesByLocation(world);
  const created = [];
  const updated = [];

  for (const [locationId, entityIds] of Object.entries(byLocation)) {
    let settlement = findSettlementByLocation(world, locationId);
    if (!settlement && entityIds.length >= (options.minPopulationForSettlement || 5)) {
      settlement = createSettlement(world, { locationId, population: entityIds.length, type: inferSettlementType(entityIds.length) });
      created.push(settlement);
    }
    if (!settlement) continue;
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
  const sync = syncSettlementsFromWorld(world, options);
  for (const settlement of Object.values(ensureCityState(world).byId)) {
    settlement.wealth += Math.round((settlement.infrastructure + settlement.organizationIds.length * 3 + settlement.industryIds.length * 5) * 0.1);
    settlement.culture += Math.round((settlement.organizationIds.length + settlement.industryIds.length) * 0.02);
    settlement.security = calculateSettlementSecurity(world, settlement);
  }
  return sync;
}

function groupAliveEntitiesByLocation(world) {
  const out = {};
  for (const entity of Object.values(world.entities || {})) {
    if (entity.status !== 'alive') continue;
    const locationId = entity.locationId || 'unknown';
    if (!out[locationId]) out[locationId] = [];
    out[locationId].push(entity.id);
  }
  return out;
}

function calculateSettlementWealth(world, settlementId) {
  const settlement = getSettlement(world, settlementId);
  if (!settlement) return 0;
  const entities = Object.values(world.entities || {}).filter(entity => entity.locationId === settlement.locationId && entity.status === 'alive');
  const entityWealth = entities.reduce((sum, entity) => sum + Object.values(entity.resources || {}).reduce((a, b) => a + Number(b || 0), 0), 0);
  const orgWealth = findOrganizationsAtLocation(world, settlement.locationId).reduce((sum, orgId) => {
    const org = world.organizations?.byId?.[orgId];
    return sum + Number(org?.assets?.currency || 0);
  }, 0);
  return Math.round(entityWealth + orgWealth + Number(settlement.wealth || 0) * 0.98);
}

function calculateSettlementSecurity(world, settlement) {
  const orgs = findOrganizationsAtLocation(world, settlement.locationId).map(id => world.organizations?.byId?.[id]).filter(Boolean);
  const authority = orgs.reduce((sum, org) => sum + Number(org.authority || 0), 0);
  const gangPenalty = orgs.filter(org => org.type === 'gang').length * 8;
  return clamp(40 + authority * 0.2 - gangPenalty + settlement.infrastructure * 0.1, 0, 100);
}

function findOrganizationsAtLocation(world, locationId) {
  return Object.values(world.organizations?.byId || {})
    .filter(org => org.homeLocationId === locationId && org.status !== 'dissolved')
    .map(org => org.id);
}

function findIndustriesAtLocation(world, locationId) {
  return Object.values(world.economy?.industries || {})
    .filter(industry => industry.locationId === locationId && industry.status === 'active')
    .map(industry => industry.id);
}

function findSettlementByLocation(world, locationId) {
  return Object.values(ensureCityState(world).byId).find(city => city.locationId === locationId) || null;
}

function inferSettlementType(population) {
  let type = SETTLEMENT_TYPES.CAMP;
  for (const threshold of SETTLEMENT_THRESHOLDS) {
    if (population >= threshold.minPopulation) type = threshold.type;
  }
  return type;
}

function rankSettlementType(type) {
  return SETTLEMENT_THRESHOLDS.findIndex(item => item.type === type);
}

function getSettlement(world, settlementId) {
  return ensureCityState(world).byId[settlementId] || null;
}

function getSettlementChronicle(world, settlementId) {
  const settlement = getSettlement(world, settlementId);
  if (!settlement) return null;
  return {
    settlementId,
    name: settlement.name,
    type: settlement.type,
    status: settlement.status,
    foundedTick: settlement.foundedTick,
    locationId: settlement.locationId,
    population: settlement.population,
    wealth: settlement.wealth,
    infrastructure: settlement.infrastructure,
    security: settlement.security,
    culture: settlement.culture,
    organizationIds: [...settlement.organizationIds],
    industryIds: [...settlement.industryIds],
    memory: [...settlement.memory],
  };
}

function recordCityMemory(world, settlement, type, payload = {}) {
  const memory = { id: `city_memory_${world.tick}_${settlement.memory.length + 1}`, tick: world.tick, type, payload: { settlementId: settlement.id, ...payload } };
  settlement.memory.push(memory);
  if (settlement.memory.length > 500) settlement.memory.shift();
  return memory;
}

function recordRepresentativeLifeEvent(world, settlement, title, summary) {
  const entity = Object.values(world.entities || {}).find(item => item.locationId === settlement.locationId && item.status === 'alive');
  if (!entity) return null;
  return recordLifeEvent(world, {
    entityId: entity.id,
    type: LIFE_EVENT_TYPES.WORLD_EVENT,
    title,
    summary,
    importance: 90,
    locationId: settlement.locationId,
    tags: ['city', settlement.type],
    payload: { settlementId: settlement.id },
  });
}

function rebuildCityIndexes(world) {
  const cities = ensureCityState(world);
  cities.indexes = { byType: {}, byLocation: {}, byStatus: {} };
  for (const city of Object.values(cities.byId)) {
    addIndex(cities.indexes.byType, city.type, city.id);
    addIndex(cities.indexes.byLocation, city.locationId, city.id);
    addIndex(cities.indexes.byStatus, city.status, city.id);
  }
}

function addIndex(index, key, value) {
  if (!index[key]) index[key] = [];
  if (!index[key].includes(value)) index[key].push(value);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

module.exports = {
  SETTLEMENT_TYPES,
  SETTLEMENT_THRESHOLDS,
  ensureCityState,
  createSettlement,
  syncSettlementsFromWorld,
  processCityTick,
  updateSettlementGrowth,
  inferSettlementType,
  getSettlement,
  getSettlementChronicle,
  findSettlementByLocation,
  rebuildCityIndexes,
};
