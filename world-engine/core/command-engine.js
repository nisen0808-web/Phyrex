'use strict';

const { nextWorldId } = require('./world-id-engine');
const { PRIORITY, RULE_VERSION, preparePlayerAction, getPlayerActionRules } = require('./player-action-rules-engine');
const { validateCommand, finiteData, record, identifier, own, MAX_ACTIVE_PLAYER_GOALS, MAX_PENDING_PLAYER_ACTIONS } = require('./player-command-contract');

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
  EQUIP_ITEM: 'equip_item', UNEQUIP_ITEM: 'unequip_item', USE_ITEM: 'use_item',
  BUY_ITEM: 'buy_item', SELL_ITEM: 'sell_item', GIVE_ITEM: 'give_item',
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
  if (Object.hasOwn(state.byId, command.id)) throw new Error('command_id_collision');
  Object.defineProperty(state.byId, command.id, { value: command, writable: true, enumerable: true, configurable: true });
  if (!Object.hasOwn(state.byPlayer, playerId)) Object.defineProperty(state.byPlayer, playerId, { value: [], writable: true, enumerable: true, configurable: true });
  state.byPlayer[playerId].push(command.id);
  state.log.push(command.id);
  state.stats.submitted += 1;
  trimCommandLog(world, options.maxLog || DEFAULT_COMMAND_OPTIONS.maxLog);
  return command;
}

function executePlayerCommand(world, playerId, input = {}, options = {}) {
  const validInput = record(input) && finiteData(input) && (input.id === undefined || identifier(input.id));
  const safeInput = validInput ? input : { id: identifier(input?.id) ? input.id : undefined, type: 'invalid' };
  const command = submitPlayerCommand(world, playerId, safeInput, options);
  // Unexpected implementation errors escape and roll back a durable candidate;
  // expected player errors are checked before gameplay mutation.
  const reason = validInput ? validateCommand(command, world, options) : 'invalid_payload';
  const result = reason ? reject(command, reason) : dispatchCommand(world, command, options);

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
  if (type === COMMAND_TYPES.CREATE_CHARACTER) {
    const id = command.payload.id || `${player.id}_character_${player.controlledEntityIds.length + 1}`;
    if (!identifier(id) || Object.hasOwn(world.entities, id)) return reject(command, 'character_id_collision');
    const created = createPlayerCharacter(world, player.id, command.payload, options.player || {});
    return complete(command, options.publicPlayer ? { entityId: created.id, name: created.name, species: created.species } : created);
  }
  if (type === COMMAND_TYPES.SWITCH_CHARACTER) {
    const id = command.payload.entityId, target = own(world.entities, id);
    if (!target) return reject(command, 'missing_character');
    if (!player.controlledEntityIds.includes(id) || own(world.players.byEntityId, id) !== player.id || target.meta?.playerId !== player.id) return reject(command, 'character_not_owned');
    if (target.status !== 'alive') return reject(command, 'character_not_alive');
    const switched = switchPlayerCharacter(world, player.id, id);
    return complete(command, options.publicPlayer ? { entityId: switched.activeEntityId } : switched);
  }
  if (type === COMMAND_TYPES.OBSERVE) {
    if (command.payload.locationId && !own(world.locations, command.payload.locationId)) return reject(command, 'missing_location');
    const observing = setPlayerObserverMode(world, player.id, command.payload.locationId || null);
    return complete(command, options.publicPlayer ? { locationId: observing.observerLocationId } : observing);
  }
  if (type === COMMAND_TYPES.INSPECT) return complete(command, { targetType: command.payload.targetType || 'world', targetId: command.payload.targetId || null });
  if (type === COMMAND_TYPES.WAIT) return complete(command, { ticks: Number(command.payload.ticks ?? 1) });

  if (player.controlMode !== 'character') return reject(command, 'observer_cannot_act');
  const entity = getActivePlayerCharacter(world, player.id);
  if (!entity) return reject(command, 'missing_active_character');
  if (entity.status !== 'alive') return reject(command, 'active_character_not_alive');
  if (!player.controlledEntityIds.includes(entity.id) || own(world.players.byEntityId, entity.id) !== player.id || entity.meta?.playerId !== player.id) return reject(command, 'character_not_owned');
  if (options.publicPlayer && world.actionQueue.filter(a => a.actorId === entity.id).length >= MAX_PENDING_PLAYER_ACTIONS) return reject(command, 'action_limit');
  if (type === 'set_goal' && options.publicPlayer && (entity.goals || []).filter(g => g.status === 'active').length >= MAX_ACTIVE_PLAYER_GOALS) return reject(command, 'goal_limit');
  if (['interact', 'transfer', 'damage'].includes(type)) {
    const target = own(world.entities, command.payload.targetId);
    if (!target) return reject(command, 'missing_target');
    if (target.status !== 'alive') return reject(command, 'target_not_alive');
    if (options.publicPlayer && target.locationId !== entity.locationId) return reject(command, 'target_not_at_location');
  }
  if (type === 'gather' && !own(world.locations, entity.locationId)) return reject(command, 'missing_location');
  if ((options.publicPlayer || ['equip_item', 'unequip_item', 'use_item', 'buy_item', 'sell_item', 'give_item'].includes(type)) && Object.hasOwn(PRIORITY, type)) {
    if (world.actionQueue.some(action => action.actorId === entity.id && action.playerActionRuleVersion)) return reject(command, 'character_busy');
    const rules = getPlayerActionRules(world), prepared = preparePlayerAction(world, entity, type, command.payload, rules);
    if (prepared.reason) return reject(command, prepared.reason);
    world.playerActionRules = rules;
    const action = enqueueAction(world, prepared.action);
    action.playerActionRuleVersion = RULE_VERSION;
    return accepted(command, action, options);
  }


  if (type === COMMAND_TYPES.MOVE) {
    const locationId = command.payload.locationId;
    if (!world.locations[locationId]) return reject(command, 'missing_location');
    const action = enqueueAction(world, { type: 'move', actorId: entity.id, targetId: locationId, priority: priority(command, 70), payload: { to: locationId } });
    return accepted(command, action, options);
  }

  if (type === COMMAND_TYPES.GATHER) {
    const action = enqueueAction(world, { type: 'gather', actorId: entity.id, priority: priority(command, 50), payload: { resource: command.payload.resource || 'food', amount: Number(command.payload.amount ?? 3) } });
    return accepted(command, action, options);
  }

  if (type === COMMAND_TYPES.WORK) {
    const action = enqueueAction(world, { type: 'work', actorId: entity.id, priority: priority(command, 55), payload: { resource: command.payload.resource || 'currency', amount: Number(command.payload.amount ?? 10), energyCost: Number(command.payload.energyCost ?? 6) } });
    return accepted(command, action, options);
  }

  if (type === COMMAND_TYPES.TRAIN) {
    const action = enqueueAction(world, { type: 'work', actorId: entity.id, priority: priority(command, 60), payload: { resource: 'training', amount: Number(command.payload.amount ?? 2), energyCost: Number(command.payload.energyCost ?? 8), commandType: 'train' } });
    assignGoal(world, entity.id, { type: 'gain_power', priority: 70, payload: { power: Math.max(Number(entity.stats.power || 0) + 10, Number(command.payload.power ?? 50)) }, tags: ['player_command'] });
    return accepted(command, action, options);
  }

  if (type === COMMAND_TYPES.REST) {
    const action = enqueueAction(world, { type: 'rest', actorId: entity.id, priority: priority(command, 65), payload: { health: Number(command.payload.health ?? 12), energy: Number(command.payload.energy ?? 20) } });
    return accepted(command, action, options);
  }

  if (type === COMMAND_TYPES.INTERACT) {
    const targetId = command.payload.targetId;
    const action = enqueueAction(world, { type: 'interact', actorId: entity.id, targetId, priority: priority(command, 45), payload: { effect: command.payload.effect || 'social', amount: Number(command.payload.amount ?? 3) } });
    return accepted(command, action, options);
  }

  if (type === COMMAND_TYPES.TRANSFER) {
    const targetId = command.payload.targetId;
    const action = enqueueAction(world, { type: 'transfer', actorId: entity.id, targetId, priority: priority(command, 50), payload: { resource: command.payload.resource || 'currency', amount: Number(command.payload.amount ?? 1) } });
    return accepted(command, action, options);
  }

  if (type === COMMAND_TYPES.DAMAGE) {
    const targetId = command.payload.targetId;
    const action = enqueueAction(world, { type: 'damage', actorId: entity.id, targetId, priority: priority(command, 80), payload: { amount: Number(command.payload.amount ?? entity.stats.power ?? 1), lethal: command.payload.lethal !== false } });
    return accepted(command, action, options);
  }

  if (type === COMMAND_TYPES.JOIN_ORGANIZATION) {
    const organizationId = command.payload.organizationId;
    const org = getOrganization(world, organizationId);
    if (!org) return reject(command, 'missing_organization');
    if (org.status === 'dissolved') return reject(command, 'organization_dissolved');
    if (org.members.includes(entity.id)) return complete(command, { organizationId, entityId: entity.id, role: org.roles[entity.id] });
    addOrganizationMember(world, organizationId, entity.id, { role: command.payload.role || 'member', createContract: command.payload.createContract !== false });
    return complete(command, { organizationId, entityId: entity.id, role: command.payload.role || 'member' });
  }

  if (type === COMMAND_TYPES.SET_GOAL) {
    const goal = assignGoal(world, entity.id, { type: command.payload.goalType || command.payload.type || 'gain_resources', priority: Number(command.payload.priority ?? 50), payload: command.payload.payload || command.payload, tags: ['player_command'] });
    return complete(command, { goalId: goal.id, goalType: goal.type });
  }

  return reject(command, `unknown_command:${type}`);
}

