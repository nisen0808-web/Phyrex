'use strict';

const { enqueueAction, recordMemory } = require('./world-engine');
const { assignGoal } = require('./goal-engine');
const { addOrganizationMember, getOrganization } = require('./organization-engine');
const { createPlayerCharacter, getPlayer, getActivePlayerCharacter, setPlayerObserverMode, switchPlayerCharacter } = require('./player-engine');

const COMMAND_STATUS = {
  ACCEPTED: 'accepted',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
};

const COMMAND_TYPES = {
  WAIT: 'wait',
  MOVE: 'move',
  GATHER: 'gather',
  WORK: 'work',
  TRAIN: 'train',
  REST: 'rest',
  INTERACT: 'interact',
  TRANSFER: 'transfer',
  DAMAGE: 'damage',
  JOIN_ORGANIZATION: 'join_organization',
  SET_GOAL: 'set_goal',
  CREATE_CHARACTER: 'create_character',
  SWITCH_CHARACTER: 'switch_character',
  OBSERVE: 'observe',
  INSPECT: 'inspect',
};

const DEFAULT_COMMAND_OPTIONS = {
  maxLog: 500,
};

function ensureCommandState(world) {
  if (!world.commands) {
    world.commands = {
      byId: {},
      byPlayer: {},
      log: [],
      stats: {
        submitted: 0,
        accepted: 0,
        rejected: 0,
        completed: 0,
      },
    };
  }
  return world.commands;
}

function submitPlayerCommand(world, playerId, input = {}, options = {}) {
  const state = ensureCommandState(world);
  const command = normalizeCommand(world, playerId, input);
  state.byId[command.id] = command;
  if (!state.byPlayer[playerId]) state.byPlayer[playerId] = [];
  state.byPlayer[playerId].push(command.id);
  state.log.push(command.id);
  state.stats.submitted += 1;
  trimCommandLog(world, options.maxLog || DEFAULT_COMMAND_OPTIONS.maxLog);
  return command;
}

function executePlayerCommand(world, playerId, input = {}, options = {}) {
  const command = submitPlayerCommand(world, playerId, input, options);
  const result = dispatchCommand(world, command, options);
  command.status = result.ok ? result.completed ? COMMAND_STATUS.COMPLETED : COMMAND_STATUS.ACCEPTED : COMMAND_STATUS.REJECTED;
  command.result = result;
  command.updatedAt = world.tick;

  const state = ensureCommandState(world);
  if (command.status === COMMAND_STATUS.ACCEPTED) state.stats.accepted += 1;
  if (command.status === COMMAND_STATUS.COMPLETED) state.stats.completed += 1;
  if (command.status === COMMAND_STATUS.REJECTED) state.stats.rejected += 1;

  recordCommandMemory(world, command);
  return { command, result };
}

