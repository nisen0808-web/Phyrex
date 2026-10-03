'use strict';

const { getActivePlayerCharacter } = require('./player-engine');
const { getOwnerItems, getItemDefinition, grantItem, getItemStats } = require('./item-engine');

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
  const value = require('./inventory-operations-engine').performInventoryOperation(world, world.entities?.[entityId], 'equip_item', { itemId: itemInstanceId });
  return { ...value, item: summarizeItem(world, world.items.instances[itemInstanceId]) };
}
function unequipItem(world, entityId, slotOrItemId, options = {}) {
  const entity = world.entities?.[entityId];
  if (!entity) throw new Error('Missing entity');
  const slot = EQUIPMENT_SLOTS.includes(slotOrItemId) ? slotOrItemId : findSlotByItemId(entity, slotOrItemId);
  if (!slot || !entity.meta?.equipment?.[slot]) return null;
  const value = require('./inventory-operations-engine').performInventoryOperation(world, entity, 'unequip_item', { slot });
  return { ...value, item: summarizeItem(world, world.items.instances[value.itemId]) };
}
function useItem(world, entityId, itemInstanceId, options = {}) {
  return require('./inventory-operations-engine').performInventoryOperation(world, world.entities?.[entityId], 'use_item', { itemId: itemInstanceId });
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
    for (const [stat, value] of Object.entries(item.equipmentApplied || item.stats || {})) totals[stat] = Number(totals[stat] || 0) + Number(value || 0);
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
