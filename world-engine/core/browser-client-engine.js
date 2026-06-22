'use strict';

const { queryWorld } = require('./query-engine');
const { executePlayerCommand } = require('./command-engine');
const {
  getActivePlayerCharacter,
  createPlayerCharacter,
  switchPlayerCharacter,
  setPlayerObserverMode,
} = require('./player-engine');
const { getAccountByPlayer, getAccountView } = require('./account-session-engine');
const { processQuestsTick, getQuest, claimQuestReward, claimCompletedPlayerQuests } = require('./quest-engine');
const { startTutorial } = require('./tutorial-engine');
const { acceptBoardQuest } = require('./quest-board-engine');
const { exploreLocation } = require('./encounter-engine');
const { getPlayerInventory, equipItem, unequipItem, useItem } = require('./inventory-engine');
const { grantItem } = require('./item-engine');
const { buyItem, sellItem } = require('./shop-engine');
const { cancelOfflineCommand } = require('./offline-command-engine');

const BROWSER_ACTION_TYPES = {
  START_ADVENTURE: 'start_adventure',
  COMMAND: 'command',
  MOVE: 'move',
  EXPLORE: 'explore',
  ACCEPT_BOARD_QUEST: 'accept_board_quest',
  CLAIM_QUEST: 'claim_quest',
  CLAIM_ALL_QUESTS: 'claim_all_quests',
  EQUIP_ITEM: 'equip_item',
  UNEQUIP_ITEM: 'unequip_item',
  USE_ITEM: 'use_item',
  BUY_ITEM: 'buy_item',
  SELL_ITEM: 'sell_item',
  CANCEL_OFFLINE: 'cancel_offline',
  CREATE_CHARACTER: 'create_character',
  SWITCH_CHARACTER: 'switch_character',
  OBSERVER_MODE: 'observer_mode',
};

function getPlayerDashboard(world, playerId, options = {}) {
  const limit = Number(options.limit || 20);
  const account = getAccountByPlayer(world, playerId);
  return {
    playerId,
    tick: world.tick,
    account: account ? getAccountView(world, account.id) : null,
    player: queryWorld(world, { type: 'player', playerId }),
    map: queryWorld(world, { type: 'map', playerId }),
    quests: queryWorld(world, { type: 'quests', playerId, options: { limit } }),
    inventory: queryWorld(world, { type: 'inventory', playerId }),
    shop: queryWorld(world, { type: 'shop', playerId }),
    board: queryWorld(world, { type: 'board', playerId }),
    journal: queryWorld(world, { type: 'journal', playerId, options: { limit } }),
    encounters: queryWorld(world, { type: 'encounters', playerId, options: { limit } }),
    offline: queryWorld(world, { type: 'offline', playerId, options: { limit } }),
  };
}

