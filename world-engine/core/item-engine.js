'use strict';

const ITEM_TYPES = {
  MATERIAL: 'material',
  CONSUMABLE: 'consumable',
  EQUIPMENT: 'equipment',
  TREASURE: 'treasure',
};

const ITEM_RARITY = {
  COMMON: 'common',
  UNCOMMON: 'uncommon',
  RARE: 'rare',
  EPIC: 'epic',
  LEGENDARY: 'legendary',
};

const DEFAULT_ITEM_DEFINITIONS = [
  {
    id: 'wooden_sword',
    name: 'Wooden Sword',
    type: ITEM_TYPES.EQUIPMENT,
    slot: 'weapon',
    rarity: ITEM_RARITY.COMMON,
    price: 25,
    stackable: false,
    stats: { power: 2 },
    tags: ['weapon', 'starter'],
  },
  {
    id: 'cloth_robe',
    name: 'Cloth Robe',
    type: ITEM_TYPES.EQUIPMENT,
    slot: 'armor',
    rarity: ITEM_RARITY.COMMON,
    price: 20,
    stackable: false,
    stats: { defense: 1, energy: 2 },
    tags: ['armor', 'starter'],
  },
  {
    id: 'healing_pill',
    name: 'Healing Pill',
    type: ITEM_TYPES.CONSUMABLE,
    rarity: ITEM_RARITY.COMMON,
    price: 12,
    stackable: true,
    effects: { health: 20 },
    tags: ['medicine', 'consumable'],
  },
  {
    id: 'spirit_stone',
    name: 'Spirit Stone',
    type: ITEM_TYPES.CONSUMABLE,
    rarity: ITEM_RARITY.UNCOMMON,
    price: 50,
    stackable: true,
    effects: { energy: 15 },
    tags: ['cultivation', 'currency-like'],
  },
  {
    id: 'iron_ore',
    name: 'Iron Ore',
    type: ITEM_TYPES.MATERIAL,
    rarity: ITEM_RARITY.COMMON,
    price: 8,
    stackable: true,
    tags: ['material', 'ore'],
  },
  {
    id: 'forest_herb',
    name: 'Forest Herb',
    type: ITEM_TYPES.MATERIAL,
    rarity: ITEM_RARITY.COMMON,
    price: 6,
    stackable: true,
    tags: ['material', 'herb'],
  },
];

const DEFAULT_ITEM_OPTIONS = {
  maxInstances: 1000,
};

function ensureItemState(world) {
  if (!world.items) {
    world.items = {
      definitions: {},
      instances: {},
      byOwner: {},
      stats: {
        definitions: 0,
        created: 0,
        granted: 0,
        removed: 0,
        equipped: 0,
        unequipped: 0,
        used: 0,
        pruned: 0,
      },
    };
  }
  seedDefaultItems(world);
  return world.items;
}

function seedDefaultItems(world) {
  if (!world.items) return;
  for (const definition of DEFAULT_ITEM_DEFINITIONS) {
    if (!world.items.definitions[definition.id]) defineItem(world, definition);
  }
}

function defineItem(world, input = {}) {
  if (!input.id) throw new Error('Item definition requires id');
  const state = world.items || (world.items = { definitions: {}, instances: {}, byOwner: {}, stats: { definitions: 0, created: 0, granted: 0, removed: 0, equipped: 0, unequipped: 0, used: 0, pruned: 0 } });
  const definition = {
    id: input.id,
    name: input.name || input.id,
    type: input.type || ITEM_TYPES.MATERIAL,
    rarity: input.rarity || ITEM_RARITY.COMMON,
    slot: input.slot || null,
    price: Number(input.price || 1),
    stackable: input.stackable !== false,
    stats: { ...(input.stats || {}) },
    effects: { ...(input.effects || {}) },
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    meta: { ...(input.meta || {}) },
  };
  state.definitions[definition.id] = definition;
  state.stats.definitions = Object.keys(state.definitions).length;
  return definition;
}

function getItemDefinition(world, definitionId) {
  const state = ensureItemState(world);
  return state.definitions[definitionId] || null;
}

function createItemInstance(world, input = {}) {
  const state = ensureItemState(world);
  const definition = getItemDefinition(world, input.definitionId || input.itemId);
  if (!definition) throw new Error(`Missing item definition ${input.definitionId || input.itemId}`);
  const quantity = Math.max(1, Number(input.quantity || 1));
  const ownerType = input.ownerType || null;
  const ownerId = input.ownerId || null;
  const id = input.id || `item_${world.tick}_${definition.id}_${Math.random().toString(16).slice(2)}`;
  const instance = {
    id,
    definitionId: definition.id,
    name: input.name || definition.name,
    type: definition.type,
    rarity: definition.rarity,
    slot: definition.slot,
    quantity: definition.stackable ? quantity : 1,
    ownerType,
    ownerId,
    equipped: false,
    createdAt: world.tick,
    updatedAt: world.tick,
    stats: { ...definition.stats, ...(input.stats || {}) },
    effects: { ...definition.effects, ...(input.effects || {}) },
    tags: Array.from(new Set([...(definition.tags || []), ...(input.tags || [])])),
    meta: { ...(definition.meta || {}), ...(input.meta || {}) },
  };
  state.instances[id] = instance;
  indexItemInstance(world, instance);
  state.stats.created += 1;
  pruneItemInstances(world, DEFAULT_ITEM_OPTIONS.maxInstances);
  return instance;
}

