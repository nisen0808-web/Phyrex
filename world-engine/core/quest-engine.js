'use strict';

const { recordMemory } = require('./world-engine');
const { getPlayer, getActivePlayerCharacter } = require('./player-engine');
const { getPlayerCommands } = require('./command-engine');

const QUEST_STATUS = {
  ACTIVE: 'active',
  COMPLETED: 'completed',
  CLAIMED: 'claimed',
  FAILED: 'failed',
};

const QUEST_OBJECTIVE_TYPES = {
  COMMAND: 'command',
  LOCATION: 'location',
  HAVE_RESOURCE: 'have_resource',
  JOIN_ORGANIZATION: 'join_organization',
  WORLD_TICK: 'world_tick',
};

const DEFAULT_QUEST_OPTIONS = {
  maxQuestLog: 500,
};

const TUTORIAL_QUESTS = [
  {
    id: 'tutorial_status',
    title: 'Know Yourself',
    description: 'Check your character status.',
    objectives: [{ type: QUEST_OBJECTIVE_TYPES.COMMAND, commandType: 'inspect', target: 1 }],
    rewards: { resources: { currency: 10 } },
    tags: ['tutorial'],
  },
  {
    id: 'tutorial_work',
    title: 'Earn Your First Coin',
    description: 'Use work to earn currency.',
    objectives: [{ type: QUEST_OBJECTIVE_TYPES.COMMAND, commandType: 'work', target: 1 }],
    rewards: { resources: { currency: 25 } },
    tags: ['tutorial'],
  },
  {
    id: 'tutorial_travel',
    title: 'Leave Town',
    description: 'Travel to Mist Forest.',
    objectives: [{ type: QUEST_OBJECTIVE_TYPES.LOCATION, locationId: 'mist_forest', target: 1 }],
    rewards: { resources: { food: 5 } },
    tags: ['tutorial'],
  },
  {
    id: 'tutorial_gather',
    title: 'Gather From the World',
    description: 'Gather at least 5 wood.',
    objectives: [{ type: QUEST_OBJECTIVE_TYPES.HAVE_RESOURCE, resource: 'wood', amount: 5, target: 1 }],
    rewards: { resources: { currency: 20 } },
    tags: ['tutorial'],
  },
  {
    id: 'tutorial_train',
    title: 'Begin Training',
    description: 'Use train at least once.',
    objectives: [{ type: QUEST_OBJECTIVE_TYPES.COMMAND, commandType: 'train', target: 1 }],
    rewards: { stats: { power: 1 }, resources: { currency: 30 } },
    tags: ['tutorial'],
  },
  {
    id: 'tutorial_join',
    title: 'Join a Power',
    description: 'Join Qingyun Sect or any organization.',
    objectives: [{ type: QUEST_OBJECTIVE_TYPES.JOIN_ORGANIZATION, organizationName: 'Qingyun Sect', target: 1 }],
    rewards: { resources: { currency: 50 }, stats: { social: 1 } },
    tags: ['tutorial'],
  },
];

function ensureQuestState(world) {
  if (!world.quests) {
    world.quests = {
      byId: {},
      byPlayer: {},
      log: [],
      stats: { created: 0, completed: 0, claimed: 0, failed: 0 },
    };
  }
  return world.quests;
}

function createQuest(world, input = {}) {
  if (!input.playerId) throw new Error('Quest requires playerId');
  if (!input.title) throw new Error('Quest requires title');
  const state = ensureQuestState(world);
  const id = input.id || `quest_${world.tick}_${input.playerId}_${Math.random().toString(16).slice(2)}`;
  if (state.byId[id]) return state.byId[id];

  const quest = {
    id,
    playerId: input.playerId,
    entityId: input.entityId || null,
    title: input.title,
    description: input.description || input.title,
    status: input.status || QUEST_STATUS.ACTIVE,
    createdAt: input.createdAt ?? world.tick,
    updatedAt: input.updatedAt ?? world.tick,
    completedAt: input.completedAt || null,
    claimedAt: input.claimedAt || null,
    objectives: normalizeObjectives(input.objectives || []),
    rewards: { ...(input.rewards || {}) },
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    payload: { ...(input.payload || {}) },
  };

  state.byId[id] = quest;
  if (!state.byPlayer[quest.playerId]) state.byPlayer[quest.playerId] = [];
  state.byPlayer[quest.playerId].push(id);
  state.log.push(id);
  state.stats.created += 1;
  trimQuestLog(world, DEFAULT_QUEST_OPTIONS.maxQuestLog);
  recordQuestMemory(world, quest, 'quest.created', {});
  return quest;
}

