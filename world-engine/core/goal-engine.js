'use strict';

const { clamp } = require('./schema');
const { nextWorldId } = require('./world-id-engine');

const GOAL_STATUS = {
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABANDONED: 'abandoned',
};

const GOAL_SCOPE = {
  NEED: 'need',
  GOAL: 'goal',
  DREAM: 'dream',
};

const DEFAULT_GOAL_TEMPLATES = {
  survive: {
    scope: GOAL_SCOPE.NEED,
    title: 'survive',
    priority: 100,
    actionTypes: ['rest', 'move', 'gather', 'work'],
    completion: entity => entity.status === 'alive',
  },
  recover: {
    scope: GOAL_SCOPE.NEED,
    title: 'recover',
    priority: 85,
    actionTypes: ['rest'],
    completion: entity => entity.stats.health >= entity.stats.maxHealth * 0.8,
  },
  seek_shelter: {
    scope: GOAL_SCOPE.NEED,
    title: 'seek_shelter',
    priority: 90,
    actionTypes: ['move', 'rest'],
    completion: (entity, goal) => entity.locationId === goal.payload.targetLocationId,
  },
  migrate: {
    scope: GOAL_SCOPE.GOAL,
    title: 'migrate',
    priority: 75,
    actionTypes: ['move'],
    completion: (entity, goal) => entity.locationId === goal.payload.targetLocationId,
  },
  stockpile_resource: {
    scope: GOAL_SCOPE.GOAL,
    title: 'stockpile_resource',
    priority: 72,
    actionTypes: ['gather', 'work'],
    completion: (entity, goal) => Number(entity.resources[goal.payload.resource || 'food'] || 0) >= Number(goal.payload.amount || 10),
  },
  gather_resources: {
    scope: GOAL_SCOPE.GOAL,
    title: 'gather_resources',
    priority: 65,
    actionTypes: ['gather'],
    completion: (entity, goal) => Number(entity.resources[goal.payload.resource || 'food'] || 0) >= Number(goal.payload.amount || 5),
  },
  find_work: {
    scope: GOAL_SCOPE.GOAL,
    title: 'find_work',
    priority: 62,
    actionTypes: ['work'],
    completion: (entity, goal) => Number(entity.resources.currency || 0) >= Number(goal.payload.amount || 50),
  },
  support_city: {
    scope: GOAL_SCOPE.GOAL,
    title: 'support_city',
    priority: 58,
    actionTypes: ['work', 'gather'],
    completion: (_entity, goal, world) => {
      const cityId = goal.payload.cityId;
      const city = cityId ? world.cities?.byId?.[cityId] : null;
      return city ? Number(city.risk || 0) <= Number(goal.payload.targetRisk || 0.35) : false;
    },
  },
  gain_resources: {
    scope: GOAL_SCOPE.GOAL,
    title: 'gain_resources',
    priority: 55,
    actionTypes: ['work', 'gather'],
    completion: (entity, goal) => Number(entity.resources[goal.payload.resource || 'currency'] || 0) >= Number(goal.payload.amount || 100),
  },
  build_relationship: {
    scope: GOAL_SCOPE.GOAL,
    title: 'build_relationship',
    priority: 45,
    actionTypes: ['interact', 'transfer'],
    completion: () => false,
  },
  gain_power: {
    scope: GOAL_SCOPE.DREAM,
    title: 'gain_power',
    priority: 65,
    actionTypes: ['work', 'gather', 'rest'],
    completion: (entity, goal) => Number(entity.stats.power || 0) >= Number(goal.payload.power || 100),
  },
  lead_faction: {
    scope: GOAL_SCOPE.DREAM,
    title: 'lead_faction',
    priority: 75,
    actionTypes: ['interact', 'work', 'transfer'],
    completion: entity => entity.meta && entity.meta.role === 'leader',
  },
};

function ensureGoalState(entity) {
  if (!entity.goals) entity.goals = [];
  if (!entity.goalMemory) entity.goalMemory = [];
  return entity.goals;
}

