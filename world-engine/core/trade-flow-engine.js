'use strict';

const { nextWorldId } = require('./world-id-engine');

const TRADE_FLOW_RESOURCE_TYPES = ['food', 'water', 'wood', 'stone', 'metal', 'fuel', 'luxury'];

const DEFAULT_TRADE_FLOW_OPTIONS = {
  maxTradeFlowsPerTick: 12,
  minimumSurplus: 25,
  minimumDeficit: 10,
  maxRouteShare: 0.25,
  cityRiskPenalty: 0.45,
  pricePressureMultiplier: 0.35,
  flowMemoryLimit: 400,
};

function ensureTradeFlowState(world) {
  if (!world.economy) world.economy = { markets: {}, industries: {}, transactions: [], stats: { ticks: 0, production: {}, consumption: {}, transactionVolume: 0 } };
  if (!world.economy.tradeFlows || typeof world.economy.tradeFlows !== 'object') world.economy.tradeFlows = createEmptyTradeFlowSummary(world.tick);
  if (!Array.isArray(world.economy.tradeFlowLog)) world.economy.tradeFlowLog = [];
  if (!world.economy.stats || typeof world.economy.stats !== 'object') world.economy.stats = { ticks: 0, production: {}, consumption: {}, transactionVolume: 0 };
  if (world.economy.stats.tradeFlowVolume === undefined) world.economy.stats.tradeFlowVolume = 0;
  if (world.economy.stats.tradeFlowCount === undefined) world.economy.stats.tradeFlowCount = 0;
  return world.economy.tradeFlows;
}

function processTradeFlows(world, options = {}, helpers = {}) {
  const config = { ...DEFAULT_TRADE_FLOW_OPTIONS, ...(options || {}) };
  ensureTradeFlowState(world);
  const candidates = buildTradeFlowCandidates(world, config);
  const flows = [];
  for (const candidate of candidates) {
    if (flows.length >= Number(config.maxTradeFlowsPerTick || DEFAULT_TRADE_FLOW_OPTIONS.maxTradeFlowsPerTick)) break;
    const flow = applyTradeFlow(world, candidate, config, helpers);
    if (flow) flows.push(flow);
  }
  const summary = summarizeTradeFlows(world, flows);
  world.economy.tradeFlows = summary;
  world.economy.tradeFlowLog.push(...flows);
  while (world.economy.tradeFlowLog.length > Number(config.flowMemoryLimit || DEFAULT_TRADE_FLOW_OPTIONS.flowMemoryLimit)) world.economy.tradeFlowLog.shift();
  world.economy.stats.tradeFlowCount += flows.length;
  world.economy.stats.tradeFlowVolume += flows.reduce((sum, flow) => sum + Number(flow.amount || 0), 0);
  return summary;
}

function buildTradeFlowCandidates(world, config = {}) {
  const candidates = [];
  const locations = Object.values(world.locations || {}).filter(location => location && location.id);
  for (const resource of TRADE_FLOW_RESOURCE_TYPES) {
    const surplus = locations
      .map(location => ({ location, score: calculateSurplusScore(world, location, resource, config) }))
      .filter(item => item.score.surplus >= Number(config.minimumSurplus || DEFAULT_TRADE_FLOW_OPTIONS.minimumSurplus))
      .sort((left, right) => right.score.surplus - left.score.surplus || String(left.location.id).localeCompare(String(right.location.id)));
    const deficit = locations
      .map(location => ({ location, score: calculateDeficitScore(world, location, resource, config) }))
      .filter(item => item.score.deficit >= Number(config.minimumDeficit || DEFAULT_TRADE_FLOW_OPTIONS.minimumDeficit))
      .sort((left, right) => right.score.priority - left.score.priority || String(left.location.id).localeCompare(String(right.location.id)));
    for (const target of deficit) {
      const source = surplus.find(item => item.location.id !== target.location.id && Number(item.location.resources?.[resource] || 0) > Number(config.minimumSurplus || 25));
      if (!source) continue;
      const marketPressure = marketResourcePressure(world, resource);
      const routeRisk = resolveLocationRisk(world, source.location.id) * 0.35 + resolveLocationRisk(world, target.location.id) * 0.65;
      const capacity = Math.max(0, 1 - routeRisk * Number(config.cityRiskPenalty || DEFAULT_TRADE_FLOW_OPTIONS.cityRiskPenalty));
      const amount = Math.max(0, Math.floor(Math.min(
        source.score.surplus * Number(config.maxRouteShare || DEFAULT_TRADE_FLOW_OPTIONS.maxRouteShare),
        target.score.deficit,
        source.location.resources[resource] * 0.5,
      ) * capacity * (1 + marketPressure * Number(config.pricePressureMultiplier || DEFAULT_TRADE_FLOW_OPTIONS.pricePressureMultiplier))));
      if (amount <= 0) continue;
      candidates.push({ resource, fromLocationId: source.location.id, toLocationId: target.location.id, amount, routeRisk: round(routeRisk), marketPressure: round(marketPressure), priority: round(target.score.priority + marketPressure * 30 - routeRisk * 10) });
      source.location.resources[resource] = Math.max(0, Number(source.location.resources[resource] || 0) - amount * 0.15);
    }
  }
  return candidates.sort((left, right) => right.priority - left.priority || String(left.resource).localeCompare(String(right.resource))).slice(0, Number(config.maxTradeFlowsPerTick || DEFAULT_TRADE_FLOW_OPTIONS.maxTradeFlowsPerTick) * 2);
}

