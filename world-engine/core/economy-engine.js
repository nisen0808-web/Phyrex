'use strict';

const { recordLifeEvent, LIFE_EVENT_TYPES } = require('./history-engine');
const { getOrganization } = require('./organization-engine');
const { nextWorldId } = require('./world-id-engine');

const RESOURCE_TYPES = {
  FOOD: 'food',
  WOOD: 'wood',
  STONE: 'stone',
  METAL: 'metal',
  FUEL: 'fuel',
  LUXURY: 'luxury',
  KNOWLEDGE: 'knowledge',
  SERVICE: 'service',
  CURRENCY: 'currency',
};

const INDUSTRY_TYPES = {
  AGRICULTURE: 'agriculture',
  MINING: 'mining',
  CRAFT: 'craft',
  TRADE: 'trade',
  SERVICE: 'service',
  ENTERTAINMENT: 'entertainment',
  EDUCATION: 'education',
  RELIGION: 'religion',
};

const INDUSTRY_STATUS = {
  ACTIVE: 'active',
  CONSTRAINED: 'constrained',
  DECLINING: 'declining',
  STALLED: 'stalled',
};

const DEFAULT_MARKET_RESOURCES = {
  food: { basePrice: 1, supply: 1000, demand: 1000, volatility: 0.08 },
  wood: { basePrice: 2, supply: 600, demand: 500, volatility: 0.1 },
  stone: { basePrice: 2, supply: 600, demand: 450, volatility: 0.1 },
  metal: { basePrice: 8, supply: 250, demand: 300, volatility: 0.18 },
  fuel: { basePrice: 5, supply: 300, demand: 350, volatility: 0.14 },
  luxury: { basePrice: 20, supply: 100, demand: 150, volatility: 0.25 },
  knowledge: { basePrice: 15, supply: 80, demand: 120, volatility: 0.2 },
  service: { basePrice: 6, supply: 300, demand: 300, volatility: 0.12 },
};

const INDUSTRY_OUTPUTS = {
  agriculture: { food: 8 },
  mining: { stone: 3, metal: 1, fuel: 1 },
  craft: { luxury: 1, service: 1 },
  trade: { currency: 8 },
  service: { service: 4, currency: 3 },
  entertainment: { service: 5, luxury: 1, currency: 4 },
  education: { knowledge: 3, service: 1 },
  religion: { service: 2, knowledge: 1, currency: 2 },
};

const DEFAULT_ECONOMY_ENVIRONMENT_OPTIONS = {
  cityPressureWeight: 0.28,
  disasterWeight: 0.22,
  ecologyWeight: 0.18,
  populationWeight: 0.16,
  resourceWeight: 0.16,
  minProductionMultiplier: 0.08,
  maxProductionMultiplier: 1.35,
  pricePressureMultiplier: 0.45,
  constrainedThreshold: 0.35,
  decliningThreshold: 0.6,
  stalledThreshold: 0.82,
  environmentMemoryLimit: 160,
};

function ensureEconomyState(world) {
  if (!world.economy) {
    world.economy = {
      markets: {},
      industries: {},
      transactions: [],
      environment: createEmptyEconomyEnvironmentSummary(world.tick),
      indexes: {
        industriesByLocation: {},
        industriesByType: {},
      },
      stats: {
        ticks: 0,
        production: {},
        consumption: {},
        transactionVolume: 0,
        environmentUpdates: 0,
        constrainedIndustries: 0,
        stalledIndustries: 0,
      },
    };
    createMarket(world, { id: 'global', name: 'Global Market' });
  }
  if (!world.economy.environment) world.economy.environment = createEmptyEconomyEnvironmentSummary(world.tick);
  if (!world.economy.stats) world.economy.stats = { ticks: 0, production: {}, consumption: {}, transactionVolume: 0 };
  ensureEconomyStats(world.economy);
  return world.economy;
}