function assignQuestToPlayer(world, playerId, questInput = {}) {
  const player = getPlayer(world, playerId);
  if (!player) throw new Error(`Missing player ${playerId}`);
  const active = getActivePlayerCharacter(world, playerId);
  return createQuest(world, { ...questInput, playerId, entityId: questInput.entityId || active?.id || null });
}

function seedTutorialQuests(world, playerId) {
  ensureQuestState(world);
  const created = [];
  for (const template of TUTORIAL_QUESTS) {
    const id = `${playerId}_${template.id}`;
    if (world.quests.byId[id]) continue;
    created.push(assignQuestToPlayer(world, playerId, { ...template, id }));
  }
  return created;
}

function processQuestsTick(world, options = {}) {
  ensureQuestState(world);
  const config = { ...DEFAULT_QUEST_OPTIONS, ...(options || {}) };
  const updated = [];
  const completed = [];

  for (const quest of Object.values(world.quests.byId)) {
    if (quest.status !== QUEST_STATUS.ACTIVE) continue;
    const before = questProgress(quest);
    updateQuestProgress(world, quest.id);
    const after = questProgress(quest);
    if (after !== before) updated.push(quest.id);
    if (isQuestComplete(quest)) {
      quest.status = QUEST_STATUS.COMPLETED;
      quest.completedAt = world.tick;
      quest.updatedAt = world.tick;
      completed.push(quest.id);
      world.quests.stats.completed += 1;
      recordQuestMemory(world, quest, 'quest.completed', {});
    }
  }

  trimQuestLog(world, config.maxQuestLog);
  return { updated, completed, stats: getQuestStats(world) };
}

function updateQuestProgress(world, questId) {
  const quest = getQuest(world, questId);
  if (!quest) return null;
  for (const objective of quest.objectives) {
    objective.progress = evaluateObjective(world, quest, objective);
    objective.done = objective.progress >= objective.target;
  }
  quest.updatedAt = world.tick;
  return quest;
}

function claimQuestReward(world, questId) {
  const quest = getQuest(world, questId);
  if (!quest) return null;
  if (quest.status !== QUEST_STATUS.COMPLETED) return quest;
  const entity = getActivePlayerCharacter(world, quest.playerId);
  if (entity) {
    for (const [resource, amount] of Object.entries(quest.rewards.resources || {})) {
      entity.resources[resource] = Number(entity.resources[resource] || 0) + Number(amount || 0);
    }
    for (const [stat, amount] of Object.entries(quest.rewards.stats || {})) {
      entity.stats[stat] = Number(entity.stats[stat] || 0) + Number(amount || 0);
    }
  }
  quest.status = QUEST_STATUS.CLAIMED;
  quest.claimedAt = world.tick;
  quest.updatedAt = world.tick;
  ensureQuestState(world).stats.claimed += 1;
  recordQuestMemory(world, quest, 'quest.claimed', { rewards: quest.rewards });
  return quest;
}

function claimCompletedPlayerQuests(world, playerId) {
  const claimed = [];
  for (const quest of getPlayerQuests(world, playerId, { status: QUEST_STATUS.COMPLETED })) {
    const result = claimQuestReward(world, quest.id);
    if (result?.status === QUEST_STATUS.CLAIMED) claimed.push(result.id);
  }
  return claimed;
}

function getQuest(world, questId) {
  return ensureQuestState(world).byId[questId] || null;
}

function getPlayerQuests(world, playerId, filters = {}) {
  const state = ensureQuestState(world);
  return (state.byPlayer[playerId] || [])
    .map(id => state.byId[id])
    .filter(Boolean)
    .filter(quest => !filters.status || quest.status === filters.status)
    .filter(quest => !filters.tag || quest.tags.includes(filters.tag));
}

