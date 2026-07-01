'use strict';

const { nextWorldId } = require('./world-id-engine');

const GOVERNANCE_RESPONSE_TYPES = {
  DISASTER_RELIEF: 'disaster_relief',
  PUBLIC_WORKS: 'public_works',
  RATIONING: 'rationing',
  SECURITY_CRACKDOWN: 'security_crackdown',
  TAX_ADJUSTMENT: 'tax_adjustment',
  MOBILIZATION: 'mobilization',
};

const DEFAULT_GOVERNANCE_ENVIRONMENT_OPTIONS = {
  responseCooldownTicks: 12,
  maxResponsesPerGovernmentPerTick: 4,
  responseMemoryLimit: 160,
  minimumTreasuryReserve: 100,
  disasterReliefThreshold: 0.45,
  publicWorksThreshold: 0.55,
  rationingThreshold: 0.45,
  securityThreshold: 0.45,
  taxAdjustmentThreshold: 0.45,
  mobilizationThreshold: 0.55,
  foodDemandPerPerson: 0.35,
  waterDemandPerPerson: 0.45,
};

function ensureGovernmentEnvironmentFields(world, government) {
  if (!government.environment || typeof government.environment !== 'object') government.environment = createEmptyGovernmentEnvironment(world?.tick || 0);
  if (!government.environmentResponseCooldowns || typeof government.environmentResponseCooldowns !== 'object') government.environmentResponseCooldowns = {};
  if (!Array.isArray(government.responses)) government.responses = [];
  return government;
}

function calculateGovernmentEnvironment(world, government, options = {}) {
  ensureGovernmentEnvironmentFields(world, government);
  const config = { ...DEFAULT_GOVERNANCE_ENVIRONMENT_OPTIONS, ...(options || {}) };
  const cities = getGovernedCities(world, government);
  const locationIds = getGovernmentLocationIds(world, government, cities);
  const industries = getGovernedIndustries(world, government, cities, locationIds);
  const cityRisk = averageOr(cities.map(city => resolveCityRisk(world, city)), Number(world.cities?.pressure?.averageRisk || 0));
  const securityRisk = averageOr(cities.map(city => clamp(1 - Number(city.security ?? 50) / 100, 0, 1)), 0);
  const migrationPressure = averageOr(cities.map(city => {
    const pressure = world.cities?.pressure?.bySettlement?.[city.id];
    const appeal = Number(pressure?.migrationAppeal ?? city.migrationAppeal ?? 50);
    return clamp((50 - appeal) / 50, 0, 1);
  }), 0);
  const maintenanceGap = averageOr(cities.map(city => Number(city.pressure?.maintenance?.gap ?? city.maintenance?.gap ?? 0)), 0);
  const populationRisk = resolvePopulationRisk(world, locationIds);
  const economyRisk = clamp(Number(world.economy?.environment?.averageRisk || 0), 0, 1);
  const pricePressure = clamp(Number(world.economy?.environment?.averagePricePressure || 0), 0, 1);
  const natural = resolveNaturalRisk(world, locationIds);
  const resource = resolveResourcePressure(world, government, cities, locationIds, config);
  const industry = resolveIndustryRisk(industries);
  const failingCities = cities.filter(city => ['declining', 'failing'].includes(city.status)).length;
  const totalRisk = clamp(
    cityRisk * 0.22
    + natural.disasterRisk * 0.18
    + resource.resourcePressure * 0.18
    + economyRisk * 0.14
    + pricePressure * 0.1
    + populationRisk * 0.08
    + industry.industrialRisk * 0.07
    + securityRisk * 0.03,
    0,
    1,
  );
  const environment = {
    tick: Number(world.tick || 0),
    governmentId: government.id,
    cityIds: cities.map(city => city.id),
    locationIds,
    subjectCount: Array.isArray(government.subjectEntityIds) ? government.subjectEntityIds.length : 0,
    cityRisk: round(cityRisk),
    securityRisk: round(securityRisk),
    migrationPressure: round(migrationPressure),
    maintenanceGap: round(maintenanceGap),
    populationRisk: round(populationRisk),
    economyRisk: round(economyRisk),
    pricePressure: round(pricePressure),
    weatherRisk: round(natural.weatherRisk),
    disasterRisk: round(natural.disasterRisk),
    resourcePressure: round(resource.resourcePressure),
    foodCoverage: round(resource.foodCoverage),
    waterCoverage: round(resource.waterCoverage),
    industrialRisk: round(industry.industrialRisk),
    stalledIndustries: industry.stalledIndustries,
    constrainedIndustries: industry.constrainedIndustries,
    failingCities,
    activeDisasters: natural.activeDisasters,
    totalRisk: round(totalRisk),
    recommendedResponses: [],
  };
  environment.recommendedResponses = buildGovernanceResponsePlan(government, environment, config).map(item => item.type);
  return environment;
}