function executeBrowserAction(world, playerId, input = {}) {
  const type = input.type;
  if (!type) throw new Error('Browser action requires type');

  let result;
  if (type === BROWSER_ACTION_TYPES.START_ADVENTURE) {
    const entity = requireActiveEntity(world, playerId);
    const inventory = getPlayerInventory(world, playerId);
    const owned = new Set((inventory.items || []).map(item => item.definitionId));
    const granted = [];
    if (!owned.has('wooden_sword')) granted.push(grantItem(world, 'entity', entity.id, 'wooden_sword', 1));
    if (!owned.has('healing_pill')) granted.push(grantItem(world, 'entity', entity.id, 'healing_pill', 2));
    const tutorial = startTutorial(world, playerId);
    result = {
      entityId: entity.id,
      grantedItemIds: granted.map(item => item.id),
      tutorial: tutorial.tutorial,
      createdQuestIds: tutorial.created.map(quest => quest.id),
    };
  } else if (type === BROWSER_ACTION_TYPES.COMMAND) {
    if (!input.command?.type) throw new Error('Browser command action requires command.type');
    result = executePlayerCommand(world, playerId, input.command, input.options || {});
  } else if (type === BROWSER_ACTION_TYPES.MOVE) {
    result = executePlayerCommand(world, playerId, { type: 'move', locationId: required(input, 'locationId') }, input.options || {});
  } else if (type === BROWSER_ACTION_TYPES.EXPLORE) {
    result = exploreLocation(world, playerId, input.options || {});
  } else if (type === BROWSER_ACTION_TYPES.ACCEPT_BOARD_QUEST) {
    result = acceptBoardQuest(world, playerId, required(input, 'boardItemId'));
  } else if (type === BROWSER_ACTION_TYPES.CLAIM_QUEST) {
    processQuestsTick(world);
    const questId = required(input, 'questId');
    const quest = getQuest(world, questId);
    if (!quest) throw new Error(`Missing quest ${questId}`);
    if (quest.playerId !== playerId) throw new Error(`Quest ${questId} does not belong to player ${playerId}`);
    result = claimQuestReward(world, questId);
  } else if (type === BROWSER_ACTION_TYPES.CLAIM_ALL_QUESTS) {
    processQuestsTick(world);
    result = { claimed: claimCompletedPlayerQuests(world, playerId) };
  } else if (type === BROWSER_ACTION_TYPES.EQUIP_ITEM) {
    const entity = requireActiveEntity(world, playerId);
    result = equipItem(world, entity.id, required(input, 'itemId'), { playerId });
  } else if (type === BROWSER_ACTION_TYPES.UNEQUIP_ITEM) {
    const entity = requireActiveEntity(world, playerId);
    result = unequipItem(world, entity.id, input.slotOrItemId || input.itemId || required(input, 'slot'), { playerId });
  } else if (type === BROWSER_ACTION_TYPES.USE_ITEM) {
    const entity = requireActiveEntity(world, playerId);
    result = useItem(world, entity.id, required(input, 'itemId'), { playerId });
  } else if (type === BROWSER_ACTION_TYPES.BUY_ITEM) {
    result = buyItem(world, playerId, required(input, 'shopId'), required(input, 'itemDefinitionId'), Number(input.quantity || 1));
  } else if (type === BROWSER_ACTION_TYPES.SELL_ITEM) {
    result = sellItem(world, playerId, required(input, 'itemId'), Number(input.quantity || 1));
  } else if (type === BROWSER_ACTION_TYPES.CANCEL_OFFLINE) {
    const offlineCommandId = required(input, 'offlineCommandId');
    const command = world.offlineCommands?.byId?.[offlineCommandId];
    if (!command) throw new Error(`Missing offline command ${offlineCommandId}`);
    if (command.playerId !== playerId) throw new Error(`Offline command ${offlineCommandId} does not belong to player ${playerId}`);
    result = cancelOfflineCommand(world, offlineCommandId, input.reason || 'cancelled_by_player');
  } else if (type === BROWSER_ACTION_TYPES.CREATE_CHARACTER) {
    const character = { ...(input.character || {}) };
    if (!character.id && input.entityId) character.id = input.entityId;
    if (!character.name && input.name) character.name = input.name;
    if (!character.locationId && input.locationId) character.locationId = input.locationId;
    if (!character.species && input.species) character.species = input.species;
    if (input.active !== undefined) character.active = input.active;
    const entity = createPlayerCharacter(world, playerId, character, input.options || {});
    result = {
      entityId: entity.id,
      name: entity.name,
      locationId: entity.locationId,
      active: world.players?.byId?.[playerId]?.activeEntityId === entity.id,
    };
  } else if (type === BROWSER_ACTION_TYPES.SWITCH_CHARACTER) {
    const entityId = required(input, 'entityId');
    const player = switchPlayerCharacter(world, playerId, entityId);
    result = {
      entityId,
      activeEntityId: player.activeEntityId,
      controlMode: player.controlMode,
      status: player.status,
    };
  } else if (type === BROWSER_ACTION_TYPES.OBSERVER_MODE) {
    const player = setPlayerObserverMode(world, playerId, input.locationId || null);
    result = {
      controlMode: player.controlMode,
      observerLocationId: player.observerLocationId,
      status: player.status,
    };
  } else {
    throw new Error(`Unknown browser action ${type}`);
  }

  processQuestsTick(world);

  return {
    type,
    playerId,
    tick: world.tick,
    result,
    dashboard: input.includeDashboard === false ? null : getPlayerDashboard(world, playerId, input.dashboardOptions || {}),
  };
}

function requireActiveEntity(world, playerId) {
  const entity = getActivePlayerCharacter(world, playerId);
  if (!entity) throw new Error(`Missing active character for ${playerId}`);
  return entity;
}

function required(input, key) {
  if (input[key] === undefined || input[key] === null || input[key] === '') throw new Error(`Browser action requires ${key}`);
  return input[key];
}

module.exports = {
  BROWSER_ACTION_TYPES,
  getPlayerDashboard,
  executeBrowserAction,
};
