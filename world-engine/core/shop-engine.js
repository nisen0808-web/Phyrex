'use strict';

const { changeEntityResource, recordMemory } = require('./world-engine');
const { getActivePlayerCharacter } = require('./player-engine');
const { grantItem, getItemDefinition, getOwnerItems, removeItem } = require('./item-engine');
const { summarizeItem } = require('./inventory-engine');
const { recordPlayerJournal, JOURNAL_TYPES } = require('./player-journal-engine');

const SHOP_TYPES = {
  GENERAL: 'general',
  HERBALIST: 'herbalist',
  BLACKSMITH: 'blacksmith',
};

const DEFAULT_SHOP_STOCK = {
  general: ['wooden_sword', 'cloth_robe', 'healing_pill', 'spirit_stone'],
  herbalist: ['healing_pill', 'forest_herb', 'spirit_stone'],
  blacksmith: ['wooden_sword', 'iron_ore'],
};

function ensureShopState(world) {
  if (!world.shops) {
    world.shops = {
      byId: {},
      byLocation: {},
      stats: {
        created: 0,
        bought: 0,
        sold: 0,
      },
    };
  }
  return world.shops;
}

function createShop(world, input = {}) {
  const state = ensureShopState(world);
  const id = input.id || `shop_${input.locationId || 'world'}_${input.type || SHOP_TYPES.GENERAL}`;
  if (state.byId[id]) return state.byId[id];
  const shop = {
    id,
    name: input.name || inferShopName(world, input.locationId, input.type),
    type: input.type || SHOP_TYPES.GENERAL,
    locationId: input.locationId || null,
    stock: normalizeStock(world, input.stock || DEFAULT_SHOP_STOCK[input.type || SHOP_TYPES.GENERAL] || DEFAULT_SHOP_STOCK.general),
    currency: Number(input.currency || 1000),
    createdAt: world.tick,
    updatedAt: world.tick,
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
  };
  state.byId[id] = shop;
  if (shop.locationId) {
    if (!state.byLocation[shop.locationId]) state.byLocation[shop.locationId] = [];
    if (!state.byLocation[shop.locationId].includes(id)) state.byLocation[shop.locationId].push(id);
  }
  state.stats.created += 1;
  return shop;
}

function getLocationShops(world, locationId) {
  const state = ensureShopState(world);
  seedLocationShops(world, locationId);
  return (state.byLocation[locationId] || []).map(id => state.byId[id]).filter(Boolean);
}

function getPlayerShop(world, playerId) {
  const entity = getActivePlayerCharacter(world, playerId);
  const locationId = entity?.locationId || null;
  return {
    playerId,
    entityId: entity?.id || null,
    locationId,
    shops: locationId ? getLocationShops(world, locationId).map(summarizeShop) : [],
  };
}

function seedLocationShops(world, locationId) {
  const location = world.locations?.[locationId];
  if (!location) return [];
  const created = [];
  created.push(createShop(world, { id: `shop_${locationId}_general`, type: SHOP_TYPES.GENERAL, locationId, name: `${location.name || locationId} Market` }));
  if (Object.keys(location.resources || {}).includes('herb') || Object.keys(location.resources || {}).includes('food')) {
    created.push(createShop(world, { id: `shop_${locationId}_herbalist`, type: SHOP_TYPES.HERBALIST, locationId, name: `${location.name || locationId} Herbalist` }));
  }
  if (Object.keys(location.resources || {}).includes('ore') || Object.keys(location.resources || {}).includes('iron')) {
    created.push(createShop(world, { id: `shop_${locationId}_blacksmith`, type: SHOP_TYPES.BLACKSMITH, locationId, name: `${location.name || locationId} Blacksmith` }));
  }
  return created;
}

function buyItem(world, playerId, shopId, itemDefinitionId, quantity = 1) {
  const state = ensureShopState(world);
  const shop = state.byId[shopId];
  if (!shop) throw new Error(`Missing shop ${shopId}`);
  const entity = getActivePlayerCharacter(world, playerId);
  if (!entity) throw new Error(`Missing active character for ${playerId}`);
  if (shop.locationId && entity.locationId !== shop.locationId) throw new Error(`Shop ${shopId} is not at current location`);
  const stock = shop.stock[itemDefinitionId];
  if (!stock || Number(stock.quantity || 0) < quantity) throw new Error(`Shop does not have enough ${itemDefinitionId}`);
  const definition = getItemDefinition(world, itemDefinitionId);
  if (!definition) throw new Error(`Missing item definition ${itemDefinitionId}`);
  const amount = Math.max(1, Number(quantity || 1));
  const cost = Number(stock.price ?? definition.price ?? 1) * amount;
  if (Number(entity.resources.currency || 0) < cost) throw new Error(`Not enough currency: need ${cost}`);

  changeEntityResource(world, entity.id, 'currency', -cost);
  stock.quantity -= amount;
  shop.currency += cost;
  shop.updatedAt = world.tick;
  const item = grantItem(world, 'entity', entity.id, itemDefinitionId, amount);
  state.stats.bought += amount;
  recordMemory(world, { type: 'shop.buy', payload: { playerId, entityId: entity.id, shopId, itemDefinitionId, quantity: amount, cost } });
  recordPlayerJournal(world, playerId, {
    type: JOURNAL_TYPES.REWARD,
    title: `Bought ${definition.name}`,
    summary: `${entity.name} bought ${amount} ${definition.name} for ${cost} currency.`,
    entityId: entity.id,
    locationId: entity.locationId,
    tags: ['shop', 'buy', itemDefinitionId],
    payload: { shopId, itemId: item.id, definitionId: itemDefinitionId, quantity: amount, cost },
  });
  return { shop: summarizeShop(shop), item: summarizeItem(world, item), cost, quantity: amount };
}