function normalizeCommand(world, playerId, input = {}) {
  if (!input || typeof input !== 'object') input = {};
  const type = typeof input.type === 'string' && input.type.length <= 128 ? input.type : 'invalid';
  return {
    id: input.id || nextWorldId(world, 'cmd', 'command.create'),
    playerId,
    type,
    status: 'submitted',
    createdAt: world.tick,
    updatedAt: world.tick,
    payload: input.payload !== undefined && !record(input.payload) ? null : { ...(input.payload || {}), ...copyCommandTopLevelPayload(input) },
    result: null,
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
  };
}

function copyCommandTopLevelPayload(input) {
  const out = {};
  for (const key of ['itemId', 'shopId', 'definitionId', 'quantity', 'slot', 'locationId', 'targetId', 'targetType', 'organizationId', 'entityId', 'resource', 'amount', 'ticks', 'role', 'goalType', 'priority', 'effect', 'energyCost', 'health', 'energy', 'power', 'lethal', 'createContract']) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

function accepted(command, action, options) {
  action.playerCommandId = command.id;
  if (options.publicPlayer && ['interact', 'transfer', 'damage'].includes(command.type)) action.playerLocationRequired = true;
  return { ok: true, completed: false, actionId: action.id, actionType: action.type, commandId: command.id };
}

function complete(command, value) {
  return { ok: true, completed: true, value, commandId: command.id };
}

function reject(command, reason) {
  return { ok: false, completed: true, reason, commandId: command.id };
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