function createMarket(world, input = {}) {
  const economy = ensureEconomyState(world);
  const id = input.id || nextWorldId(world, 'market', 'economy.market');
  const resources = {};
  for (const [resource, config] of Object.entries(DEFAULT_MARKET_RESOURCES)) {
    resources[resource] = {
      resource,
      price: input.resources?.[resource]?.price || config.basePrice,
      basePrice: config.basePrice,
      supply: input.resources?.[resource]?.supply ?? config.supply,
      demand: input.resources?.[resource]?.demand ?? config.demand,
      environmentalDemand: 0,
      environmentalSupplyShock: 0,
      volatility: config.volatility,
      history: [],
    };
  }
  economy.markets[id] = {
    id,
    name: input.name || id,
    locationId: input.locationId || null,
    resources,
    createdAt: world.tick,
    memory: [],
  };
  return economy.markets[id];
}

function createIndustry(world, input = {}) {
  if (!input.type) throw new Error('Industry requires type');
  const economy = ensureEconomyState(world);
  const id = input.id || nextWorldId(world, 'industry', `economy.industry.${input.type}`);
  const industry = {
    id,
    type: input.type,
    name: input.name || `${input.type} ${id.slice(-6)}`,
    ownerType: input.ownerType || 'organization',
    ownerId: input.ownerId || null,
    locationId: input.locationId || null,
    scale: Number(input.scale || 1),
    efficiency: Number(input.efficiency || 1),
    workforce: Array.isArray(input.workforce) ? [...input.workforce] : [],
    inputs: { ...(input.inputs || {}) },
    outputs: { ...(input.outputs || INDUSTRY_OUTPUTS[input.type] || {}) },
    inventory: {},
    environment: createEmptyIndustryEnvironment(world.tick),
    revenue: 0,
    cost: 0,
    status: INDUSTRY_STATUS.ACTIVE,
    createdAt: world.tick,
    memory: [],
  };
  economy.industries[id] = industry;
  rebuildEconomyIndexes(world);
  return industry;
}

function processEconomyTick(world, options = {}) {
  const config = mergeEconomyEnvironmentOptions(options);
  const economy = ensureEconomyState(world);
  const produced = [];
  const consumed = [];
  const transactions = [];
  const environmentUpdates = [];

  for (const industry of Object.values(economy.industries)) {
    const environment = calculateIndustryEnvironment(world, industry, config);
    applyIndustryEnvironment(world, industry, environment, config);
    environmentUpdates.push({ industryId: industry.id, locationId: industry.locationId, ...environment });
    if (industry.status === INDUSTRY_STATUS.STALLED) {
      recordIndustryMemory(world, industry, 'industry.stalled', { environment });
      continue;
    }
    produced.push(...produceIndustryOutput(world, industry.id, config));
    transactions.push(...sellIndustryOutput(world, industry.id, config));
  }

  consumed.push(...consumePopulationNeeds(world, config));
  const environmentSummary = summarizeEconomyEnvironment(world, environmentUpdates);
  economy.environment = environmentSummary;
  applyEconomyEnvironmentToMarkets(world, environmentSummary, config);
  updateMarketPrices(world, config);
  economy.stats.ticks += 1;
  economy.stats.environmentUpdates += environmentUpdates.length;
  economy.stats.constrainedIndustries += environmentUpdates.filter(item => item.status === INDUSTRY_STATUS.CONSTRAINED || item.status === INDUSTRY_STATUS.DECLINING).length;
  economy.stats.stalledIndustries += environmentUpdates.filter(item => item.status === INDUSTRY_STATUS.STALLED).length;
  rebuildEconomyIndexes(world);

  return { produced, consumed, transactions, environment: environmentSummary, environmentUpdates, markets: snapshotMarkets(world) };
}

function produceIndustryOutput(world, industryId, options = {}) {
  const industry = getIndustry(world, industryId);
  if (!industry) return [];
  const results = [];
  const environment = industry.environment || createEmptyIndustryEnvironment(world.tick);
  const workforceMultiplier = Math.max(1, industry.workforce.length || estimateOwnerWorkforce(world, industry));
  const scale = Number(industry.scale || 1);
  const efficiency = Number(industry.efficiency || 1) * Number(environment.productionMultiplier || 1);

  if (!consumeInputsForIndustry(world, industry)) {
    industry.cost += 1 + Math.round(environment.riskScore * 3);
    recordIndustryMemory(world, industry, 'industry.input_shortage', { environment });
    return results;
  }

  for (const [resource, baseAmount] of Object.entries(industry.outputs || {})) {
    const amount = Math.max(0, Math.round(Number(baseAmount || 0) * scale * efficiency * Math.sqrt(workforceMultiplier)));
    if (!amount) continue;
    industry.inventory[resource] = Number(industry.inventory[resource] || 0) + amount;
    world.economy.stats.production[resource] = Number(world.economy.stats.production[resource] || 0) + amount;
    results.push({ industryId, resource, amount, productionMultiplier: round(environment.productionMultiplier, 3) });
  }

  if (results.length) recordIndustryMemory(world, industry, 'industry.produced', { results, environment });
  return results;
}