function dispatchCommand(world, command, options = {}) {
  const player = getPlayer(world, command.playerId);
  if (!player) return reject(command, 'missing_player');

  const type = command.type;
  if (type === COMMAND_TYPES.CREATE_CHARACTER) return complete(command, createPlayerCharacter(world, player.id, command.payload || {}, options.player || {}));
  if (type === COMMAND_TYPES.SWITCH_CHARACTER) return complete(command, switchPlayerCharacter(world, player.id, required(command, 'entityId')));
  if (type === COMMAND_TYPES.OBSERVE) return complete(command, setPlayerObserverMode(world, player.id, command.payload.locationId || null));
  if (type === COMMAND_TYPES.INSPECT) return complete(command, { targetType: command.payload.targetType || 'world', targetId: command.payload.targetId || null });
  if (type === COMMAND_TYPES.WAIT) return complete(command, { ticks: Number(command.payload.ticks || 1) });

  const entity = getActivePlayerCharacter(world, player.id);
  if (!entity) return reject(command, 'missing_active_character');
  if (entity.status !== 'alive') return reject(command, 'active_character_not_alive');

  if (type === COMMAND_TYPES.MOVE) {
    const locationId = required(command, 'locationId');
    if (!world.locations[locationId]) return reject(command, 'missing_location');
    const action = enqueueAction(world, { type: 'move', actorId: entity.id, targetId: locationId, priority: priority(command, 70), payload: { to: locationId } });
    return accepted(command, action);
  }

  if (type === COMMAND_TYPES.GATHER) {
    const action = enqueueAction(world, { type: 'gather', actorId: entity.id, priority: priority(command, 50), payload: { resource: command.payload.resource || 'food', amount: Number(command.payload.amount || 3) } });
    return accepted(command, action);
  }

  if (type === COMMAND_TYPES.WORK) {
    const action = enqueueAction(world, { type: 'work', actorId: entity.id, priority: priority(command, 55), payload: { resource: command.payload.resource || 'currency', amount: Number(command.payload.amount || 10), energyCost: Number(command.payload.energyCost || 6) } });
    return accepted(command, action);
  }

  if (type === COMMAND_TYPES.TRAIN) {
    const action = enqueueAction(world, { type: 'work', actorId: entity.id, priority: priority(command, 60), payload: { resource: 'training', amount: Number(command.payload.amount || 2), energyCost: Number(command.payload.energyCost || 8), commandType: 'train' } });
    assignGoal(world, entity.id, { type: 'gain_power', priority: 70, payload: { power: Math.max(Number(entity.stats.power || 0) + 10, Number(command.payload.power || 50)) }, tags: ['player_command'] });
    return accepted(command, action);
  }

  if (type === COMMAND_TYPES.REST) {
    const action = enqueueAction(world, { type: 'rest', actorId: entity.id, priority: priority(command, 65), payload: { health: Number(command.payload.health || 12), energy: Number(command.payload.energy || 20) } });
    return accepted(command, action);
  }

  if (type === COMMAND_TYPES.INTERACT) {
    const targetId = required(command, 'targetId');
    const action = enqueueAction(world, { type: 'interact', actorId: entity.id, targetId, priority: priority(command, 45), payload: { effect: command.payload.effect || 'social', amount: Number(command.payload.amount || 3) } });
    return accepted(command, action);
  }

  if (type === COMMAND_TYPES.TRANSFER) {
    const targetId = required(command, 'targetId');
    const action = enqueueAction(world, { type: 'transfer', actorId: entity.id, targetId, priority: priority(command, 50), payload: { resource: command.payload.resource || 'currency', amount: Number(command.payload.amount || 1) } });
    return accepted(command, action);
  }

  if (type === COMMAND_TYPES.DAMAGE) {
    const targetId = required(command, 'targetId');
    const action = enqueueAction(world, { type: 'damage', actorId: entity.id, targetId, priority: priority(command, 80), payload: { amount: Number(command.payload.amount || entity.stats.power || 1), lethal: command.payload.lethal !== false } });
    return accepted(command, action);
  }

  if (type === COMMAND_TYPES.JOIN_ORGANIZATION) {
    const organizationId = required(command, 'organizationId');
    const org = getOrganization(world, organizationId);
    if (!org) return reject(command, 'missing_organization');
    addOrganizationMember(world, organizationId, entity.id, { role: command.payload.role || 'member', createContract: command.payload.createContract !== false });
    return complete(command, { organizationId, entityId: entity.id, role: command.payload.role || 'member' });
  }

  if (type === COMMAND_TYPES.SET_GOAL) {
    const goal = assignGoal(world, entity.id, { type: command.payload.goalType || command.payload.type || 'gain_resources', priority: Number(command.payload.priority || 50), payload: command.payload.payload || command.payload, tags: ['player_command'] });
    return complete(command, { goalId: goal.id, goalType: goal.type });
  }

  return reject(command, `unknown_command:${type}`);
}

function normalizeCommand(world, playerId, input = {}) {
  if (!input.type) throw new Error('Command requires type');
  return {
    id: input.id || `cmd_${world.tick}_${playerId}_${Math.random().toString(16).slice(2)}`,
    playerId,
    type: input.type,
    status: 'submitted',
    createdAt: world.tick,
    updatedAt: world.tick,
    payload: { ...(input.payload || {}), ...copyCommandTopLevelPayload(input) },
    result: null,
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
  };
}

function copyCommandTopLevelPayload(input) {
  const out = {};
  for (const key of ['locationId', 'targetId', 'organizationId', 'entityId', 'resource', 'amount', 'ticks', 'role', 'goalType', 'priority', 'effect']) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

function accepted(command, action) {
  return { ok: true, completed: false, actionId: action.id, actionType: action.type, commandId: command.id };
}

function complete(command, value) {
  return { ok: true, completed: true, value, commandId: command.id };
}

function reject(command, reason) {
  return { ok: false, completed: true, reason, commandId: command.id };
}

function required(command, key) {
  if (!command.payload || command.payload[key] === undefined || command.payload[key] === null) throw new Error(`Command ${command.type} requires ${key}`);
  return command.payload[key];
}

function priority(command, fallback) {
  return Number(command.payload.priority ?? fallback);
}

function recordCommandMemory(world, command) {
  recordMemory(world, { type: `player.command.${command.status}`, payload: { commandId: command.id, playerId: command.playerId, commandType: command.type, result: command.result } });
}

function trimCommandLog(world, limit) {
  const state = ensureCommandState(world);
  while (state.log.length > limit) {
    const removed = state.log.shift();
    delete state.byId[removed];
  }
  for (const playerId of Object.keys(state.byPlayer)) {
    state.byPlayer[playerId] = state.byPlayer[playerId].filter(id => state.byId[id]);
  }
}

function getPlayerCommands(world, playerId, limit = 50) {
  const state = ensureCommandState(world);
  return (state.byPlayer[playerId] || []).slice(-limit).map(id => state.byId[id]).filter(Boolean);
}

function getCommandStats(world) {
  return { ...ensureCommandState(world).stats };
}

module.exports = {
  COMMAND_STATUS,
  COMMAND_TYPES,
  DEFAULT_COMMAND_OPTIONS,
  ensureCommandState,
  submitPlayerCommand,
  executePlayerCommand,
  dispatchCommand,
  getPlayerCommands,
  getCommandStats,
};