function applyGovernanceEnvironmentResponses(world, government, environment = null, options = {}) {
  ensureGovernmentEnvironmentFields(world, government);
  const config = { ...DEFAULT_GOVERNANCE_ENVIRONMENT_OPTIONS, ...(options || {}) };
  const env = environment || calculateGovernmentEnvironment(world, government, config);
  const plan = buildGovernanceResponsePlan(government, env, config);
  const responses = [];
  for (const candidate of plan) {
    if (responses.length >= Math.max(0, Number(config.maxResponsesPerGovernmentPerTick || 0))) break;
    if (!isResponseDue(world, government, candidate.type, config)) continue;
    const response = createGovernanceResponse(world, government, candidate, env, config);
    if (!response) continue;
    responses.push(response);
    government.environmentResponseCooldowns[candidate.type] = Number(world.tick || 0);
  }
  return responses;
}

function summarizeGovernanceEnvironment(world, updates = [], responses = []) {
  if (!updates.length) return createEmptyGovernanceEnvironmentSummary(world.tick);
  const byGovernment = {};
  for (const item of updates) {
    byGovernment[item.governmentId] = {
      totalRisk: item.totalRisk,
      cityRisk: item.cityRisk,
      economyRisk: item.economyRisk,
      pricePressure: item.pricePressure,
      disasterRisk: item.disasterRisk,
      resourcePressure: item.resourcePressure,
      recommendedResponses: [...(item.recommendedResponses || [])],
    };
  }
  return {
    tick: Number(world.tick || 0),
    governments: updates.length,
    highRisk: updates.filter(item => Number(item.totalRisk || 0) >= 0.65).length,
    averageRisk: round(average(updates.map(item => item.totalRisk))),
    averageCityRisk: round(average(updates.map(item => item.cityRisk))),
    averageEconomyRisk: round(average(updates.map(item => item.economyRisk))),
    averagePricePressure: round(average(updates.map(item => item.pricePressure))),
    activeDisasters: updates.reduce((sum, item) => sum + Number(item.activeDisasters || 0), 0),
    stalledIndustries: updates.reduce((sum, item) => sum + Number(item.stalledIndustries || 0), 0),
    migrationPressure: round(average(updates.map(item => item.migrationPressure))),
    responses: responses.length,
    byResponseType: countBy(responses.map(response => response.type)),
    byGovernment,
  };
}

function createEmptyGovernmentEnvironment(tick = 0) {
  return { tick: Number(tick || 0), governmentId: null, cityIds: [], locationIds: [], subjectCount: 0, cityRisk: 0, securityRisk: 0, migrationPressure: 0, maintenanceGap: 0, populationRisk: 0, economyRisk: 0, pricePressure: 0, weatherRisk: 0, disasterRisk: 0, resourcePressure: 0, foodCoverage: 1, waterCoverage: 1, industrialRisk: 0, stalledIndustries: 0, constrainedIndustries: 0, failingCities: 0, activeDisasters: 0, totalRisk: 0, recommendedResponses: [] };
}

function createEmptyGovernanceEnvironmentSummary(tick = 0) {
  return { tick: Number(tick || 0), governments: 0, highRisk: 0, averageRisk: 0, averageCityRisk: 0, averageEconomyRisk: 0, averagePricePressure: 0, activeDisasters: 0, stalledIndustries: 0, migrationPressure: 0, responses: 0, byResponseType: {}, byGovernment: {} };
}

function getGovernanceEnvironmentSummary(world) {
  const summary = world.governance?.environment || createEmptyGovernanceEnvironmentSummary(world.tick);
  return { ...summary, byResponseType: { ...(summary.byResponseType || {}) }, byGovernment: { ...(summary.byGovernment || {}) } };
}