function createGoal(input = {}) {
  if (!input.type) throw new Error('Goal requires type');
  const template = DEFAULT_GOAL_TEMPLATES[input.type] || {};
  return {
    id: input.id || `goal_unbound_${input.type}`,
    type: input.type,
    scope: input.scope || template.scope || GOAL_SCOPE.GOAL,
    title: input.title || template.title || input.type,
    status: input.status || GOAL_STATUS.ACTIVE,
    priority: clamp(input.priority ?? template.priority ?? 50, 0, 100),
    progress: clamp(input.progress || 0, 0, 100),
    targetId: input.targetId || null,
    locationId: input.locationId || null,
    createdAt: input.createdAt || 0,
    updatedAt: input.updatedAt || 0,
    completedAt: input.completedAt || null,
    payload: { ...(template.payload || {}), ...(input.payload || {}) },
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
  };
}

function assignGoal(world, entityId, goalInput) {
  const entity = world.entities[entityId];
  if (!entity) throw new Error(`Missing entity ${entityId}`);
  ensureGoalState(entity);
  const goal = createGoal({
    ...goalInput,
    id: goalInput.id || nextWorldId(world, 'goal', `goal.${goalInput.type || 'generic'}`),
    createdAt: world.tick,
    updatedAt: world.tick,
  });
  entity.goals.push(goal);
  recordGoalMemory(world, entity, goal, 'goal.assigned');
  return goal;
}

function seedDefaultGoals(world, entityId, options = {}) {
  const entity = world.entities[entityId];
  if (!entity) throw new Error(`Missing entity ${entityId}`);
  ensureGoalState(entity);

  const created = [];
  if (!hasActiveGoal(entity, 'survive')) created.push(assignGoal(world, entityId, { type: 'survive', scope: GOAL_SCOPE.NEED, priority: 100 }));

  if (entity.stats.health < entity.stats.maxHealth * 0.6 && !hasActiveGoal(entity, 'recover')) {
    created.push(assignGoal(world, entityId, { type: 'recover', scope: GOAL_SCOPE.NEED, priority: 90 }));
  }

  if (!hasActiveGoal(entity, 'gain_resources')) {
    created.push(assignGoal(world, entityId, {
      type: 'gain_resources',
      scope: GOAL_SCOPE.GOAL,
      priority: options.resourcePriority || 55,
      payload: { resource: options.resource || 'currency', amount: options.amount || 100 },
    }));
  }

  if (!entity.goals.some(g => g.scope === GOAL_SCOPE.DREAM && g.status === GOAL_STATUS.ACTIVE)) {
    created.push(assignGoal(world, entityId, options.dream || pickDream(entity)));
  }

  return created;
}

function pickDream(entity) {
  const ambition = Number(entity.traits.ambition || entity.stats.power || 50);
  if (ambition >= 80) return { type: 'lead_faction', scope: GOAL_SCOPE.DREAM, priority: 85 };
  if (ambition >= 55) return { type: 'gain_power', scope: GOAL_SCOPE.DREAM, priority: 70, payload: { power: 100 } };
  return { type: 'gain_resources', scope: GOAL_SCOPE.DREAM, priority: 60, payload: { resource: 'currency', amount: 1000 } };
}

function evaluateGoals(world, entityId) {
  const entity = world.entities[entityId];
  if (!entity) throw new Error(`Missing entity ${entityId}`);
  ensureGoalState(entity);

  const changed = [];
  for (const goal of entity.goals) {
    if (goal.status !== GOAL_STATUS.ACTIVE) continue;
    goal.progress = calculateGoalProgress(world, entity, goal);
    goal.updatedAt = world.tick;
    const template = DEFAULT_GOAL_TEMPLATES[goal.type];
    const completed = template && typeof template.completion === 'function' ? template.completion(entity, goal, world) : goal.progress >= 100;
    if (completed && goal.type !== 'survive') {
      goal.status = GOAL_STATUS.COMPLETED;
      goal.completedAt = world.tick;
      changed.push(goal);
      recordGoalMemory(world, entity, goal, 'goal.completed');
      spawnFollowUpGoals(world, entity, goal);
    }
  }
  return changed;
}

