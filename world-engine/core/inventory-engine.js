'use strict';

const { changeEntityResource, changeEntityStat, recordMemory } = require('./world-engine');
const { getActivePlayerCharacter } = require('./player-engine');
const { getOwnerItems, getItemDefinition, removeItem, grantItem, getItemStats } = require('./item-engine');
const { recordPlayerJournal, JOURNAL_TYPES } = require('./player-journal-engine');

const EQUIPMENT_SLOTS = ['weapon', 'armor', 'accessory', 'tool'];

function getEntityInventory(world, entityId) {
  const entity = world.entities?.[entityId];
  if (!entity) return null;
  const items = getOwnerItems(world, 'entity', entityId);
  return {
    entityId,
    items: items.map(item => summarizeItem(world, item)),
    equipment: getEntityEquipment(world, entityId),
    equipmentStats: getEquipmentStats(world, entityId),
    stats: getItemStats(world),
  };
}

function getPlayerInventory(world, playerId) {
  const entity = getActivePlayerCharacter(world, playerId);
  if (!entity) return { playerId, entityId: null, items: [], equipment: {}, equipmentStats: {} };
  return { playerId, ...getEntityInventory(world, entity.id) };
}

function equipItem(world, entityId, itemInstanceId, options = {}) {
  const entity = world.entities?.[entityId];
  if (!entity) throw new Error(`Missing entity ${entityId}`);
  const item = getOwnerItems(world, 'entity', entityId).find(entry => entry.id === itemInstanceId);
  if (!item) throw new Error(`Missing inventory item ${itemInstanceId}`);
  const definition = getItemDefinition(world, item.definitionId);
  if (!definition || definition.type !== 'equipment') throw new Error(`Item ${itemInstanceId} is not equipment`);
  const slot = item.slot || definition.slot;
  if (!slot) throw new Error(`Equipment ${itemInstanceId} has no slot`);

  ensureEquipmentMeta(entity);
  const previousId = entity.meta.equipment[slot];
  if (previousId && previousId !== item.id) unequipItem(world, entityId, slot, { silent: true });

  item.equipped = true;
  item.updatedAt = world.tick;
  entity.meta.equipment[slot] = item.id;
  applyItemStats(world, entityId, item.stats || {}, 1);
  recordMemory(world, { type: 'inventory.equipped', payload: { entityId, itemId: item.id, slot } });
  if (options.playerId) recordPlayerJournal(world, options.playerId, {
    type: JOURNAL_TYPES.REWARD,
    title: `Equipped ${item.name}`,
    summary: `${entity.name} equipped ${item.name} in ${slot}.`,
    entityId,
    tags: ['inventory', 'equipment', slot],
    payload: { itemId: item.id, slot },
  });
  return { item: summarizeItem(world, item), slot, previousId };
}

function unequipItem(world, entityId, slotOrItemId, options = {}) {
  const entity = world.entities?.[entityId];
  if (!entity) throw new Error(`Missing entity ${entityId}`);
  ensureEquipmentMeta(entity);
  const slot = entity.meta.equipment[slotOrItemId] ? slotOrItemId : findSlotByItemId(entity, slotOrItemId);
  if (!slot) return null;
  const itemId = entity.meta.equipment[slot];
  const item = world.items?.instances?.[itemId];
  if (!item) {
    delete entity.meta.equipment[slot];
    return null;
  }
  item.equipped = false;
  item.updatedAt = world.tick;
  delete entity.meta.equipment[slot];
  applyItemStats(world, entityId, item.stats || {}, -1);
  if (!options.silent) recordMemory(world, { type: 'inventory.unequipped', payload: { entityId, itemId, slot } });
  if (options.playerId) recordPlayerJournal(world, options.playerId, {
    type: JOURNAL_TYPES.SYSTEM,
    title: `Unequipped ${item.name}`,
    summary: `${entity.name} removed ${item.name} from ${slot}.`,
    entityId,
    tags: ['inventory', 'equipment', slot],
    payload: { itemId: item.id, slot },
  });
  return { item: summarizeItem(world, item), slot };
}