function applyTradeFlow(world, candidate, config = {}, helpers = {}) {
  const from = world.locations?.[candidate.fromLocationId];
  const to = world.locations?.[candidate.toLocationId];
  if (!from || !to) return null;
  if (!from.resources) from.resources = {};
  if (!to.resources) to.resources = {};
  const available = Number(from.resources[candidate.resource] || 0);
  const amount = Math.max(0, Math.min(Number(candidate.amount || 0), Math.floor(available)));
  if (amount <= 0) return null;
  from.resources[candidate.resource] = round(available - amount, 3);
  to.resources[candidate.resource] = round(Number(to.resources[candidate.resource] || 0) + amount, 3);
  const market = world.economy?.markets?.global;
  const price = Number(market?.resources?.[candidate.resource]?.price || 1);
  if (market?.resources?.[candidate.resource]) {
    market.resources[candidate.resource].supply += amount * 0.05;
    market.resources[candidate.resource].demand = Math.max(1, Number(market.resources[candidate.resource].demand || 1) - amount * 0.03);
  }
  const flow = {
    id: nextWorldId(world, 'trade_flow', `economy.trade_flow.${candidate.resource}`),
    tick: Number(world.tick || 0),
    resource: candidate.resource,
    fromLocationId: candidate.fromLocationId,
    toLocationId: candidate.toLocationId,
    amount: round(amount, 3),
    price: round(price, 3),
    value: round(amount * price, 3),
    routeRisk: candidate.routeRisk,
    marketPressure: candidate.marketPressure,
    priority: candidate.priority,
  };
  if (helpers.recordTransaction) {
    helpers.recordTransaction(world, { type: 'trade_flow', sellerType: 'location', sellerId: flow.fromLocationId, buyerType: 'location', buyerId: flow.toLocationId, resource: flow.resource, amount: flow.amount, price: flow.price, total: flow.value });
  }
  return flow;
}

function summarizeTradeFlows(world, flows = []) {
  const byResource = {};
  const byRoute = {};
  for (const flow of flows) {
    byResource[flow.resource] = round(Number(byResource[flow.resource] || 0) + Number(flow.amount || 0), 3);
    const routeKey = `${flow.fromLocationId}->${flow.toLocationId}`;
    byRoute[routeKey] = round(Number(byRoute[routeKey] || 0) + Number(flow.amount || 0), 3);
  }
  return {
    tick: Number(world.tick || 0),
    count: flows.length,
    volume: round(flows.reduce((sum, flow) => sum + Number(flow.amount || 0), 0), 3),
    value: round(flows.reduce((sum, flow) => sum + Number(flow.value || 0), 0), 3),
    byResource,
    byRoute,
    flows: flows.map(flow => ({ id: flow.id, resource: flow.resource, fromLocationId: flow.fromLocationId, toLocationId: flow.toLocationId, amount: flow.amount, value: flow.value, routeRisk: flow.routeRisk, marketPressure: flow.marketPressure })),
  };
}

