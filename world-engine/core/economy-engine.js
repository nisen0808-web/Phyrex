'use strict';

const { recordLifeEvent, LIFE_EVENT_TYPES } = require('./history-engine');
const { getOrganization } = require('./organization-engine');

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

function ensureEconomyState(world) {
  if (!world.economy) {
    world.economy = {
      markets: {},
      industries: {},
      transactions: [],
      indexes: {
        industriesByLocation: {},
        industriesByType: {},
      },
      stats: {
        ticks: 0,
        production: {},
        consumption: {},
        transactionVolume: 0,
      },
    };
    createMarket(world, { id: 'global', name: 'Global Market' });
  }
  return world.economy;
}

function createMarket(world, input = {}) {
  const economy = ensureEconomyState(world);
  const id = input.id || `market_${world.tick}_${Math.random().toString(16).slice(2)}`;
  const resources = {};
  for (const [resource, config] of Object.entries(DEFAULT_MARKET_RESOURCES)) {
    resources[resource] = {
      resource,
      price: input.resources?.[resource]?.price || config.basePrice,
      basePrice: config.basePrice,
      supply: input.resources?.[resource]?.supply ?? config.supply,
      demand: input.resources?.[resource]?.demand ?? config.demand,
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
  const id = input.id || `industry_${world.tick}_${Math.random().toString(16).slice(2)}`;
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
    revenue: 0,
    cost: 0,
    status: 'active',
    createdAt: world.tick,
    memory: [],
  };
  economy.industries[id] = industry;
  rebuildEconomyIndexes(world);
  return industry;
}

function processEconomyTick(world, options = {}) {
  const economy = ensureEconomyState(world);
  const produced = [];
  const consumed = [];
  const transactions = [];

  for (const industry of Object.values(economy.industries)) {
    if (industry.status !== 'active') continue;
    produced.push(...produceIndustryOutput(world, industry.id, options));
    transactions.push(...sellIndustryOutput(world, industry.id, options));
  }

  consumed.push(...consumePopulationNeeds(world, options));
  updateMarketPrices(world, options);
  economy.stats.ticks += 1;
  rebuildEconomyIndexes(world);

  return { produced, consumed, transactions, markets: snapshotMarkets(world) };
}

function produceIndustryOutput(world, industryId, options = {}) {
  const industry = getIndustry(world, industryId);
  if (!industry) return [];
  const results = [];
  const workforceMultiplier = Math.max(1, industry.workforce.length || estimateOwnerWorkforce(world, industry));
  const scale = Number(industry.scale || 1);
  const efficiency = Number(industry.efficiency || 1);

  if (!consumeInputsForIndustry(world, industry)) {
    industry.cost += 1;
    recordIndustryMemory(world, industry, 'industry.input_shortage', {});
    return results;
  }

  for (const [resource, baseAmount] of Object.entries(industry.outputs || {})) {
    const amount = Math.max(0, Math.round(Number(baseAmount || 0) * scale * efficiency * Math.sqrt(workforceMultiplier)));
    if (!amount) continue;
    industry.inventory[resource] = Number(industry.inventory[resource] || 0) + amount;
    world.economy.stats.production[resource] = Number(world.economy.stats.production[resource] || 0) + amount;
    results.push({ industryId, resource, amount });
  }

  if (results.length) recordIndustryMemory(world, industry, 'industry.produced', { results });
  return results;
}

function consumeInputsForIndustry(world, industry) {
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

  for (const [resource, amount] of Object.entries({ ...industry.inventory })) {
    if (resource === RESOURCE_TYPES.CURRENCY || amount <= 0 || !market.resources[resource]) continue;
    const sellAmount = Math.max(0, Math.floor(Number(amount) * (options.sellRatio ?? 0.5)));
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
  const foodNeed = alive.length * (options.foodPerEntity || 1);
  const serviceNeed = Math.round(alive.length * (options.servicePerEntity || 0.2));
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
  consumed.push({ marketId, resource, amount: actual, shortage: Math.max(0, amount - actual) });
}

function updateMarketPrices(world, options = {}) {
  for (const market of Object.values(ensureEconomyState(world).markets)) {
    for (const item of Object.values(market.resources)) {
      const pressure = item.demand / Math.max(1, item.supply);
      const target = item.basePrice * Math.max(0.2, pressure);
      item.price = roundPrice(item.price * 0.8 + target * 0.2);
      item.history.push({ tick: world.tick, price: item.price, supply: item.supply, demand: item.demand });
      if (item.history.length > 200) item.history.shift();
      item.supply = Math.max(0, item.supply * 0.995);
      item.demand = Math.max(1, item.demand * 0.995);
    }
  }
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
    id: input.id || `tx_${world.tick}_${economy.transactions.length + 1}`,
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
    created.push(createIndustry(world, {
      type: industryType,
      ownerType: 'organization',
      ownerId: org.id,
      locationId: org.homeLocationId,
      scale: Math.max(1, Math.ceil(org.members.length / 10)),
      workforce: [...org.members],
    }));
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

function getMarket(world, marketId = 'global') {
  return ensureEconomyState(world).markets[marketId] || null;
}

function getIndustry(world, industryId) {
  return ensureEconomyState(world).industries[industryId] || null;
}

function snapshotMarkets(world) {
  const out = {};
  for (const [id, market] of Object.entries(ensureEconomyState(world).markets)) {
    out[id] = {};
    for (const [resource, item] of Object.entries(market.resources)) {
      out[id][resource] = { price: item.price, supply: Math.round(item.supply), demand: Math.round(item.demand) };
    }
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
  economy.indexes = { industriesByLocation: {}, industriesByType: {} };
  for (const industry of Object.values(economy.industries)) {
    addIndex(economy.indexes.industriesByType, industry.type, industry.id);
    if (industry.locationId) addIndex(economy.indexes.industriesByLocation, industry.locationId, industry.id);
  }
}

function addIndex(index, key, value) {
  if (!index[key]) index[key] = [];
  if (!index[key].includes(value)) index[key].push(value);
}

function roundPrice(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

module.exports = {
  RESOURCE_TYPES,
  INDUSTRY_TYPES,
  DEFAULT_MARKET_RESOURCES,
  INDUSTRY_OUTPUTS,
  ensureEconomyState,
  createMarket,
  createIndustry,
  processEconomyTick,
  produceIndustryOutput,
  sellIndustryOutput,
  consumePopulationNeeds,
  updateMarketPrices,
  seedIndustriesFromOrganizations,
  inferIndustryFromOrganization,
  getMarket,
  getIndustry,
  snapshotMarkets,
  rebuildEconomyIndexes,
};