function useItem(world, entityId, itemInstanceId, options = {}) {
  const entity = world.entities?.[entityId];
  if (!entity) throw new Error(`Missing entity ${entityId}`);
  const item = getOwnerItems(world, 'entity', entityId).find(entry => entry.id === itemInstanceId);
  if (!item) throw new Error(`Missing inventory item ${itemInstanceId}`);
  const definition = getItemDefinition(world, item.definitionId);
  if (!definition || definition.type !== 'consumable') throw new Error(`Item ${itemInstanceId} is not consumable`);
  const effects = item.effects || definition.effects || {};
  for (const [stat, amount] of Object.entries(effects)) {
    if (stat === 'health' && entity.stats.maxHealth !== undefined) {
      entity.stats.health = Math.min(Number(entity.stats.maxHealth || 100), Number(entity.stats.health || 0) + Number(amount || 0));
    } else if (stat === 'energy' && entity.stats.maxEnergy !== undefined) {
      entity.stats.energy = Math.min(Number(entity.stats.maxEnergy || 100), Number(entity.stats.energy || 0) + Number(amount || 0));
    } else {
      changeEntityStat(world, entityId, stat, Number(amount || 0));
    }
  }
  removeItem(world, item.id, 1);
  recordMemory(world, { type: 'inventory.used', payload: { entityId, itemId: item.id, definitionId: item.definitionId, effects } });
  if (options.playerId) recordPlayerJournal(world, options.playerId, {
    type: JOURNAL_TYPES.REWARD,
    title: `Used ${item.name}`,
    summary: `${entity.name} used ${item.name}.`,
    entityId,
    tags: ['inventory', 'consumable'],
    payload: { itemId: item.id, definitionId: item.definitionId, effects },
  });
  return { itemId: item.id, definitionId: item.definitionId, effects };
}

function grantStarterItems(world, entityId) {
  const granted = [];
  granted.push(grantItem(world, 'entity', entityId, 'wooden_sword', 1));
  granted.push(grantItem(world, 'entity', entityId, 'healing_pill', 2));
  return granted;
}

function getEntityEquipment(world, entityId) {
  const entity = world.entities?.[entityId];
  if (!entity) return {};
  ensureEquipmentMeta(entity);
  const out = {};
  for (const slot of EQUIPMENT_SLOTS) {
    const itemId = entity.meta.equipment[slot];
    out[slot] = itemId && world.items?.instances?.[itemId] ? summarizeItem(world, world.items.instances[itemId]) : null;
  }
  return out;
}

function getEquipmentStats(world, entityId) {
  const entity = world.entities?.[entityId];
  if (!entity) return {};
  ensureEquipmentMeta(entity);
  const totals = {};
  for (const itemId of Object.values(entity.meta.equipment)) {
    const item = world.items?.instances?.[itemId];
    if (!item) continue;
    for (const [stat, value] of Object.entries(item.stats || {})) totals[stat] = Number(totals[stat] || 0) + Number(value || 0);
  }
  return totals;
}

function formatInventory(inventory) {
  if (!inventory || !inventory.entityId) return 'No inventory.';
  const lines = [`Inventory: ${inventory.entityId}`];
  const equipped = Object.entries(inventory.equipment || {}).filter(([, item]) => item);
  if (equipped.length) {
    lines.push('Equipment:');
    for (const [slot, item] of equipped) lines.push(`- ${slot}: ${item.name} [${item.id}]`);
  } else {
    lines.push('Equipment: none');
  }
  lines.push('Items:');
  for (const item of inventory.items || []) {
    const mark = item.equipped ? ' equipped' : '';
    lines.push(`- ${item.id} ${item.name} x${item.quantity} ${item.type}/${item.rarity}${mark}`);
  }
  if (!inventory.items?.length) lines.push('- none');
  return lines.join('\n');
}

function summarizeItem(world, item) {
  const definition = getItemDefinition(world, item.definitionId) || {};
  return {
    id: item.id,
    definitionId: item.definitionId,
    name: item.name || definition.name,
    type: item.type || definition.type,
    rarity: item.rarity || definition.rarity,
    slot: item.slot || definition.slot || null,
    quantity: item.quantity,
    equipped: Boolean(item.equipped),
    price: Number(definition.price || 0),
    stats: { ...(item.stats || definition.stats || {}) },
    effects: { ...(item.effects || definition.effects || {}) },
    tags: [...(item.tags || definition.tags || [])],
  };
}

function ensureEquipmentMeta(entity) {
  if (!entity.meta) entity.meta = {};
  if (!entity.meta.equipment) entity.meta.equipment = {};
}

function findSlotByItemId(entity, itemId) {
  for (const [slot, id] of Object.entries(entity.meta?.equipment || {})) {
    if (id === itemId) return slot;
  }
  return null;
}

function applyItemStats(world, entityId, stats, direction) {
  for (const [stat, value] of Object.entries(stats || {})) changeEntityStat(world, entityId, stat, Number(value || 0) * direction);
}

module.exports = {
  EQUIPMENT_SLOTS,
  getEntityInventory,
  getPlayerInventory,
  equipItem,
  unequipItem,
  useItem,
  grantStarterItems,
  getEntityEquipment,
  getEquipmentStats,
  formatInventory,
  summarizeItem,
};