function consumeInputsForIndustry(_world, industry) {
  for (const [resource, amount] of Object.entries(industry.inputs || {})) {
    if (Number(industry.inventory[resource] || 0) < Number(amount || 0)) return false;
  }
  for (const [resource, amount] of Object.entries(industry.inputs || {})) {
    industry.inventory[resource] -= Number(amount || 0);
  }
  return true;
}

function sellIndustryOutput(world, industryId, options = {}) {
  const industry = getIndustry(world, industryId);
  const market = getMarket(world, options.marketId || 'global');
  if (!industry || !market) return [];
  const transactions = [];
  const environment = industry.environment || createEmptyIndustryEnvironment(world.tick);

  for (const [resource, amount] of Object.entries({ ...industry.inventory })) {
    if (resource === RESOURCE_TYPES.CURRENCY || amount <= 0 || !market.resources[resource]) continue;
    const liquidityPenalty = clamp(1 - environment.riskScore * 0.35, 0.15, 1);
    const sellAmount = Math.max(0, Math.floor(Number(amount) * (options.sellRatio ?? 0.5) * liquidityPenalty));
    if (!sellAmount) continue;
    const price = market.resources[resource].price;
    const revenue = Math.round(sellAmount * price);
    industry.inventory[resource] -= sellAmount;
    industry.revenue += revenue;
    market.resources[resource].supply += sellAmount;
    market.resources[resource].demand = Math.max(0, market.resources[resource].demand - sellAmount * 0.2);
    payOwner(world, industry, revenue);
    const transaction = recordTransaction(world, {
      type: 'industry_sale',
      sellerType: 'industry',
      sellerId: industry.id,
      buyerType: 'market',
      buyerId: market.id,
      resource,
      amount: sellAmount,
      price,
      total: revenue,
    });
    transactions.push(transaction);
  }
  return transactions;
}

function consumePopulationNeeds(world, options = {}) {
  const market = getMarket(world, options.marketId || 'global');
  const consumed = [];
  if (!market) return consumed;
  const alive = Object.values(world.entities || {}).filter(entity => entity.status === 'alive');
  const populationRisk = clamp(Number(world.population?.environment?.averageRisk || 0), 0, 1);
  const cityRisk = clamp(Number(world.cities?.pressure?.averageRisk || 0), 0, 1);
  const foodNeed = alive.length * (options.foodPerEntity || 1) * (1 + populationRisk * 0.35 + cityRisk * 0.25);
  const serviceNeed = Math.round(alive.length * (options.servicePerEntity || 0.2) * (1 + cityRisk * 0.3));
  consumeMarketResource(world, market.id, RESOURCE_TYPES.FOOD, foodNeed, consumed);
  consumeMarketResource(world, market.id, RESOURCE_TYPES.SERVICE, serviceNeed, consumed);
  return consumed;
}

function consumeMarketResource(world, marketId, resource, amount, consumed) {
  const market = getMarket(world, marketId);
  if (!market?.resources?.[resource]) return;
  const item = market.resources[resource];
  const actual = Math.min(item.supply, amount);
  item.supply -= actual;
  item.demand += Math.max(0, amount - actual) + amount * 0.1;
  world.economy.stats.consumption[resource] = Number(world.economy.stats.consumption[resource] || 0) + actual;
  consumed.push({ marketId, resource, amount: round(actual, 3), shortage: round(Math.max(0, amount - actual), 3) });
}