function buildGovernanceResponsePlan(government, environment, config) {
  const plan = [];
  const unrestPressure = clamp(Number(government.unrest || 0) / 100, 0, 1);
  const severity = Math.max(environment.totalRisk, environment.cityRisk, environment.disasterRisk, environment.resourcePressure);
  if (environment.disasterRisk >= config.disasterReliefThreshold || environment.activeDisasters > 0) plan.push({ type: GOVERNANCE_RESPONSE_TYPES.DISASTER_RELIEF, severity: Math.max(severity, environment.disasterRisk), reason: 'active disaster or severe weather risk' });
  if (environment.resourcePressure >= config.rationingThreshold || environment.foodCoverage < 0.7 || environment.waterCoverage < 0.7) plan.push({ type: GOVERNANCE_RESPONSE_TYPES.RATIONING, severity: Math.max(severity, environment.resourcePressure), reason: 'food or water shortage' });
  if (environment.cityRisk >= config.publicWorksThreshold || environment.maintenanceGap >= 0.3 || environment.failingCities > 0) plan.push({ type: GOVERNANCE_RESPONSE_TYPES.PUBLIC_WORKS, severity: Math.max(severity, environment.cityRisk), reason: 'city infrastructure or stability pressure' });
  if (environment.securityRisk >= config.securityThreshold || unrestPressure >= 0.5) plan.push({ type: GOVERNANCE_RESPONSE_TYPES.SECURITY_CRACKDOWN, severity: Math.max(severity, unrestPressure, environment.securityRisk), reason: 'security pressure or unrest' });
  if (environment.stalledIndustries > 0 || environment.industrialRisk >= config.mobilizationThreshold || environment.totalRisk >= config.mobilizationThreshold) plan.push({ type: GOVERNANCE_RESPONSE_TYPES.MOBILIZATION, severity: Math.max(severity, environment.industrialRisk), reason: 'industrial stoppage or systemic emergency' });
  if (environment.pricePressure >= config.taxAdjustmentThreshold || environment.economyRisk >= config.taxAdjustmentThreshold || environment.totalRisk >= 0.62 || Number(government.treasury || 0) < Number(config.minimumTreasuryReserve || 0)) plan.push({ type: GOVERNANCE_RESPONSE_TYPES.TAX_ADJUSTMENT, severity: Math.max(severity, environment.pricePressure, environment.economyRisk), reason: 'price pressure or fiscal stress' });
  return plan.sort((left, right) => responsePriority(right.type) - responsePriority(left.type) || Number(right.severity || 0) - Number(left.severity || 0));
}

function createGovernanceResponse(world, government, candidate, environment, config) {
  const response = { id: nextWorldId(world, 'gov_response', `governance.response.${candidate.type}`), tick: Number(world.tick || 0), type: candidate.type, status: 'active', governmentId: government.id, organizationId: government.organizationId, cityIds: [...(environment.cityIds || [])], locationIds: [...(environment.locationIds || [])], severity: round(clamp(candidate.severity || environment.totalRisk || 0, 0, 1)), reason: candidate.reason || null, cost: 0, effects: {}, inputs: { totalRisk: environment.totalRisk, cityRisk: environment.cityRisk, disasterRisk: environment.disasterRisk, economyRisk: environment.economyRisk, pricePressure: environment.pricePressure, resourcePressure: environment.resourcePressure, industrialRisk: environment.industrialRisk } };
  if (applyResponseEffect(world, government, response, environment, config) === false) return null;
  government.responses.push(response);
  while (government.responses.length > Number(config.responseMemoryLimit || DEFAULT_GOVERNANCE_ENVIRONMENT_OPTIONS.responseMemoryLimit)) government.responses.shift();
  if (!Array.isArray(world.governance.responseLog)) world.governance.responseLog = [];
  world.governance.responseLog.push(response);
  return response;
}

function applyResponseEffect(world, government, response, environment, config) {
  if (response.type === GOVERNANCE_RESPONSE_TYPES.DISASTER_RELIEF) return applyDisasterRelief(world, government, response, environment);
  if (response.type === GOVERNANCE_RESPONSE_TYPES.RATIONING) return applyRationing(world, government, response);
  if (response.type === GOVERNANCE_RESPONSE_TYPES.PUBLIC_WORKS) return applyPublicWorks(world, government, response);
  if (response.type === GOVERNANCE_RESPONSE_TYPES.SECURITY_CRACKDOWN) return applySecurityCrackdown(world, government, response);
  if (response.type === GOVERNANCE_RESPONSE_TYPES.TAX_ADJUSTMENT) return applyTaxAdjustment(government, response, environment, config);
  if (response.type === GOVERNANCE_RESPONSE_TYPES.MOBILIZATION) return applyMobilization(world, government, response);
  return false;
}

