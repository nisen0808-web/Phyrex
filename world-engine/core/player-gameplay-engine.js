'use strict';

const { createAccount, getAccount, createSession, linkPlayerToAccount, getAccountView } = require('./account-session-engine');
const { createPlayerWithCharacter, getPlayer, getActivePlayerCharacter } = require('./player-engine');
const { executePlayerCommand } = require('./command-engine');
const { startTutorial, processTutorialTick } = require('./tutorial-engine');
const { processQuestsTick, claimQuestReward, claimCompletedPlayerQuests, getQuest } = require('./quest-engine');
const { seedQuestBoard, acceptBoardQuest } = require('./quest-board-engine');
const { grantStarterItems, getPlayerInventory, equipItem, unequipItem, useItem } = require('./inventory-engine');
const { seedLocationShops, buyItem, sellItem } = require('./shop-engine');
const { queryWorld } = require('./query-engine');

function bootstrapLocalPlayer(world, input = {}) {
  const accountId = input.accountId || 'local_account';
  const playerId = input.playerId || 'local_player';
  const entityId = input.entityId || 'local_hero';
  const account = getAccount(world, accountId) || createAccount(world, {
    id: accountId,
    name: input.accountName || 'Local Account',
    roles: input.roles || ['player'],
  });

  let player = getPlayer(world, playerId);
  let entity = player ? getActivePlayerCharacter(world, playerId) : null;
  let created = false;

  if (!player) {
    const result = createPlayerWithCharacter(world, {
      player: { id: playerId, name: input.playerName || 'Local Player' },
      character: {
        id: entityId,
        name: input.entityName || 'Local Hero',
        species: input.species || 'human',
        locationId: input.locationId || 'qingyun_city',
        stats: { health: 90, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10, social: 50, ...(input.stats || {}) },
        resources: { currency: 100, food: 10, ...(input.resources || {}) },
        demographics: { age: 18, generation: 1, ...(input.demographics || {}) },
      },
    });
    player = result.player;
    entity = result.entity;
    created = true;
  }

  if (!account.playerIds.includes(player.id)) linkPlayerToAccount(world, account.id, player.id);
  if (created && entity) grantStarterItems(world, entity.id);
  startTutorial(world, player.id);
  if (entity?.locationId) {
    seedQuestBoard(world, entity.locationId);
    seedLocationShops(world, entity.locationId);
  }
  const session = createSession(world, account.id, { sessionTtlTicks: Number(input.sessionTtlTicks || 100000) });

  return {
    created,
    token: session.token,
    session: sanitizeSession(session),
    account: getAccountView(world, account.id),
    player: queryWorld(world, { type: 'player', playerId: player.id }),
    dashboard: getPlayerDashboard(world, player.id),
  };
}

function getPlayerDashboard(world, playerId) {
  processTutorialTick(world, { autoStart: true, claimCompleted: false });
  processQuestsTick(world);
  return {
    player: queryWorld(world, { type: 'player', playerId }),
    map: queryWorld(world, { type: 'map', playerId }),
    quests: queryWorld(world, { type: 'quests', playerId, options: { limit: 50 } }),
    tutorial: queryWorld(world, { type: 'tutorial', playerId }),
    inventory: queryWorld(world, { type: 'inventory', playerId }),
    shop: queryWorld(world, { type: 'shop', playerId }),
    board: queryWorld(world, { type: 'board', playerId }),
    journal: queryWorld(world, { type: 'journal', playerId, options: { limit: 20 } }),
    encounters: queryWorld(world, { type: 'encounters', playerId, options: { limit: 20 } }),
    offline: queryWorld(world, { type: 'offline', playerId, options: { limit: 50 } }),
  };
}

function movePlayer(world, playerId, locationId) {
  return executePlayerCommand(world, playerId, { type: 'move', locationId });
}

function acceptPlayerBoardQuest(world, playerId, boardItemId) {
  return acceptBoardQuest(world, playerId, boardItemId);
}

function claimPlayerQuest(world, playerId, questId) {
  const quest = getQuest(world, questId);
  if (!quest) throw new Error(`Missing quest ${questId}`);
  if (quest.playerId !== playerId) throw new Error(`Quest ${questId} does not belong to ${playerId}`);
  processQuestsTick(world);
  return claimQuestReward(world, questId);
}

function claimAllPlayerQuests(world, playerId) {
  processQuestsTick(world);
  return { claimed: claimCompletedPlayerQuests(world, playerId) };
}

function equipPlayerItem(world, playerId, itemRef) {
  const entity = requirePlayerEntity(world, playerId);
  const itemId = resolveInventoryItemId(world, playerId, itemRef);
  if (!itemId) throw new Error(`Missing inventory item ${itemRef}`);
  return equipItem(world, entity.id, itemId, { playerId });
}

function unequipPlayerItem(world, playerId, itemOrSlot) {
  const entity = requirePlayerEntity(world, playerId);
  const itemId = resolveInventoryItemId(world, playerId, itemOrSlot);
  return unequipItem(world, entity.id, itemId || itemOrSlot, { playerId });
}

function usePlayerItem(world, playerId, itemRef) {
  const entity = requirePlayerEntity(world, playerId);
  const itemId = resolveInventoryItemId(world, playerId, itemRef);
  if (!itemId) throw new Error(`Missing inventory item ${itemRef}`);
  return useItem(world, entity.id, itemId, { playerId });
}

function buyPlayerItem(world, playerId, input = {}) {
  return buyItem(world, playerId, input.shopId, input.itemDefinitionId || input.definitionId, Number(input.quantity || 1));
}

function sellPlayerItem(world, playerId, input = {}) {
  const itemId = resolveInventoryItemId(world, playerId, input.itemId || input.itemRef || input.definitionId);
  if (!itemId) throw new Error(`Missing inventory item ${input.itemId || input.itemRef || input.definitionId}`);
  return sellItem(world, playerId, itemId, Number(input.quantity || 1));
}

function resolveInventoryItemId(world, playerId, value) {
  const inventory = getPlayerInventory(world, playerId);
  const text = String(value || '').toLowerCase();
  return inventory.items.find(item => String(item.id).toLowerCase() === text)?.id
    || inventory.items.find(item => String(item.definitionId).toLowerCase() === text)?.id
    || inventory.items.find(item => String(item.name).toLowerCase() === text)?.id
    || null;
}

function requirePlayerEntity(world, playerId) {
  const entity = getActivePlayerCharacter(world, playerId);
  if (!entity) throw new Error(`Missing active character for ${playerId}`);
  return entity;
}

function sanitizeSession(session) {
  return {
    id: session.id,
    accountId: session.accountId,
    status: session.status,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

module.exports = {
  bootstrapLocalPlayer,
  getPlayerDashboard,
  movePlayer,
  acceptPlayerBoardQuest,
  claimPlayerQuest,
  claimAllPlayerQuests,
  equipPlayerItem,
  unequipPlayerItem,
  usePlayerItem,
  buyPlayerItem,
  sellPlayerItem,
  resolveInventoryItemId,
};