function updateMarketPrices(world, options = {}) {
  const economyEnvironment = ensureEconomyState(world).environment || createEmptyEconomyEnvironmentSummary(world.tick);
  for (const market of Object.values(ensureEconomyState(world).markets)) {
    for (const item of Object.values(market.resources)) {
      const pressure = item.demand / Math.max(1, item.supply);
      const environmentPressure = Number(item.environmentalDemand || 0) + Number(item.environmentalSupplyShock || 0) + Number(economyEnvironment.averageRisk || 0) * 0.15;
      const target = item.basePrice * Math.max(0.2, pressure * (1 + environmentPressure * Number(options.pricePressureMultiplier || DEFAULT_ECONOMY_ENVIRONMENT_OPTIONS.pricePressureMultiplier)));
      item.price = roundPrice(item.price * 0.8 + target * 0.2);
      item.history.push({ tick: world.tick, price: item.price, supply: item.supply, demand: item.demand, environmentPressure: round(environmentPressure, 3) });
      if (item.history.length > 200) item.history.shift();
      item.supply = Math.max(0, item.supply * 0.995);
      item.demand = Math.max(1, item.demand * 0.995);
      item.environmentalDemand = 0;
      item.environmentalSupplyShock = 0;
    }
  }
}

function calculateIndustryEnvironment(world, industry, options = {}) {
  const config = mergeEconomyEnvironmentOptions(options);
  const locationId = industry.locationId;
  const cityPressure = resolveCityPressure(world, locationId);
  const disasterRisk = calculateEconomicDisasterRisk(world, locationId);
  const ecologyRisk = calculateEconomicEcologyRisk(world, locationId, industry.type);
  const populationRisk = clamp(Number(world.population?.environment?.byLocation?.[locationId]?.averageRisk || world.population?.environment?.averageRisk || 0), 0, 1);
  const resourceRisk = calculateEconomicResourceRisk(world, locationId, industry.type);
  const riskScore = clamp(
    cityPressure * config.cityPressureWeight
    + disasterRisk * config.disasterWeight
    + ecologyRisk * config.ecologyWeight
    + populationRisk * config.populationWeight
    + resourceRisk * config.resourceWeight,
    0,
    1,
  );
  const productionMultiplier = clamp(1 - riskScore * 0.85 + getIndustryResilience(industry.type) * 0.12, config.minProductionMultiplier, config.maxProductionMultiplier);
  const pricePressure = clamp(riskScore * 0.7 + resourceRisk * 0.3, 0, 1);
  return {
    tick: Number(world.tick || 0),
    cityPressure: round(cityPressure, 3),
    disasterRisk: round(disasterRisk, 3),
    ecologyRisk: round(ecologyRisk, 3),
    populationRisk: round(populationRisk, 3),
    resourceRisk: round(resourceRisk, 3),
    riskScore: round(riskScore, 3),
    productionMultiplier: round(productionMultiplier, 3),
    pricePressure: round(pricePressure, 3),
    status: inferIndustryStatus(riskScore, productionMultiplier, config),
  };
}

function applyIndustryEnvironment(world, industry, environment, _options = {}) {
  const previousStatus = industry.status;
  industry.environment = environment;
  industry.status = environment.status;
  industry.efficiency = clamp(Number(industry.efficiency || 1) + (environment.riskScore < 0.25 ? 0.01 : -environment.riskScore * 0.015), 0.1, 2.5);
  industry.cost += Math.round(environment.riskScore * Math.max(1, industry.scale || 1));
  if (previousStatus !== industry.status) recordIndustryMemory(world, industry, 'industry.status.changed', { from: previousStatus, to: industry.status, environment });
  return industry;
}

function summarizeEconomyEnvironment(world, updates) {
  if (!updates.length) return createEmptyEconomyEnvironmentSummary(world.tick);
  return {
    tick: Number(world.tick || 0),
    industries: updates.length,
    highRisk: updates.filter(update => update.riskScore >= 0.65).length,
    stalled: updates.filter(update => update.status === INDUSTRY_STATUS.STALLED).length,
    averageRisk: round(average(updates.map(update => update.riskScore)), 3),
    averageProductionMultiplier: round(average(updates.map(update => update.productionMultiplier)), 3),
    averagePricePressure: round(average(updates.map(update => update.pricePressure)), 3),
    byIndustry: Object.fromEntries(updates.map(update => [update.industryId, {
      locationId: update.locationId,
      status: update.status,
      riskScore: update.riskScore,
      productionMultiplier: update.productionMultiplier,
      pricePressure: update.pricePressure,
    }])),
  };
}

