'use strict';

const TYPES = Object.freeze(['equip_item', 'unequip_item', 'use_item', 'buy_item', 'sell_item', 'give_item']);
const SLOTS = Object.freeze(['weapon', 'armor', 'accessory', 'tool']);
const STATS = Object.freeze(['power', 'defense', 'speed', 'intelligence', 'social', 'maxHealth', 'maxEnergy']);
const MAX_OWNER_ITEMS = 128, MAX_WORLD_ITEMS = 1000, MAX_STACK = 1000000, MAX_SHOP_STOCK = 64;
const own = (map, key) => map && Object.hasOwn(map, key) ? map[key] : undefined;
const number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
const quantity = n => Number.isSafeInteger(n) && n > 0 && n <= MAX_STACK;
const fail = reason => ({ reason });
function ownedItems(world, id) {
  return Object.values(world.items?.instances || {}).filter(item => item.ownerType === 'entity' && item.ownerId === id);
}
function ownedItem(world, entityId, id) {
  const item = own(world.items?.instances, id);
  return item && item.ownerType === 'entity' && item.ownerId === entityId
    && world.items.byOwner?.[`entity:${entityId}`]?.includes(id) ? item : null;
}
function itemView(world, item) {
  const definition = own(world.items?.definitions, item.definitionId) || {};
  const fields = (source, keys) => Object.fromEntries(keys.filter(key => number(source?.[key])).map(key => [key, source[key]]));
  const text = value => typeof value === 'string' ? value.slice(0, 200) : null;
  return { id: item.id, definitionId: item.definitionId, name: text(item.name || definition.name),
    type: text(item.type), rarity: text(item.rarity), slot: SLOTS.includes(item.slot) ? item.slot : null,
    quantity: item.quantity, equipped: item.equipped === true,
    stats: fields(item.stats, [...STATS, 'health', 'energy']), effects: fields(item.effects, ['health', 'energy']) };
}
function shopView(shop) {
  return { id: shop.id, name: typeof shop.name === 'string' ? shop.name.slice(0, 200) : null,
    locationId: shop.locationId, stock: Object.keys(shop.stock || {}).sort().slice(0, MAX_SHOP_STOCK).map(id => {
      const s = shop.stock[id]; return { definitionId: id, price: s.price, quantity: s.quantity };
    }), stockCount: Object.keys(shop.stock || {}).length };
}
function commerceView(world, entity) {
  if (!entity) return { items: [], equipment: {}, shops: [], itemCount: 0, shopCount: 0 };
  const items = ownedItems(world, entity.id).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const shops = Object.values(world.shops?.byId || {}).filter(s => entity.locationId && s.locationId === entity.locationId)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { items: items.slice(0, MAX_OWNER_ITEMS).map(i => itemView(world, i)), itemCount: items.length,
    equipment: Object.fromEntries(SLOTS.filter(slot => ownedItem(world, entity.id, entity.meta?.equipment?.[slot]))
      .map(slot => [slot, entity.meta.equipment[slot]])),
    shops: shops.slice(0, 8).map(shopView), shopCount: shops.length };
}
function validItem(item) {
  return item && quantity(item.quantity) && item.id && item.definitionId;
}
function equipmentDelta(item, legacy = false) {
  const source = item.equipmentApplied || item.stats || {}, out = {};
  for (let [key, value] of Object.entries(source)) {
    if (!number(value) || value > 1000000 || ![...STATS, 'health', 'energy'].includes(key)) return null;
    // Equipment increases capacity; equipping it must never refill a consumable stat.
    if (!legacy && !item.equipmentApplied && ['health', 'energy'].includes(key)) key = key === 'health' ? 'maxHealth' : 'maxEnergy';
    out[key] = (out[key] || 0) + value;
  }
  return out;
}
function changedStats(entity, remove = {}, add = {}) {
  const stats = { ...entity.stats };
  for (const key of new Set([...Object.keys(remove), ...Object.keys(add)])) {
    const value = (stats[key] ?? 0) - (remove[key] || 0) + (add[key] || 0);
    if (!number(value)) return null;
    stats[key] = value;
  }
  if (!number(stats.maxHealth) || stats.maxHealth < 1 || !number(stats.maxEnergy)) return null;
  stats.health = Math.min(stats.health, stats.maxHealth); stats.energy = Math.min(stats.energy, stats.maxEnergy);
  if (!number(stats.health) || stats.health <= 0 || !number(stats.energy)) return null;
  return stats;
}
function planInventoryOperation(world, entity, type, p = {}) {
  if (!TYPES.includes(type)) return fail('unknown_action');
  if (!entity || entity.status !== 'alive' || !number(entity.stats?.health) || entity.stats.health <= 0) return fail('actor_not_alive');
  const plan = { type, entityId: entity.id, payload: { ...p } };
  let item;
  if (type !== 'buy_item') {
    const id = type === 'unequip_item' ? own(entity.meta?.equipment, p.slot) : p.itemId;
    item = ownedItem(world, entity.id, id);
    if (!validItem(item)) return fail('item_not_owned');
    plan.itemId = item.id;
  }
  if (type === 'equip_item' || type === 'unequip_item') {
    const definition = own(world.items?.definitions, item.definitionId);
    const slot = item.slot || definition?.slot;
    if (definition?.type !== 'equipment' || item.type !== 'equipment' || !SLOTS.includes(slot) || item.quantity !== 1) return fail('invalid_equipment');
    plan.slot = slot;
    const equippedId = own(entity.meta?.equipment, slot);
    if (type === 'equip_item' && equippedId === item.id && item.equipped) { plan.unchanged = true; return plan; }
    if (type === 'equip_item' && item.equipped) return fail('invalid_equipment_state');
    const previous = equippedId ? ownedItem(world, entity.id, equippedId) : null;
    if (equippedId && (!previous || !previous.equipped)) return fail('invalid_equipment_state');
    const removing = previous ? equipmentDelta(previous, true) : {};
    const adding = type === 'equip_item' ? equipmentDelta(item) : {};
    if (!removing || !adding) return fail('invalid_equipment');
    plan.stats = changedStats(entity, removing, adding);
    if (!plan.stats) return fail('invalid_equipment_state');
    plan.previousId = previous?.id || null; plan.applied = adding;
  } else if (type === 'use_item') {
    if (item.type !== 'consumable' || item.equipped || own(world.items?.definitions, item.definitionId)?.type !== 'consumable') return fail('not_consumable');
    const effects = item.effects || {}, stats = { ...entity.stats }, actual = {};
    if (!Object.keys(effects).length) return fail('invalid_item_effect');
    for (const [key, value] of Object.entries(effects)) {
      const maximum = key === 'health' ? 'maxHealth' : key === 'energy' ? 'maxEnergy' : null;
      if (!maximum || !number(value) || value > 1000000 || !number(stats[key]) || !number(stats[maximum])) return fail('invalid_item_effect');
      actual[key] = Math.min(value, Math.max(0, stats[maximum] - stats[key])); stats[key] += actual[key];
    }
    if (!Object.values(actual).some(n => n > 0)) return fail('no_item_effect');
    plan.stats = stats; plan.effects = actual;
  } else if (type === 'give_item') {
    const target = own(world.entities, p.targetId);
    if (!target || target.id === entity.id || target.status !== 'alive' || !number(target.stats?.health) || target.stats.health <= 0) return fail('invalid_target');
    if (!entity.locationId || entity.locationId !== target.locationId) return fail('target_not_at_location');
    if (item.equipped) return fail('item_equipped');
    if (ownedItems(world, target.id).length >= MAX_OWNER_ITEMS) return fail('inventory_full');
    plan.targetId = target.id;
  } else {
    const shop = own(world.shops?.byId, p.shopId), amount = p.quantity === undefined ? 1 : p.quantity;
    if (!shop) return fail('missing_shop');
    if (!entity.locationId || shop.locationId !== entity.locationId) return fail('shop_not_at_location');
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100) return fail('invalid_quantity');
    if (!number(shop.currency) || !number(entity.resources?.currency)) return fail('invalid_currency');
    const definitionId = type === 'buy_item' ? p.definitionId : item.definitionId;
    const definition = own(world.items?.definitions, definitionId), stock = own(shop.stock, definitionId);
    if (!definition) return fail('missing_item_definition');
    const price = stock?.price ?? definition.price;
    if (!Number.isSafeInteger(price) || price < 1 || price > 1000000) return fail('invalid_price');
    if (stock && (!Number.isSafeInteger(stock.quantity) || stock.quantity < 0 || stock.quantity > MAX_STACK)) return fail('invalid_stock');
    plan.shopId = shop.id; plan.definitionId = definitionId; plan.quantity = amount; plan.price = price;
    if (type === 'buy_item') {
      if (!stock || stock.quantity < amount) return fail('insufficient_stock');
      if (!definition.stackable && amount !== 1) return fail('nonstackable_quantity');
      const existing = definition.stackable && ownedItems(world, entity.id).find(i => i.definitionId === definitionId && !i.equipped);
      if (existing && (!validItem(existing) || existing.quantity + amount > MAX_STACK)) return fail('inventory_full');
      if (!existing && (ownedItems(world, entity.id).length >= MAX_OWNER_ITEMS || Object.keys(world.items.instances).length >= MAX_WORLD_ITEMS)) return fail('inventory_full');
      plan.cost = price * amount;
      if (entity.resources.currency < plan.cost) return fail('insufficient_currency');
      if (!number(shop.currency + plan.cost)) return fail('invalid_currency');
    } else {
      if (item.equipped) return fail('item_equipped');
      if (amount > item.quantity) return fail('insufficient_items');
      if (!stock && Object.keys(shop.stock).length >= MAX_SHOP_STOCK) return fail('shop_stock_full');
      if ((stock?.quantity || 0) + amount > MAX_STACK) return fail('shop_stock_full');
      plan.revenue = Math.max(1, Math.floor(price / 2)) * amount;
      if (shop.currency < plan.revenue) return fail('shop_insufficient_currency');
      if (!number(entity.resources.currency + plan.revenue)) return fail('invalid_currency');
    }
  }
  return plan;
}
// Caller prepares immediately before applying. No awaits or user-controlled callbacks occur between them.
function applyInventoryOperation(world, plan) {
  const { removeItem, grantItem, transferItem } = require('./item-engine');
  const entity = world.entities[plan.entityId], item = world.items?.instances[plan.itemId];
  const value = { entityId: entity.id, ...(item ? { itemId: item.id, definitionId: item.definitionId } : {}) };
  if (plan.unchanged) return { ...value, slot: plan.slot, unchanged: true };
  if (plan.type === 'equip_item' || plan.type === 'unequip_item') {
    entity.meta ||= {}; entity.meta.equipment ||= {};
    const previous = world.items.instances[plan.previousId];
    if (previous) { previous.equipped = false; delete previous.equipmentApplied; previous.updatedAt = world.tick; }
    entity.stats = plan.stats;
    if (plan.type === 'equip_item') {
      item.equipped = true; item.equipmentApplied = plan.applied; item.updatedAt = world.tick; entity.meta.equipment[plan.slot] = item.id;
    } else delete entity.meta.equipment[plan.slot];
    Object.assign(value, { slot: plan.slot, previousId: plan.previousId });
  } else if (plan.type === 'use_item') {
    entity.stats = plan.stats; removeItem(world, item.id, 1); value.effects = plan.effects;
  } else if (plan.type === 'give_item') {
    transferItem(world, item.id, 'entity', plan.targetId); value.targetId = plan.targetId; value.quantity = item.quantity;
  } else {
    const shop = world.shops.byId[plan.shopId];
    if (plan.type === 'buy_item') {
      const bought = grantItem(world, 'entity', entity.id, plan.definitionId, plan.quantity);
      entity.resources.currency -= plan.cost; shop.currency += plan.cost; shop.stock[plan.definitionId].quantity -= plan.quantity;
      world.shops.stats.bought += plan.quantity; Object.assign(value, { itemId: bought.id, cost: plan.cost });
    } else {
      removeItem(world, item.id, plan.quantity); entity.resources.currency += plan.revenue; shop.currency -= plan.revenue;
      shop.stock[plan.definitionId] ||= { definitionId: plan.definitionId, name: world.items.definitions[plan.definitionId].name, price: plan.price, quantity: 0 };
      shop.stock[plan.definitionId].quantity += plan.quantity; world.shops.stats.sold += plan.quantity; value.revenue = plan.revenue;
    }
    shop.updatedAt = world.tick;
    Object.assign(value, { shopId: shop.id, definitionId: plan.definitionId, quantity: plan.quantity });
  }
  return value;
}
function performInventoryOperation(world, entity, type, payload) {
  const plan = planInventoryOperation(world, entity, type, payload);
  if (plan.reason) throw Object.assign(new Error(plan.reason), { code: 'WORLD_ITEM_OPERATION_REJECTED', reason: plan.reason });
  const value = applyInventoryOperation(world, plan);
  if (!plan.unchanged) {
    require('./world-engine').recordMemory(world, { type, actorIds: [entity.id], payload: value });
    const playerId = entity.meta?.playerId;
    if (world.players?.byId?.[playerId]?.controlledEntityIds?.includes(entity.id)) {
      const { recordPlayerJournal, JOURNAL_TYPES } = require('./player-journal-engine');
      recordPlayerJournal(world, playerId, { type: JOURNAL_TYPES.SYSTEM, title: type, summary: `${entity.name}: ${type}`,
        entityId: entity.id, locationId: entity.locationId, tags: ['inventory', type], payload: value });
    }
  }
  return value;
}
module.exports = { TYPES, SLOTS, MAX_OWNER_ITEMS, MAX_WORLD_ITEMS, MAX_STACK, MAX_SHOP_STOCK, ownedItems, ownedItem,
  itemView, shopView, commerceView, planInventoryOperation, applyInventoryOperation, performInventoryOperation };
