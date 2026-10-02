'use strict';

const { nextWorldId } = require('./world-id-engine');

const { clamp, createEvent } = require('./schema');

const DEFAULT_ACTION_HANDLERS = {
  move: handleMove,
  gather: handleGather,
  rest: handleRest,
  work: handleWork,
  interact: handleInteract,
  transfer: handleTransfer,
  damage: handleDamage,
};

function applyActionTick(world, action, options = {}) {
  const actor = action.actorId ? world.entities[action.actorId] : null;

  if (action.actorId && !actor) {
    return fail(action, 'missing_actor');
  }

  if (actor && actor.status !== 'alive') {
    return fail(action, 'actor_not_alive');
  }

  const handler = (options.actionHandlers && Object.hasOwn(options.actionHandlers, action.type) && options.actionHandlers[action.type])
    || (Object.hasOwn(DEFAULT_ACTION_HANDLERS, action.type) && DEFAULT_ACTION_HANDLERS[action.type]);

  if (!handler) {
    return fail(action, `unknown_action:${action.type}`);
  }

  const precheck = checkActionPreconditions(world, action, actor);
  if (!precheck.ok) {
    return fail(action, precheck.reason);
  }

  if (Object.hasOwn(DEFAULT_ACTION_HANDLERS, action.type)) {
    const invalid = validateBuiltInAction(world, action, actor);
    if (invalid) return fail(action, invalid);
  }
  action.remaining -= 1;

  if (action.remaining > 0) {
    return {
      status: 'active',
      actionId: action.id,
      type: action.type,
      remaining: action.remaining,
    };
  }

  const result = handler(world, action, actor, options);
  return {
    status: 'completed',
    actionId: action.id,
    type: action.type,
    result,
  };
}

function checkActionPreconditions(world, action, actor) {
  if (action.locationId && !world.locations[action.locationId]) {
    return { ok: false, reason: 'missing_location' };
  }

  if (action.targetId && !world.entities[action.targetId] && !world.locations[action.targetId] && !world.factions[action.targetId]) {
    return { ok: false, reason: 'missing_target' };
  }

  if (actor && action.locationId && actor.locationId !== action.locationId) {
    return { ok: false, reason: 'actor_not_at_required_location' };
  }

  return { ok: true };
}

function validateBuiltInAction(world, action, actor) {
  if (!actor) return 'missing_actor';
  if (!Number.isSafeInteger(action.remaining) || action.remaining < 1) return 'invalid_duration';
  const p = action.payload || {};
  for (const key of ['amount', 'health', 'energy', 'energyCost']) {
    if (p[key] !== undefined && (typeof p[key] !== 'number' || !Number.isFinite(p[key]) || p[key] < 0)) return 'invalid_number';
  }
  if (p.resource !== undefined && (typeof p.resource !== 'string' || !p.resource || Object.hasOwn(Object.prototype, p.resource))) return 'invalid_resource';
  if (action.type === 'move' && !Object.hasOwn(world.locations, p.to || action.targetId || action.locationId)) return 'missing_location';
  if (action.type === 'gather' && !Object.hasOwn(world.locations, actor.locationId)) return 'missing_location';
  if (['interact', 'transfer', 'damage'].includes(action.type)) {
    const target = Object.hasOwn(world.entities, action.targetId) ? world.entities[action.targetId] : null;
    if (!target) return 'missing_entity_target';
    if (action.playerLocationRequired && target.locationId !== actor.locationId) return 'target_not_at_location';
    if (action.playerCommandId && target.status !== 'alive') return 'target_not_alive';
  }
  if (action.type === 'work' && !Number.isFinite(Number(actor.resources[p.resource || 'currency'] || 0) + (p.amount ?? 5))) return 'resource_overflow';
  if (action.type === 'gather' && !Number.isFinite(Number(actor.resources[p.resource || 'material'] || 0) + (p.amount ?? 1))) return 'resource_overflow';
  if (action.type === 'transfer' && !Number.isFinite(Number(world.entities[action.targetId].resources[p.resource || 'currency'] || 0) + (p.amount ?? 0))) return 'resource_overflow';
  return null;
}

function handleMove(world, action, actor, options = {}) {
  const to = action.payload.to || action.targetId || action.locationId;
  if (!to || !world.locations[to]) throw new Error('move action requires valid target location');

  const from = actor.locationId;
  const canMove = !from || world.locations[from]?.neighbors.includes(to) || action.payload.ignoreNeighbors === true;

  if (!canMove) {
    return {
      moved: false,
      reason: 'not_neighbors',
      from,
      to,
    };
  }

  actor.locationId = to;

  pushEvent(world, {
    type: 'entity.moved',
    actorIds: [actor.id],
    locationId: to,
    payload: { from, to },
    actionId: action.id,
  }, options);

  return { moved: true, from, to };
}