function calculateGoalProgress(world, entity, goal) {
  if (goal.type === 'survive') return entity.status === 'alive' ? 100 : 0;
  if (goal.type === 'recover') return clamp((entity.stats.health / Math.max(1, entity.stats.maxHealth)) * 100, 0, 100);
  if (goal.type === 'migrate' || goal.type === 'seek_shelter') return entity.locationId === goal.payload.targetLocationId ? 100 : 0;
  if (goal.type === 'stockpile_resource' || goal.type === 'gather_resources' || goal.type === 'gain_resources') {
    const resource = goal.payload.resource || (goal.type === 'gain_resources' ? 'currency' : 'food');
    const amount = Number(goal.payload.amount || 100);
    return clamp((Number(entity.resources[resource] || 0) / Math.max(1, amount)) * 100, 0, 100);
  }
  if (goal.type === 'find_work') return clamp((Number(entity.resources.currency || 0) / Math.max(1, Number(goal.payload.amount || 50))) * 100, 0, 100);
  if (goal.type === 'support_city') {
    const city = goal.payload.cityId ? world.cities?.byId?.[goal.payload.cityId] : null;
    if (!city) return 0;
    const currentRisk = Number(city.risk || 0);
    const targetRisk = Number(goal.payload.targetRisk || 0.35);
    return clamp((1 - currentRisk / Math.max(0.01, targetRisk)) * 100, 0, 100);
  }
  if (goal.type === 'gain_power') return clamp((Number(entity.stats.power || 0) / Math.max(1, Number(goal.payload.power || 100))) * 100, 0, 100);
  if (goal.type === 'lead_faction') return entity.meta && entity.meta.role === 'leader' ? 100 : 0;
  return goal.progress || 0;
}

function spawnFollowUpGoals(world, entity, completedGoal) {
  if (completedGoal.type === 'gain_resources' && completedGoal.scope !== GOAL_SCOPE.DREAM) {
    assignGoal(world, entity.id, {
      type: 'gain_resources',
      scope: GOAL_SCOPE.GOAL,
      priority: Math.max(30, completedGoal.priority - 5),
      payload: { resource: completedGoal.payload.resource || 'currency', amount: Number(completedGoal.payload.amount || 100) * 2 },
      tags: ['follow_up'],
    });
  }
  if (completedGoal.type === 'gain_power') {
    assignGoal(world, entity.id, { type: 'gain_power', scope: GOAL_SCOPE.DREAM, priority: completedGoal.priority, payload: { power: Number(completedGoal.payload.power || 100) * 2 }, tags: ['escalated_dream'] });
  }
}

function chooseActiveGoal(world, entityId) {
  const entity = world.entities[entityId];
  if (!entity) throw new Error(`Missing entity ${entityId}`);
  ensureGoalState(entity);
  evaluateGoals(world, entityId);
  return entity.goals.filter(goal => goal.status === GOAL_STATUS.ACTIVE).sort((a, b) => scoreGoal(entity, b) - scoreGoal(entity, a))[0] || null;
}

function scoreGoal(entity, goal) {
  const scopeWeight = goal.scope === GOAL_SCOPE.NEED ? 1.4 : goal.scope === GOAL_SCOPE.DREAM ? 1.05 : 1;
  const urgency = 100 - Number(goal.progress || 0);
  const ambition = Number(entity.traits.ambition || 50);
  const environmentBoost = goal.tags?.includes('environment_generated') ? 18 : 0;
  const dreamBoost = goal.scope === GOAL_SCOPE.DREAM ? ambition * 0.15 : 0;
  return goal.priority * scopeWeight + urgency * 0.2 + dreamBoost + environmentBoost;
}

