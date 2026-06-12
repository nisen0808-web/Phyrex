'use strict';

const { assignQuestToPlayer, getPlayerQuests } = require('./quest-engine');
const { getPlayerView } = require('./player-engine');
const { recordPlayerJournal, JOURNAL_TYPES } = require('./player-journal-engine');

const BOARD_ITEM_STATUS = {
  OPEN: 'open',
  ACCEPTED: 'accepted',
  CLOSED: 'closed',
};

const BOARD_ITEM_TYPES = {
  GATHER: 'gather',
  TRAIN: 'train',
  EXPLORE: 'explore',
  WORK: 'work',
};

const DEFAULT_BOARD_OPTIONS = {
  maxItemsPerLocation: 20,
};

function ensureQuestBoardState(world) {
  if (!world.questBoards) {
    world.questBoards = {
      byLocation: {},
      byId: {},
      stats: {
        generated: 0,
        accepted: 0,
        closed: 0,
      },
    };
  }
  return world.questBoards;
}

function seedQuestBoard(world, locationId, options = {}) {
  const state = ensureQuestBoardState(world);
  const location = world.locations?.[locationId];
  if (!location) return [];
  if (!state.byLocation[locationId]) state.byLocation[locationId] = [];
  const created = [];
  const templates = createBoardTemplates(world, locationId, options);
  for (const template of templates) {
    if (state.byId[template.id]) continue;
    const item = createBoardItem(world, locationId, template);
    created.push(item);
  }
  trimBoard(world, locationId, options.maxItemsPerLocation || DEFAULT_BOARD_OPTIONS.maxItemsPerLocation);
  return created;
}

function createBoardItem(world, locationId, input = {}) {
  const state = ensureQuestBoardState(world);
  const item = {
    id: input.id || `board_${locationId}_${input.type}_${world.tick}_${Math.random().toString(16).slice(2)}`,
    locationId,
    type: input.type || BOARD_ITEM_TYPES.WORK,
    status: input.status || BOARD_ITEM_STATUS.OPEN,
    title: input.title || input.type || 'commission',
    summary: input.summary || '',
    quest: { ...(input.quest || {}) },
    rewards: { resources: { ...(input.rewards?.resources || {}) }, stats: { ...(input.rewards?.stats || {}) } },
    createdAt: world.tick,
    acceptedBy: null,
    acceptedAt: null,
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    payload: { ...(input.payload || {}) },
  };
  state.byId[item.id] = item;
  if (!state.byLocation[locationId]) state.byLocation[locationId] = [];
  if (!state.byLocation[locationId].includes(item.id)) state.byLocation[locationId].push(item.id);
  state.stats.generated += 1;
  return item;
}