function handleGather(world, action, actor, options = {}) {
  const location = world.locations[actor.locationId];
  if (!location) throw new Error('gather requires actor location');

  const key = action.payload.resource || 'material';
  const amount = Number(action.payload.amount ?? 1);
  const available = Number(location.resources[key] || 0);
  const gathered = Math.min(available, amount);

  location.resources[key] = available - gathered;
  actor.resources[key] = Number(actor.resources[key] || 0) + gathered;

  pushEvent(world, {
    type: 'resource.gathered',
    actorIds: [actor.id],
    locationId: actor.locationId,
    payload: { resource: key, amount: gathered },
    actionId: action.id,
  }, options);

  return { resource: key, amount: gathered };
}

function handleRest(world, action, actor, options = {}) {
  const healthGain = Number(action.payload.health ?? 10);
  const energyGain = Number(action.payload.energy ?? 15);

  actor.stats.health = clamp(actor.stats.health + healthGain, 0, actor.stats.maxHealth || 100);
  actor.stats.energy = clamp(actor.stats.energy + energyGain, 0, actor.stats.maxEnergy || 100);

  pushEvent(world, {
    type: 'entity.rested',
    actorIds: [actor.id],
    locationId: actor.locationId,
    payload: { healthGain, energyGain },
    actionId: action.id,
  }, options);

  return { health: actor.stats.health, energy: actor.stats.energy };
}

function handleWork(world, action, actor, options = {}) {
  const resource = action.payload.resource || 'currency';
  const amount = Number(action.payload.amount ?? 5);
  const energyCost = Number(action.payload.energyCost ?? 5);

  actor.stats.energy = clamp(actor.stats.energy - energyCost, 0, actor.stats.maxEnergy || 100);
  actor.resources[resource] = Number(actor.resources[resource] || 0) + amount;

  pushEvent(world, {
    type: 'entity.worked',
    actorIds: [actor.id],
    locationId: actor.locationId,
    payload: { resource, amount, energyCost },
    actionId: action.id,
  }, options);

  return { resource, amount, energyCost };
}

function handleInteract(world, action, actor, options = {}) {
  const target = world.entities[action.targetId];
  if (!target) throw new Error('interact requires entity target');

  const effect = action.payload.effect || 'social';
  const amount = Number(action.payload.amount ?? 1);

  pushEvent(world, {
    type: 'entity.interacted',
    actorIds: [actor.id, target.id],
    locationId: actor.locationId,
    payload: { effect, amount },
    actionId: action.id,
  }, options);

  return { targetId: target.id, effect, amount };
}

function handleTransfer(world, action, actor, options = {}) {
  const target = world.entities[action.targetId];
  if (!target) throw new Error('transfer requires entity target');

  const resource = action.payload.resource || 'currency';
  const amount = Math.max(0, Number(action.payload.amount ?? 0));
  const current = Number(actor.resources[resource] || 0);
  const transferred = Math.min(current, amount);

  actor.resources[resource] = current - transferred;
  target.resources[resource] = Number(target.resources[resource] || 0) + transferred;

  pushEvent(world, {
    type: 'resource.transferred',
    actorIds: [actor.id, target.id],
    locationId: actor.locationId,
    payload: { resource, amount: transferred },
    actionId: action.id,
  }, options);

  return { targetId: target.id, resource, amount: transferred };
}

function handleDamage(world, action, actor, options = {}) {
  const target = world.entities[action.targetId];
  if (!target) throw new Error('damage requires entity target');

  const amount = Math.max(0, Number(action.payload.amount ?? actor.stats.power ?? 1));
  target.stats.health = clamp(target.stats.health - amount, 0, target.stats.maxHealth || 100);

  if (target.stats.health <= 0) {
    target.status = action.payload.lethal === false ? 'inactive' : 'dead';
  }

  pushEvent(world, {
    type: 'entity.damaged',
    actorIds: [actor.id, target.id],
    locationId: target.locationId,
    payload: { amount, targetStatus: target.status },
    actionId: action.id,
  }, options);

  return { targetId: target.id, amount, targetStatus: target.status };
}

function fail(action, reason) {
  return {
    status: 'failed',
    actionId: action.id,
    type: action.type,
    reason,
  };
}

function pushEvent(world, input, options = {}) {
  if (typeof options.emitEvent === 'function') {
    return options.emitEvent(world, input);
  }
  const event = createEvent({ ...input, id: input.id || nextWorldId(world, 'event', 'action.event'), tick: input.tick ?? world.tick });
  world.events.push(event);
  return event;
}

module.exports = {
  DEFAULT_ACTION_HANDLERS,
  applyActionTick,
  checkActionPreconditions,
  handleMove,
  handleGather,
  handleRest,
  handleWork,
  handleInteract,
  handleTransfer,
  handleDamage,
  pushEvent,
};