function goalToActionIntent(world, entityId, goal) {
  const entity = world.entities[entityId];
  if (!entity || !goal) return null;
  if (goal.type === 'recover') return { type: 'rest', actorId: entity.id, duration: 1, priority: goal.priority, payload: { health: 12, energy: 20, goalId: goal.id } };
  if (goal.type === 'seek_shelter' || goal.type === 'migrate') {
    const to = goal.payload.targetLocationId;
    if (!to || !world.locations[to]) return null;
    return { type: 'move', actorId: entity.id, targetId: to, duration: 1, priority: goal.priority, payload: { to, ignoreNeighbors: goal.payload.ignoreNeighbors !== false, goalId: goal.id } };
  }
  if (goal.type === 'survive') {
    if (entity.stats.health < entity.stats.maxHealth * 0.5) return { type: 'rest', actorId: entity.id, duration: 1, priority: goal.priority, payload: { health: 10, energy: 10, goalId: goal.id } };
    return { type: 'gather', actorId: entity.id, duration: 1, priority: goal.priority, payload: { resource: 'food', amount: 1, goalId: goal.id } };
  }
  if (goal.type === 'stockpile_resource' || goal.type === 'gather_resources') {
    return { type: 'gather', actorId: entity.id, duration: 1, priority: goal.priority, payload: { resource: goal.payload.resource || 'food', amount: goal.payload.gatherAmount || 3, goalId: goal.id } };
  }
  if (goal.type === 'find_work') return { type: 'work', actorId: entity.id, duration: 1, priority: goal.priority, payload: { resource: 'currency', amount: goal.payload.workAmount || 8, energyCost: 6, goalId: goal.id } };
  if (goal.type === 'support_city') return { type: 'work', actorId: entity.id, duration: 1, priority: goal.priority, payload: { resource: goal.payload.resource || 'service', amount: goal.payload.workAmount || 4, energyCost: 5, goalId: goal.id } };
  if (goal.type === 'gain_resources') return { type: 'work', actorId: entity.id, duration: 1, priority: goal.priority, payload: { resource: goal.payload.resource || 'currency', amount: 5, energyCost: 5, goalId: goal.id } };
  if (goal.type === 'build_relationship' && goal.targetId) return { type: 'interact', actorId: entity.id, targetId: goal.targetId, duration: 1, priority: goal.priority, payload: { effect: 'social', amount: 3, goalId: goal.id } };
  if (goal.type === 'gain_power') return { type: 'work', actorId: entity.id, duration: 1, priority: goal.priority, payload: { resource: 'training', amount: 1, energyCost: 8, goalId: goal.id } };
  if (goal.type === 'lead_faction') return { type: 'interact', actorId: entity.id, duration: 1, priority: goal.priority, payload: { effect: 'social', amount: 2, goalId: goal.id } };
  return null;
}

function planEntityAction(world, entityId) {
  const goal = chooseActiveGoal(world, entityId);
  if (!goal) return null;
  const action = goalToActionIntent(world, entityId, goal);
  if (!action) return null;
  return { goal, action };
}

function planAllEntityActions(world, options = {}) {
  const plans = [];
  const entities = Object.values(world.entities).filter(entity => entity.status === 'alive');
  for (const entity of entities) {
    seedDefaultGoals(world, entity.id, options.defaultGoalOptions || {});
    const plan = planEntityAction(world, entity.id);
    if (!plan) continue;
    plans.push({ entityId: entity.id, ...plan });
  }
  return plans;
}

function hasActiveGoal(entity, type) {
  ensureGoalState(entity);
  return entity.goals.some(goal => goal.type === type && goal.status === GOAL_STATUS.ACTIVE);
}

function recordGoalMemory(world, entity, goal, type) {
  const memory = { id: nextWorldId(world, 'memory', 'goal.memory'), tick: world.tick, type, payload: { entityId: entity.id, goalId: goal.id, goalType: goal.type, scope: goal.scope, priority: goal.priority, progress: goal.progress } };
  world.memory.push(memory);
  if (world.memory.length > 1000) world.memory.shift();
  entity.goalMemory.push(memory.id);
}

module.exports = {
  GOAL_STATUS,
  GOAL_SCOPE,
  DEFAULT_GOAL_TEMPLATES,
  ensureGoalState,
  createGoal,
  assignGoal,
  seedDefaultGoals,
  evaluateGoals,
  calculateGoalProgress,
  chooseActiveGoal,
  goalToActionIntent,
  planEntityAction,
  planAllEntityActions,
  scoreGoal,
};