function getQuestStats(world) {
  const state = ensureQuestState(world);
  const quests = Object.values(state.byId || {});
  return {
    total: quests.length,
    active: quests.filter(q => q.status === QUEST_STATUS.ACTIVE).length,
    completed: quests.filter(q => q.status === QUEST_STATUS.COMPLETED).length,
    claimed: quests.filter(q => q.status === QUEST_STATUS.CLAIMED).length,
    failed: quests.filter(q => q.status === QUEST_STATUS.FAILED).length,
    stats: { ...state.stats },
  };
}

function evaluateObjective(world, quest, objective) {
  const entity = getActivePlayerCharacter(world, quest.playerId);
  if (objective.type === QUEST_OBJECTIVE_TYPES.COMMAND) {
    return countPlayerCommands(world, quest.playerId, objective.commandType);
  }
  if (objective.type === QUEST_OBJECTIVE_TYPES.LOCATION) {
    return entity?.locationId === objective.locationId ? objective.target : 0;
  }
  if (objective.type === QUEST_OBJECTIVE_TYPES.HAVE_RESOURCE) {
    return Number(entity?.resources?.[objective.resource] || 0) >= Number(objective.amount || 1) ? objective.target : 0;
  }
  if (objective.type === QUEST_OBJECTIVE_TYPES.JOIN_ORGANIZATION) {
    return hasJoinedOrganization(world, entity, objective) ? objective.target : 0;
  }
  if (objective.type === QUEST_OBJECTIVE_TYPES.WORLD_TICK) {
    return Math.max(0, world.tick - Number(quest.createdAt || 0));
  }
  return 0;
}

function countPlayerCommands(world, playerId, commandType) {
  return getPlayerCommands(world, playerId, 500).filter(command => command.type === commandType && ['accepted', 'completed'].includes(command.status)).length;
}

function hasJoinedOrganization(world, entity, objective) {
  if (!entity) return false;
  const ids = entity.organizationIds || [];
  if (objective.organizationId && ids.includes(objective.organizationId)) return true;
  if (!objective.organizationName) return ids.length > 0;
  return ids.some(id => String(world.organizations?.byId?.[id]?.name || '').toLowerCase() === String(objective.organizationName).toLowerCase());
}

function isQuestComplete(quest) {
  return quest.objectives.length > 0 && quest.objectives.every(objective => objective.done === true || objective.progress >= objective.target);
}

function questProgress(quest) {
  if (!quest.objectives.length) return 0;
  const progress = quest.objectives.reduce((sum, objective) => sum + Math.min(1, Number(objective.progress || 0) / Math.max(1, Number(objective.target || 1))), 0);
  return Math.round((progress / quest.objectives.length) * 100);
}

function normalizeObjectives(objectives) {
  return objectives.map((objective, index) => ({
    id: objective.id || `objective_${index + 1}`,
    type: objective.type,
    title: objective.title || objective.type,
    target: Number(objective.target || 1),
    progress: Number(objective.progress || 0),
    done: Boolean(objective.done),
    ...objective,
  }));
}

function recordQuestMemory(world, quest, type, payload = {}) {
  recordMemory(world, { type, payload: { questId: quest.id, playerId: quest.playerId, title: quest.title, ...payload } });
}

function trimQuestLog(world, limit) {
  const state = ensureQuestState(world);
  while (state.log.length > limit) {
    const removed = state.log.shift();
    const quest = state.byId[removed];
    if (quest && [QUEST_STATUS.CLAIMED, QUEST_STATUS.FAILED].includes(quest.status)) delete state.byId[removed];
  }
  for (const playerId of Object.keys(state.byPlayer)) {
    state.byPlayer[playerId] = state.byPlayer[playerId].filter(id => state.byId[id]);
  }
}

module.exports = {
  QUEST_STATUS,
  QUEST_OBJECTIVE_TYPES,
  DEFAULT_QUEST_OPTIONS,
  TUTORIAL_QUESTS,
  ensureQuestState,
  createQuest,
  assignQuestToPlayer,
  seedTutorialQuests,
  processQuestsTick,
  updateQuestProgress,
  claimQuestReward,
  claimCompletedPlayerQuests,
  getQuest,
  getPlayerQuests,
  getQuestStats,
};