function applyEconomyEnvironmentToMarkets(world, summary, _options = {}) {
  const market = getMarket(world, 'global');
  if (!market) return;
  const risk = Number(summary.averageRisk || 0);
  const pricePressure = Number(summary.averagePricePressure || 0);
  for (const [resource, item] of Object.entries(market.resources || {})) {
    const sensitivity = marketResourceSensitivity(resource);
    item.environmentalDemand = Number(item.environmentalDemand || 0) + pricePressure * sensitivity.demand;
    item.environmentalSupplyShock = Number(item.environmentalSupplyShock || 0) + risk * sensitivity.supply;
    item.demand += item.demand * item.environmentalDemand * 0.03;
    item.supply = Math.max(0, item.supply * (1 - item.environmentalSupplyShock * 0.02));
  }
}

function resolveCityPressure(world, locationId) {
  if (!locationId) return Number(world.cities?.pressure?.averageRisk || 0);
  const cityIds = world.cities?.indexes?.byLocation?.[locationId] || [];
  const cityId = cityIds[0];
  const bySettlement = cityId ? world.cities?.pressure?.bySettlement?.[cityId] : null;
  if (bySettlement) return clamp(Number(bySettlement.riskScore || 0), 0, 1);
  const settlement = cityId ? world.cities?.byId?.[cityId] : null;
  return clamp(Number(settlement?.risk || world.cities?.pressure?.averageRisk || 0), 0, 1);
}

function calculateEconomicDisasterRisk(world, locationId) {
  const weather = world.natural?.weather?.byLocation?.[locationId] || { type: 'clear', severity: 0 };
  const weatherRisk = weatherEconomicRisk(weather.type, weather.severity);
  const active = Object.values(world.natural?.disasters?.active || {})
    .filter(disaster => !locationId || disaster.locationId === locationId)
    .reduce((sum, disaster) => sum + Number(disaster.severity || 0) * 0.45, 0);
  return clamp(weatherRisk + active, 0, 1);
}

function calculateEconomicEcologyRisk(world, locationId, industryType) {
  const habitat = world.ecology?.habitats?.byLocation?.[locationId];
  const human = world.ecology?.populations?.byKey?.[`${locationId}:human`];
  const suitability = Number(habitat?.suitability?.human ?? 0.6);
  const disease = clamp(Number(human?.diseaseLoad || 0), 0, 1);
  const pressure = human ? clamp(Math.max(0, Number(human.pressure || 0) - 1), 0, 2) / 2 : 0;
  const ecologySensitivity = industryEcologySensitivity(industryType);
  return clamp((1 - suitability) * 0.25 * ecologySensitivity + disease * 0.35 + pressure * 0.4, 0, 1);
}

function calculateEconomicResourceRisk(world, locationId, industryType) {
  const resources = world.locations?.[locationId]?.resources || {};
  const profile = industryResourceProfile(industryType);
  let risk = 0;
  let weight = 0;
  for (const [resource, required] of Object.entries(profile)) {
    weight += required;
    const available = Number(resources[resource] || 0);
    const coverage = clamp(available / Math.max(1, required * 100), 0, 1);
    risk += (1 - coverage) * required;
  }
  return weight ? clamp(risk / weight, 0, 1) : 0;
}

function inferIndustryStatus(riskScore, productionMultiplier, config) {
  if (riskScore >= config.stalledThreshold || productionMultiplier <= config.minProductionMultiplier + 0.02) return INDUSTRY_STATUS.STALLED;
  if (riskScore >= config.decliningThreshold) return INDUSTRY_STATUS.DECLINING;
  if (riskScore >= config.constrainedThreshold) return INDUSTRY_STATUS.CONSTRAINED;
  return INDUSTRY_STATUS.ACTIVE;
}