function sellItem(world, playerId, itemInstanceId, quantity = 1) {
  const entity = getActivePlayerCharacter(world, playerId);
  if (!entity) throw new Error(`Missing active character for ${playerId}`);
  const item = getOwnerItems(world, 'entity', entity.id).find(entry => entry.id === itemInstanceId);
  if (!item) throw new Error(`Missing inventory item ${itemInstanceId}`);
  if (item.equipped) throw new Error(`Cannot sell equipped item ${itemInstanceId}`);
  const definition = getItemDefinition(world, item.definitionId);
  const amount = Math.min(item.quantity, Math.max(1, Number(quantity || 1)));
  const revenue = Math.max(1, Math.floor(Number(definition?.price || 1) * amount * 0.5));
  removeItem(world, item.id, amount);
  changeEntityResource(world, entity.id, 'currency', revenue);
  ensureShopState(world).stats.sold += amount;
  recordMemory(world, { type: 'shop.sell', payload: { playerId, entityId: entity.id, itemId: itemInstanceId, definitionId: item.definitionId, quantity: amount, revenue } });
  recordPlayerJournal(world, playerId, {
    type: JOURNAL_TYPES.REWARD,
    title: `Sold ${definition?.name || item.name}`,
    summary: `${entity.name} sold ${amount} ${definition?.name || item.name} for ${revenue} currency.`,
    entityId: entity.id,
    locationId: entity.locationId,
    tags: ['shop', 'sell', item.definitionId],
    payload: { itemId: itemInstanceId, definitionId: item.definitionId, quantity: amount, revenue },
  });
  return { itemId: itemInstanceId, definitionId: item.definitionId, quantity: amount, revenue };
}

function getShopStats(world) {
  const state = ensureShopState(world);
  const shops = Object.values(state.byId || {});
  return {
    total: shops.length,
    byType: countBy(shops.map(shop => shop.type)),
    stats: { ...state.stats },
  };
}

function summarizeShop(shop) {
  return {
    id: shop.id,
    name: shop.name,
    type: shop.type,
    locationId: shop.locationId,
    currency: shop.currency,
    stock: Object.values(shop.stock || {}).map(item => ({ ...item })),
    updatedAt: shop.updatedAt,
  };
}

function formatShopList(shopView) {
  const shops = shopView?.shops || [];
  if (!shops.length) return 'No shops at current location.';
  const lines = [`Shops at ${shopView.locationId || 'unknown'}:`];
  for (const shop of shops) {
    lines.push(`${shop.name} [${shop.id}] ${shop.type}`);
    for (const stock of shop.stock || []) {
      lines.push(`  - ${stock.definitionId} ${stock.name} price=${stock.price} qty=${stock.quantity}`);
    }
  }
  return lines.join('\n');
}

function normalizeStock(world, stockInput) {
  const out = {};
  if (Array.isArray(stockInput)) {
    for (const definitionId of stockInput) {
      const definition = getItemDefinition(world, definitionId);
      if (!definition) continue;
      out[definitionId] = { definitionId, name: definition.name, price: definition.price, quantity: 10 };
    }
    return out;
  }
  for (const [definitionId, value] of Object.entries(stockInput || {})) {
    const definition = getItemDefinition(world, definitionId);
    if (!definition) continue;
    out[definitionId] = {
      definitionId,
      name: definition.name,
      price: Number(value.price ?? definition.price ?? 1),
      quantity: Number(value.quantity ?? value ?? 1),
    };
  }
  return out;
}

function inferShopName(world, locationId, type) {
  const locationName = world.locations?.[locationId]?.name || locationId || 'World';
  if (type === SHOP_TYPES.HERBALIST) return `${locationName} Herbalist`;
  if (type === SHOP_TYPES.BLACKSMITH) return `${locationName} Blacksmith`;
  return `${locationName} Market`;
}

function countBy(values) {
  const out = {};
  for (const value of values || []) {
    const key = value === undefined || value === null ? 'unknown' : String(value);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

module.exports = {
  SHOP_TYPES,
  DEFAULT_SHOP_STOCK,
  ensureShopState,
  createShop,
  getLocationShops,
  getPlayerShop,
  seedLocationShops,
  buyItem,
  sellItem,
  getShopStats,
  summarizeShop,
  formatShopList,
};
