'use strict';

const { executePlayerCommand } = require('./command-engine');
const { getActivePlayerCharacter } = require('./player-engine');
const { getQuest, claimQuestReward, processQuestsTick } = require('./quest-engine');
const { acceptBoardQuest } = require('./quest-board-engine');
const { equipItem, unequipItem, useItem } = require('./inventory-engine');
const { buyItem, sellItem } = require('./shop-engine');

const CLIENT_ACTIONS = {
  MOVE: 'move',
  ACCEPT_BOARD_QUEST: 'accept_board_quest',
  CLAIM_QUEST: 'claim_quest',
  EQUIP_ITEM: 'equip_item',
  UNEQUIP_ITEM: 'unequip_item',
  USE_ITEM: 'use_item',
  BUY_ITEM: 'buy_item',
  SELL_ITEM: 'sell_item',
};

function executeClientAction(world, playerId, input = {}) {
  if (!playerId) throw new Error('Client action requires playerId');
  if (!input.action) throw new Error('Client action requires action');

  const action = input.action;
  if (action === CLIENT_ACTIONS.MOVE) {
    const locationId = required(input, 'locationId');
    return wrap(action, executePlayerCommand(world, playerId, { type: 'move', locationId }));
  }

  if (action === CLIENT_ACTIONS.ACCEPT_BOARD_QUEST) {
    const boardItemId = required(input, 'boardItemId');
    return wrap(action, acceptBoardQuest(world, playerId, boardItemId));
  }

  if (action === CLIENT_ACTIONS.CLAIM_QUEST) {
    const questId = required(input, 'questId');
    const quest = getQuest(world, questId);
    if (!quest) throw new Error(`Missing quest ${questId}`);
    if (quest.playerId !== playerId) throw forbidden(`Quest ${questId} does not belong to ${playerId}`);
    processQuestsTick(world);
    return wrap(action, claimQuestReward(world, questId));
  }

  const entity = getActivePlayerCharacter(world, playerId);
  if (!entity) throw new Error(`Missing active character for ${playerId}`);

  if (action === CLIENT_ACTIONS.EQUIP_ITEM) {
    return wrap(action, equipItem(world, entity.id, required(input, 'itemId'), { playerId }));
  }
  if (action === CLIENT_ACTIONS.UNEQUIP_ITEM) {
    return wrap(action, unequipItem(world, entity.id, required(input, 'slotOrItemId'), { playerId }));
  }
  if (action === CLIENT_ACTIONS.USE_ITEM) {
    return wrap(action, useItem(world, entity.id, required(input, 'itemId'), { playerId }));
  }
  if (action === CLIENT_ACTIONS.BUY_ITEM) {
    return wrap(action, buyItem(world, playerId, required(input, 'shopId'), required(input, 'itemDefinitionId'), positiveInt(input.quantity, 1)));
  }
  if (action === CLIENT_ACTIONS.SELL_ITEM) {
    return wrap(action, sellItem(world, playerId, required(input, 'itemId'), positiveInt(input.quantity, 1)));
  }

  throw new Error(`Unknown client action ${action}`);
}

function wrap(action, result) {
  return { action, result };
}

function required(input, key) {
  const value = input[key];
  if (value === undefined || value === null || value === '') throw new Error(`Client action requires ${key}`);
  return value;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.floor(number));
}

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

module.exports = {
  CLIENT_ACTIONS,
  executeClientAction,
};