function applyDisasterRelief(world, government, response, environment) {
  const cost = spendTreasury(world, government, 30 + response.severity * 180 + Math.max(1, environment.subjectCount || 0) * 1.5);
  response.cost = cost;
  government.services = clamp(government.services + response.severity * 8 + cost * 0.02, 0, 100);
  government.legitimacy = clamp(government.legitimacy + response.severity * 6 + cost * 0.005, 0, 100);
  government.unrest = clamp(government.unrest - response.severity * 5, 0, 100);
  response.effects.treasuryDelta = -cost;
  response.effects.locationRelief = distributeEmergencySupplies(world, response.locationIds, cost, response.severity);
  return true;
}

function applyRationing(world, government, response) {
  const food = world.economy?.markets?.global?.resources?.food;
  response.effects.foodDemandBefore = food ? Number(food.demand || 0) : null;
  if (food) food.demand = Math.max(1, food.demand * (1 - response.severity * 0.05));
  government.services = clamp(government.services + response.severity * 3, 0, 100);
  government.unrest = clamp(government.unrest + response.severity * 1.8 - Number(government.policies.welfare || 0) * 0.01, 0, 100);
  for (const locationId of response.locationIds) {
    const location = world.locations?.[locationId];
    if (!location) continue;
    if (!location.meta) location.meta = {};
    location.meta.rationingTick = Number(world.tick || 0);
    location.meta.rationingSeverity = response.severity;
  }
  response.effects.foodDemandAfter = food ? round(food.demand) : null;
  return true;
}

function applyPublicWorks(world, government, response) {
  const cost = spendTreasury(world, government, 40 + response.severity * 220 + response.cityIds.length * 15);
  response.cost = cost;
  response.effects.cities = [];
  for (const cityId of response.cityIds) {
    const city = world.cities?.byId?.[cityId];
    if (!city) continue;
    const infrastructureGain = Math.max(1, Math.round(response.severity * 4 + cost / Math.max(1, response.cityIds.length) * 0.01));
    const stabilityGain = round(response.severity * 4 + cost * 0.003);
    city.infrastructure = clamp(Number(city.infrastructure || 0) + infrastructureGain, 0, 1000000);
    city.stability = clamp(Number(city.stability || 0) + stabilityGain, 0, 100);
    if (city.maintenance) city.maintenance.gap = clamp(Number(city.maintenance.gap || 0) - response.severity * 0.08, 0, 1);
    response.effects.cities.push({ cityId, infrastructureGain, stabilityGain });
  }
  government.services = clamp(government.services + response.severity * 4 + cost * 0.01, 0, 100);
  government.legitimacy = clamp(government.legitimacy + response.severity * 3, 0, 100);
  response.effects.treasuryDelta = -cost;
  return true;
}

function applySecurityCrackdown(world, government, response) {
  response.effects.policyBefore = { ...government.policies };
  government.policies.lawLevel = clamp(Number(government.policies.lawLevel || 0) + Math.round(response.severity * 8), 0, 100);
  government.policies.military = clamp(Number(government.policies.military || 0) + Math.round(response.severity * 5), 0, 100);
  government.policies.openness = clamp(Number(government.policies.openness || 0) - Math.round(response.severity * 4), 0, 100);
  government.enforcement = clamp(government.enforcement + response.severity * 10, 0, 100);
  government.unrest = clamp(government.unrest - response.severity * 9, 0, 100);
  government.legitimacy = clamp(government.legitimacy - response.severity * 2.5, 0, 100);
  response.effects.cities = [];
  for (const cityId of response.cityIds) {
    const city = world.cities?.byId?.[cityId];
    if (!city) continue;
    const securityGain = round(response.severity * 7);
    city.security = clamp(Number(city.security || 0) + securityGain, 0, 100);
    response.effects.cities.push({ cityId, securityGain });
  }
  response.effects.policyAfter = { ...government.policies };
  return true;
}

function applyTaxAdjustment(government, response, environment, config) {
  const before = Number(government.policies.taxRate || 0);
  const fiscalStress = Number(government.treasury || 0) < Number(config.minimumTreasuryReserve || 0);
  const socialStress = environment.totalRisk >= 0.55 || environment.pricePressure >= config.taxAdjustmentThreshold || Number(government.unrest || 0) >= 45;
  let after = before;
  if (socialStress) after = clamp(before - Math.max(2, Math.round(response.severity * 8)), 0, 80);
  else if (fiscalStress) after = clamp(before + Math.max(1, Math.round(response.severity * 4)), 0, 80);
  if (after === before) return false;
  government.policies.taxRate = after;
  response.effects.policy = 'taxRate';
  response.effects.from = before;
  response.effects.to = after;
  response.effects.delta = after - before;
  return true;
}