function getLocationQuestBoard(world, locationId, filters = {}) {
  const state = ensureQuestBoardState(world);
  seedQuestBoard(world, locationId, filters);
  return (state.byLocation[locationId] || [])
    .map(id => state.byId[id])
    .filter(Boolean)
    .filter(item => !filters.status || item.status === filters.status)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

function getPlayerQuestBoard(world, playerId, filters = {}) {
  const view = getPlayerView(world, playerId);
  const locationId = filters.locationId || view?.activeEntity?.locationId || view?.observerLocation?.id || null;
  if (!locationId) return { playerId, locationId: null, items: [] };
  return {
    playerId,
    locationId,
    locationName: world.locations?.[locationId]?.name || locationId,
    items: getLocationQuestBoard(world, locationId, { ...filters, status: filters.status || BOARD_ITEM_STATUS.OPEN }),
  };
}

function acceptBoardQuest(world, playerId, boardItemId) {
  const state = ensureQuestBoardState(world);
  const item = state.byId[boardItemId];
  if (!item) throw new Error(`Missing board item ${boardItemId}`);
  if (item.status !== BOARD_ITEM_STATUS.OPEN) return { item, quest: getExistingBoardQuest(world, playerId, item) };

  const questInput = boardItemToQuest(world, playerId, item);
  const quest = assignQuestToPlayer(world, playerId, questInput);
  item.status = BOARD_ITEM_STATUS.ACCEPTED;
  item.acceptedBy = playerId;
  item.acceptedAt = world.tick;
  state.stats.accepted += 1;
  recordPlayerJournal(world, playerId, {
    type: JOURNAL_TYPES.QUEST,
    title: `Accepted: ${item.title}`,
    summary: item.summary || `Accepted commission ${item.title}.`,
    locationId: item.locationId,
    tags: ['board', 'quest', item.type],
    payload: { boardItemId: item.id, questId: quest.id },
  });
  return { item, quest };
}

function getQuestBoardStats(world) {
  const state = ensureQuestBoardState(world);
  const items = Object.values(state.byId || {});
  return {
    total: items.length,
    open: items.filter(item => item.status === BOARD_ITEM_STATUS.OPEN).length,
    accepted: items.filter(item => item.status === BOARD_ITEM_STATUS.ACCEPTED).length,
    closed: items.filter(item => item.status === BOARD_ITEM_STATUS.CLOSED).length,
    byType: countBy(items.map(item => item.type)),
    stats: { ...state.stats },
  };
}

function formatQuestBoard(board) {
  const items = board?.items || [];
  if (!items.length) return `No open commissions at ${board?.locationName || board?.locationId || 'this location'}.`;
  const lines = [`Quest Board: ${board.locationName || board.locationId}`];
  for (const item of items) {
    const reward = formatRewards(item.rewards);
    lines.push(`- ${item.id}\n  ${item.title} [${item.type}]\n  ${item.summary || 'No summary'}\n  Rewards: ${reward}`);
  }
  return lines.join('\n');
}

function createBoardTemplates(world, locationId) {
  const location = world.locations?.[locationId] || { resources: {} };
  const resources = Object.entries(location.resources || {}).filter(([, value]) => Number(value || 0) > 0).map(([key]) => key);
  const primary = resources.includes('wood') ? 'wood' : resources.includes('food') ? 'food' : resources[0] || 'food';
  return [
    {
      id: `board_${locationId}_gather_${primary}`,
      type: BOARD_ITEM_TYPES.GATHER,
      title: `Gather ${primary}`,
      summary: `Bring back 5 ${primary} from ${location.name || locationId}.`,
      quest: {
        objectives: [{ type: 'have_resource', resource: primary, amount: 5, target: 1, title: `Have 5 ${primary}` }],
      },
      rewards: { resources: { currency: 30 } },
      tags: ['board', 'gather', primary],
    },
    {
      id: `board_${locationId}_explore`,
      type: BOARD_ITEM_TYPES.EXPLORE,
      title: `Explore ${location.name || locationId}`,
      summary: `Explore the area and report what you find.`,
      quest: {
        objectives: [{ type: 'have_resource', resource: 'exploration', amount: 1, target: 1, title: 'Gain 1 exploration' }],
      },
      rewards: { resources: { currency: 20, knowledge: 1 } },
      tags: ['board', 'explore'],
    },
    {
      id: `board_${locationId}_train`,
      type: BOARD_ITEM_TYPES.TRAIN,
      title: 'Basic training commission',
      summary: 'Complete a short training session.',
      quest: {
        objectives: [{ type: 'command', commandType: 'train', target: 1, title: 'Use train once' }],
      },
      rewards: { resources: { currency: 15 }, stats: { power: 1 } },
      tags: ['board', 'train'],
    },
  ];
}

function boardItemToQuest(world, playerId, item) {
  return {
    id: `${playerId}_${item.id}`,
    title: item.title,
    description: item.summary || item.title,
    objectives: item.quest.objectives || [],
    rewards: item.rewards,
    tags: ['board', item.type, ...(item.tags || [])],
    payload: { boardItemId: item.id, locationId: item.locationId },
  };
}

function getExistingBoardQuest(world, playerId, item) {
  return getPlayerQuests(world, playerId).find(quest => quest.payload?.boardItemId === item.id) || null;
}

function trimBoard(world, locationId, limit) {
  const state = ensureQuestBoardState(world);
  const ids = state.byLocation[locationId] || [];
  if (ids.length <= limit) return [];
  const keep = ids.slice(-limit);
  const removed = ids.slice(0, ids.length - limit);
  state.byLocation[locationId] = keep;
  for (const id of removed) {
    if (state.byId[id]?.status !== BOARD_ITEM_STATUS.ACCEPTED) {
      delete state.byId[id];
      state.stats.closed += 1;
    }
  }
  return removed;
}

function formatRewards(rewards = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(rewards.resources || {})) parts.push(`${key}+${value}`);
  for (const [key, value] of Object.entries(rewards.stats || {})) parts.push(`${key}+${value}`);
  return parts.join(', ') || 'none';
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
  BOARD_ITEM_STATUS,
  BOARD_ITEM_TYPES,
  DEFAULT_BOARD_OPTIONS,
  ensureQuestBoardState,
  seedQuestBoard,
  createBoardItem,
  getLocationQuestBoard,
  getPlayerQuestBoard,
  acceptBoardQuest,
  getQuestBoardStats,
  formatQuestBoard,
};