function createEmptyTradeFlowSummary(tick = 0) {
  return { tick: Number(tick || 0), count: 0, volume: 0, value: 0, byResource: {}, byRoute: {}, flows: [] };
}

function calculateSurplusScore(world, location, resource, _config = {}) {
  const available = Number(location.resources?.[resource] || 0);
  const localNeed = estimateLocalNeed(world, location.id, resource);
  const safetyReserve = localNeed * 1.5 + 20;
  return { surplus: Math.max(0, available - safetyReserve), available, localNeed };
}

function calculateDeficitScore(world, location, resource, _config = {}) {
  const available = Number(location.resources?.[resource] || 0);
  const localNeed = estimateLocalNeed(world, location.id, resource);
  const pressure = resolveLocationResourcePressure(world, location.id, resource);
  const deficit = Math.max(0, localNeed * (1 + pressure) + 15 - available);
  const risk = resolveLocationRisk(world, location.id);
  return { deficit, available, localNeed, priority: deficit * (1 + pressure + risk * 0.5) };
}

function estimateLocalNeed(world, locationId, resource) {
  const cityIds = world.cities?.indexes?.byLocation?.[locationId] || [];
  const cityPopulation = cityIds.reduce((sum, cityId) => sum + Number(world.cities?.byId?.[cityId]?.population || 0), 0);
  const entityPopulation = Object.values(world.entities || {}).filter(entity => entity.status === 'alive' && entity.locationId === locationId).length;
  const population = Math.max(cityPopulation, entityPopulation, 1);
  const perCapita = { food: 1.2, water: 1.4, wood: 0.25, stone: 0.12, metal: 0.08, fuel: 0.18, luxury: 0.04 }[resource] || 0.1;
  return population * perCapita;
}

function resolveLocationResourcePressure(world, locationId, resource) {
  const cityIds = world.cities?.indexes?.byLocation?.[locationId] || [];
  const cityId = cityIds[0];
  const city = cityId ? world.cities?.byId?.[cityId] : null;
  const cityPressure = cityId ? world.cities?.pressure?.bySettlement?.[cityId] : null;
  if (resource === 'food') return clamp(Number(city?.pressure?.resourcePressure ?? cityPressure?.resourcePressure ?? 0), 0, 1);
  if (resource === 'water') return clamp(Number(city?.pressure?.waterCoverage !== undefined ? 1 - city.pressure.waterCoverage : city?.pressure?.resourcePressure ?? cityPressure?.resourcePressure ?? 0), 0, 1);
  return clamp(Number(cityPressure?.riskScore ?? city?.risk ?? world.cities?.pressure?.averageRisk ?? 0) * 0.5, 0, 1);
}

function resolveLocationRisk(world, locationId) {
  const cityIds = world.cities?.indexes?.byLocation?.[locationId] || [];
  const cityId = cityIds[0];
  const cityRisk = cityId ? Number(world.cities?.pressure?.bySettlement?.[cityId]?.riskScore ?? world.cities?.byId?.[cityId]?.risk ?? 0) : 0;
  const disasterRisk = Object.values(world.natural?.disasters?.active || {}).filter(disaster => disaster.locationId === locationId).reduce((sum, disaster) => sum + Number(disaster.severity || 0) * 0.35, 0);
  return clamp(cityRisk + disasterRisk, 0, 1);
}

function marketResourcePressure(world, resource) {
  const item = world.economy?.markets?.global?.resources?.[resource];
  if (!item) return 0;
  return clamp(Number(item.demand || 0) / Math.max(1, Number(item.supply || 0)) - 1, 0, 3) / 3;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value || 0))); }

module.exports = {
  TRADE_FLOW_RESOURCE_TYPES,
  DEFAULT_TRADE_FLOW_OPTIONS,
  ensureTradeFlowState,
  processTradeFlows,
  buildTradeFlowCandidates,
  applyTradeFlow,
  summarizeTradeFlows,
  createEmptyTradeFlowSummary,
};