function industryResourceProfile(type) {
  return {
    agriculture: { food: 1, water: 1 },
    mining: { wood: 0.4, water: 0.3 },
    craft: { wood: 0.7, metal: 0.4, service: 0.2 },
    trade: { food: 0.2, service: 0.5 },
    service: { food: 0.1, service: 0.5 },
    entertainment: { luxury: 0.5, service: 0.6 },
    education: { knowledge: 0.5, service: 0.4 },
    religion: { service: 0.4, knowledge: 0.2 },
  }[type] || { food: 0.2 };
}

function industryEcologySensitivity(type) {
  return { agriculture: 1.5, mining: 0.7, craft: 0.8, trade: 0.9, service: 0.8, entertainment: 0.7, education: 0.5, religion: 0.5 }[type] || 1;
}

function getIndustryResilience(type) {
  return { agriculture: 0.15, mining: 0.25, craft: 0.35, trade: 0.45, service: 0.4, entertainment: 0.25, education: 0.55, religion: 0.5 }[type] || 0.3;
}

function marketResourceSensitivity(resource) {
  return {
    food: { demand: 1.4, supply: 1.2 },
    wood: { demand: 0.7, supply: 0.8 },
    stone: { demand: 0.6, supply: 0.7 },
    metal: { demand: 0.8, supply: 0.9 },
    fuel: { demand: 0.9, supply: 0.9 },
    luxury: { demand: 0.45, supply: 0.55 },
    knowledge: { demand: 0.35, supply: 0.25 },
    service: { demand: 0.65, supply: 0.35 },
  }[resource] || { demand: 0.5, supply: 0.5 };
}

function weatherEconomicRisk(type, severity) {
  const base = { clear: 0, cloudy: 0.03, rain: 0.08, storm: 0.55, snow: 0.25, drought: 0.65, heatwave: 0.55, cold_snap: 0.45 }[type] || 0.04;
  return clamp(base + Number(severity || 0) * 0.28, 0, 1);
}

function payOwner(world, industry, amount) {
  if (!amount) return;
  if (industry.ownerType === 'organization') {
    const org = getOrganization(world, industry.ownerId);
    if (org) org.assets.currency = Number(org.assets.currency || 0) + amount;
  }
  if (industry.ownerType === 'entity') {
    const entity = world.entities[industry.ownerId];
    if (entity) entity.resources.currency = Number(entity.resources.currency || 0) + amount;
  }
}

function recordTransaction(world, input) {
  const economy = ensureEconomyState(world);
  const transaction = {
    id: input.id || nextWorldId(world, 'tx', 'economy.transaction'),
    tick: world.tick,
    type: input.type,
    sellerType: input.sellerType || null,
    sellerId: input.sellerId || null,
    buyerType: input.buyerType || null,
    buyerId: input.buyerId || null,
    resource: input.resource,
    amount: Number(input.amount || 0),
    price: Number(input.price || 0),
    total: Number(input.total || 0),
  };
  economy.transactions.push(transaction);
  economy.stats.transactionVolume += transaction.total;
  if (economy.transactions.length > 1000) economy.transactions.shift();
  return transaction;
}

function seedIndustriesFromOrganizations(world, options = {}) {
  const created = [];
  const orgs = Object.values(world.organizations?.byId || {});
  for (const org of orgs) {
    if (Object.values(world.economy?.industries || {}).some(industry => industry.ownerType === 'organization' && industry.ownerId === org.id)) continue;
    const industryType = inferIndustryFromOrganization(org.type);
    created.push(createIndustry(world, { type: industryType, ownerType: 'organization', ownerId: org.id, locationId: org.homeLocationId, scale: Math.max(1, Math.ceil(org.members.length / 10)), workforce: [...org.members] }));
  }
  return created;
}

function inferIndustryFromOrganization(orgType) {
  if (orgType === 'guild' || orgType === 'company') return INDUSTRY_TYPES.TRADE;
  if (orgType === 'sect') return INDUSTRY_TYPES.EDUCATION;
  if (orgType === 'church') return INDUSTRY_TYPES.RELIGION;
  if (orgType === 'gang') return INDUSTRY_TYPES.SERVICE;
  if (orgType === 'state') return INDUSTRY_TYPES.SERVICE;
  if (orgType === 'school') return INDUSTRY_TYPES.EDUCATION;
  return INDUSTRY_TYPES.SERVICE;
}

