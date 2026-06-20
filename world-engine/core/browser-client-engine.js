'use strict';

const { queryWorld } = require('./query-engine');
const { executePlayerCommand } = require('./command-engine');
const { getActivePlayerCharacter } = require('./player-engine');
const { processQuestsTick, getQuest, claimQuestReward, claimCompletedPlayerQuests } = require('./quest-engine');
const { acceptBoardQuest } = require('./quest-board-engine');
const { exploreLocation } = require('./encounter-engine');
const { equipItem, unequipItem, useItem } = require('./inventory-engine');
const { buyItem, sellItem } = require('./shop-engine');

const BROWSER_ACTION_TYPES = {
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
};

function getPlayerDashboard(world, playerId, options = {}) {
  const limit = Number(options.limit || 20);
  return {
    playerId,
    tick: world.tick,
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
  if (type === BROWSER_ACTION_TYPES.COMMAND) {
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
  } else {
    throw new Error(`Unknown browser action ${type}`);
  }

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