function applyMobilization(world, government, response) {
  const cost = spendTreasury(world, government, 25 + response.severity * 150);
  response.cost = cost;
  const org = world.organizations?.byId?.[government.organizationId];
  if (org) org.cohesion = clamp(Number(org.cohesion || 0) + response.severity * 4, 0, 100);
  government.policies.military = clamp(Number(government.policies.military || 0) + Math.round(response.severity * 6), 0, 100);
  government.enforcement = clamp(government.enforcement + response.severity * 6, 0, 100);
  response.effects.cities = [];
  for (const cityId of response.cityIds) {
    const city = world.cities?.byId?.[cityId];
    if (!city) continue;
    const securityGain = round(response.severity * 4);
    city.security = clamp(Number(city.security || 0) + securityGain, 0, 100);
    response.effects.cities.push({ cityId, securityGain });
  }
  response.effects.treasuryDelta = -cost;
  return true;
}

function getGovernedCities(world, government) {
  const ids = new Set(government.cityIds || []);
  for (const city of Object.values(world.cities?.byId || {})) if (city.rulerOrganizationId === government.organizationId || city.organizationIds?.includes(government.organizationId)) ids.add(city.id);
  return [...ids].map(id => world.cities?.byId?.[id]).filter(Boolean).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function getGovernmentLocationIds(world, government, cities) {
  const ids = new Set();
  const org = world.organizations?.byId?.[government.organizationId];
  if (org?.homeLocationId) ids.add(org.homeLocationId);
  for (const city of cities || []) if (city.locationId) ids.add(city.locationId);
  for (const entityId of government.subjectEntityIds || []) if (world.entities?.[entityId]?.locationId) ids.add(world.entities[entityId].locationId);
  return [...ids].sort();
}

function getGovernedIndustries(world, government, cities, locationIds) {
  const cityIndustryIds = new Set((cities || []).flatMap(city => Array.isArray(city.industryIds) ? city.industryIds : []));
  const locationSet = new Set(locationIds || []);
  return Object.values(world.economy?.industries || {}).filter(industry => industry.ownerId === government.organizationId || cityIndustryIds.has(industry.id) || locationSet.has(industry.locationId));
}

function resolveCityRisk(world, city) { return clamp(Number(world.cities?.pressure?.bySettlement?.[city.id]?.riskScore ?? city.risk ?? city.pressure?.riskScore ?? 0), 0, 1); }
function resolvePopulationRisk(world, locationIds) { const values = (locationIds || []).map(id => Number(world.population?.environment?.byLocation?.[id]?.averageRisk)).filter(Number.isFinite); return clamp(values.length ? average(values) : Number(world.population?.environment?.averageRisk || 0), 0, 1); }
function resolveNaturalRisk(world, locationIds) { const set = new Set(locationIds || []); const weather = [...set].map(id => weatherRisk(world.natural?.weather?.byLocation?.[id]?.type, world.natural?.weather?.byLocation?.[id]?.severity)); const active = Object.values(world.natural?.disasters?.active || {}).filter(disaster => !set.size || set.has(disaster.locationId)); return { weatherRisk: averageOr(weather, 0), disasterRisk: clamp(active.reduce((sum, disaster) => sum + Number(disaster.severity || 0) * 0.55, 0), 0, 1), activeDisasters: active.length }; }
function resolveIndustryRisk(industries) { const items = industries || []; const stalledIndustries = items.filter(industry => industry.status === 'stalled').length; const constrainedIndustries = items.filter(industry => ['constrained', 'declining'].includes(industry.status)).length; const risks = items.map(industry => Number(industry.environment?.riskScore ?? (industry.status === 'stalled' ? 1 : industry.status === 'declining' ? 0.7 : industry.status === 'constrained' ? 0.45 : 0))).filter(Number.isFinite); return { stalledIndustries, constrainedIndustries, industrialRisk: clamp(averageOr(risks, 0), 0, 1) }; }
function resolveResourcePressure(world, government, cities, locationIds, config) { const food = []; const water = []; const pressure = []; for (const city of cities || []) { if (Number.isFinite(Number(city.pressure?.foodCoverage))) food.push(Number(city.pressure.foodCoverage)); if (Number.isFinite(Number(city.pressure?.waterCoverage))) water.push(Number(city.pressure.waterCoverage)); if (Number.isFinite(Number(city.pressure?.resourcePressure))) pressure.push(Number(city.pressure.resourcePressure)); } if (!pressure.length) { const subjects = Math.max(1, (government.subjectEntityIds || []).length); for (const locationId of locationIds || []) { const resources = world.locations?.[locationId]?.resources || {}; const f = clamp(Number(resources.food || 0) / Math.max(10, subjects * Number(config.foodDemandPerPerson || 0.35)), 0, 2); const w = clamp(Number(resources.water || 0) / Math.max(10, subjects * Number(config.waterDemandPerPerson || 0.45)), 0, 2); food.push(f); water.push(w); pressure.push(clamp((1 - Math.min(1, f)) * 0.55 + (1 - Math.min(1, w)) * 0.45, 0, 1)); } } const foodCoverage = averageOr(food, 1); const waterCoverage = averageOr(water, 1); return { foodCoverage, waterCoverage, resourcePressure: averageOr(pressure, clamp((1 - Math.min(1, foodCoverage)) * 0.55 + (1 - Math.min(1, waterCoverage)) * 0.45, 0, 1)) }; }
function spendTreasury(world, government, requested) { const spent = Math.min(Math.max(0, Math.round(requested)), Math.max(0, Math.round(Number(government.treasury || 0)))); government.treasury = Math.max(0, Number(government.treasury || 0) - spent); const org = world.organizations?.byId?.[government.organizationId]; if (org?.assets) org.assets.currency = Math.max(0, Number(org.assets.currency || 0) - spent); return spent; }
function distributeEmergencySupplies(world, locationIds, cost, severity) { const targets = (locationIds || []).map(id => world.locations?.[id]).filter(Boolean); if (!targets.length) return []; const out = []; for (const location of targets) { if (!location.resources) location.resources = {}; const food = round(cost / targets.length * 0.28 + severity * 12); const water = round(cost / targets.length * 0.32 + severity * 14); location.resources.food = round(Number(location.resources.food || 0) + food); location.resources.water = round(Number(location.resources.water || 0) + water); out.push({ locationId: location.id, food, water }); } return out; }
function isResponseDue(world, government, type, config) { const last = government.environmentResponseCooldowns?.[type]; return last === undefined || Number(world.tick || 0) - Number(last) >= Number(config.responseCooldownTicks || 0); }
function responsePriority(type) { return { disaster_relief: 100, rationing: 90, public_works: 80, security_crackdown: 70, mobilization: 60, tax_adjustment: 50 }[type] || 0; }
function trimGovernanceResponseLog(state, limit) { while (state.responseLog.length > Math.max(0, Number(limit || DEFAULT_GOVERNANCE_ENVIRONMENT_OPTIONS.responseMemoryLimit) * 2)) state.responseLog.shift(); }
function weatherRisk(type, severity) { const base = { clear: 0, cloudy: 0.02, rain: 0.06, storm: 0.55, snow: 0.25, drought: 0.65, heatwave: 0.5, cold_snap: 0.45 }[type] || 0.04; return clamp(base + Number(severity || 0) * 0.28, 0, 1); }
function countBy(items) { const out = {}; for (const item of items || []) out[item] = Number(out[item] || 0) + 1; return out; }
function averageOr(values, fallback) { const filtered = (values || []).map(Number).filter(Number.isFinite); return filtered.length ? average(filtered) : fallback; }
function average(values) { const filtered = (values || []).map(Number).filter(Number.isFinite); return filtered.length ? filtered.reduce((sum, value) => sum + value, 0) / filtered.length : 0; }
function round(value, digits = 3) { const factor = 10 ** digits; return Math.round(Number(value || 0) * factor) / factor; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value || 0))); }

module.exports = {
  GOVERNANCE_RESPONSE_TYPES,
  DEFAULT_GOVERNANCE_ENVIRONMENT_OPTIONS,
  ensureGovernmentEnvironmentFields,
  calculateGovernmentEnvironment,
  applyGovernanceEnvironmentResponses,
  summarizeGovernanceEnvironment,
  createEmptyGovernmentEnvironment,
  createEmptyGovernanceEnvironmentSummary,
  getGovernanceEnvironmentSummary,
  trimGovernanceResponseLog,
};