function estimateOwnerWorkforce(world, industry) {
  if (industry.ownerType === 'organization') {
    const org = getOrganization(world, industry.ownerId);
    return org ? Math.max(1, org.members.length) : 1;
  }
  return 1;
}

function getMarket(world, marketId = 'global') { return ensureEconomyState(world).markets[marketId] || null; }
function getIndustry(world, industryId) { return ensureEconomyState(world).industries[industryId] || null; }

function snapshotMarkets(world) {
  const out = {};
  for (const [id, market] of Object.entries(ensureEconomyState(world).markets)) {
    out[id] = {};
    for (const [resource, item] of Object.entries(market.resources)) out[id][resource] = { price: item.price, supply: Math.round(item.supply), demand: Math.round(item.demand) };
  }
  return out;
}

function recordIndustryMemory(world, industry, type, payload = {}) {
  const memory = { id: `industry_memory_${world.tick}_${industry.memory.length + 1}`, tick: world.tick, type, payload: { industryId: industry.id, ...payload } };
  industry.memory.push(memory);
  if (industry.memory.length > 300) industry.memory.shift();
  return memory;
}

function rebuildEconomyIndexes(world) {
  const economy = ensureEconomyState(world);
  economy.indexes = { industriesByLocation: {}, industriesByType: {}, industriesByStatus: {} };
  for (const industry of Object.values(economy.industries)) {
    addIndex(economy.indexes.industriesByType, industry.type, industry.id);
    addIndex(economy.indexes.industriesByStatus, industry.status, industry.id);
    if (industry.locationId) addIndex(economy.indexes.industriesByLocation, industry.locationId, industry.id);
  }
}

function createEmptyIndustryEnvironment(tick = 0) { return { tick, cityPressure: 0, disasterRisk: 0, ecologyRisk: 0, populationRisk: 0, resourceRisk: 0, riskScore: 0, productionMultiplier: 1, pricePressure: 0, status: INDUSTRY_STATUS.ACTIVE }; }
function createEmptyEconomyEnvironmentSummary(tick = 0) { return { tick, industries: 0, highRisk: 0, stalled: 0, averageRisk: 0, averageProductionMultiplier: 1, averagePricePressure: 0, byIndustry: {} }; }
function ensureEconomyStats(economy) { for (const key of ['ticks', 'transactionVolume', 'environmentUpdates', 'constrainedIndustries', 'stalledIndustries']) if (economy.stats[key] === undefined) economy.stats[key] = 0; if (!economy.stats.production) economy.stats.production = {}; if (!economy.stats.consumption) economy.stats.consumption = {}; }
function mergeEconomyEnvironmentOptions(options = {}) { return { ...DEFAULT_ECONOMY_ENVIRONMENT_OPTIONS, ...(options || {}) }; }
function addIndex(index, key, value) { if (!index[key]) index[key] = []; if (!index[key].includes(value)) index[key].push(value); }
function average(values) { const filtered = (values || []).filter(Number.isFinite); return filtered.length ? filtered.reduce((sum, value) => sum + value, 0) / filtered.length : 0; }
function round(value, digits = 3) { const factor = 10 ** digits; return Math.round(Number(value || 0) * factor) / factor; }
function roundPrice(value) { return Math.round(Number(value || 0) * 100) / 100; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value || 0))); }

module.exports = {
  RESOURCE_TYPES,
  INDUSTRY_TYPES,
  INDUSTRY_STATUS,
  DEFAULT_MARKET_RESOURCES,
  DEFAULT_ECONOMY_ENVIRONMENT_OPTIONS,
  INDUSTRY_OUTPUTS,
  ensureEconomyState,
  createMarket,
  createIndustry,
  processEconomyTick,
  produceIndustryOutput,
  sellIndustryOutput,
  consumePopulationNeeds,
  updateMarketPrices,
  calculateIndustryEnvironment,
  applyIndustryEnvironment,
  summarizeEconomyEnvironment,
  seedIndustriesFromOrganizations,
  inferIndustryFromOrganization,
  getMarket,
  getIndustry,
  snapshotMarkets,
  rebuildEconomyIndexes,
};