function grantItem(world, ownerType, ownerId, definitionId, quantity = 1, options = {}) {
  const state = ensureItemState(world);
  const definition = getItemDefinition(world, definitionId);
  if (!definition) throw new Error(`Missing item definition ${definitionId}`);
  if (definition.stackable) {
    const existing = getOwnerItems(world, ownerType, ownerId).find(item => item.definitionId === definitionId && !item.equipped);
    if (existing) {
      existing.quantity += Math.max(1, Number(quantity || 1));
      existing.updatedAt = world.tick;
      state.stats.granted += 1;
      return existing;
    }
  }
  const item = createItemInstance(world, { definitionId, quantity, ownerType, ownerId, ...options });
  state.stats.granted += 1;
  return item;
}

function removeItem(world, itemInstanceId, quantity = 1) {
  const state = ensureItemState(world);
  const item = state.instances[itemInstanceId];
  if (!item) return null;
  const amount = Math.max(1, Number(quantity || 1));
  if (item.quantity > amount) {
    item.quantity -= amount;
    item.updatedAt = world.tick;
    state.stats.removed += amount;
    return item;
  }
  unindexItemInstance(world, item);
  delete state.instances[itemInstanceId];
  state.stats.removed += item.quantity;
  return null;
}

function getOwnerItems(world, ownerType, ownerId) {
  const state = ensureItemState(world);
  return (state.byOwner[ownerKey(ownerType, ownerId)] || [])
    .map(id => state.instances[id])
    .filter(Boolean);
}

function transferItem(world, itemInstanceId, ownerType, ownerId) {
  const state = ensureItemState(world);
  const item = state.instances[itemInstanceId];
  if (!item) return null;
  unindexItemInstance(world, item);
  item.ownerType = ownerType;
  item.ownerId = ownerId;
  item.equipped = false;
  item.updatedAt = world.tick;
  indexItemInstance(world, item);
  return item;
}

function getItemStats(world) {
  const state = ensureItemState(world);
  const instances = Object.values(state.instances || {});
  return {
    definitions: Object.keys(state.definitions || {}).length,
    instances: instances.length,
    equipped: instances.filter(item => item.equipped).length,
    byType: countBy(instances.map(item => item.type)),
    byRarity: countBy(instances.map(item => item.rarity)),
    stats: { ...state.stats },
  };
}

function pruneItemInstances(world, limit) {
  const state = ensureItemState(world);
  const ids = Object.keys(state.instances || {});
  if (ids.length <= limit) return [];
  const removable = ids
    .map(id => state.instances[id])
    .filter(item => item.ownerType !== 'entity' && !item.equipped)
    .sort((a, b) => Number(a.updatedAt || a.createdAt || 0) - Number(b.updatedAt || b.createdAt || 0));
  const removed = [];
  while (Object.keys(state.instances).length > limit && removable.length) {
    const item = removable.shift();
    unindexItemInstance(world, item);
    delete state.instances[item.id];
    removed.push(item.id);
  }
  state.stats.pruned += removed.length;
  return removed;
}

function indexItemInstance(world, item) {
  const state = ensureItemState(world);
  const key = ownerKey(item.ownerType, item.ownerId);
  if (!state.byOwner[key]) state.byOwner[key] = [];
  if (!state.byOwner[key].includes(item.id)) state.byOwner[key].push(item.id);
}

function unindexItemInstance(world, item) {
  const state = ensureItemState(world);
  const key = ownerKey(item.ownerType, item.ownerId);
  state.byOwner[key] = (state.byOwner[key] || []).filter(id => id !== item.id);
}

function ownerKey(ownerType, ownerId) {
  return `${ownerType || 'none'}:${ownerId || 'none'}`;
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
  ITEM_TYPES,
  ITEM_RARITY,
  DEFAULT_ITEM_DEFINITIONS,
  DEFAULT_ITEM_OPTIONS,
  ensureItemState,
  seedDefaultItems,
  defineItem,
  getItemDefinition,
  createItemInstance,
  grantItem,
  removeItem,
  getOwnerItems,
  transferItem,
  getItemStats,
};
