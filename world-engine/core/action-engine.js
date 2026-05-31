'use strict';

const { clamp } = require('./schema');

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

  const handler = (options.actionHandlers && options.actionHandlers[action.type]) || DEFAULT_ACTION_HANDLERS[action.type];

  if (!handler) {
    return fail(action, `unknown_action:${action.type}`);
  }

  const precheck = checkActionPreconditions(world, action, actor);
  if (!precheck.ok) {
    return fail(action, precheck.reason);
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

function handleMove(world, action, actor) {
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
  });

  return { moved: true, from, to };
}

function handleGather(world, action, actor) {
  const location = world.locations[actor.locationId];
  if (!location) throw new Error('gather requires actor location');

  const key = action.payload.resource || 'material';
  const amount = Number(action.payload.amount || 1);
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
  });

  return { resource: key, amount: gathered };
}

function handleRest(world, action, actor) {
  const healthGain = Number(action.payload.health || 10);
  const energyGain = Number(action.payload.energy || 15);

  actor.stats.health = clamp(actor.stats.health + healthGain, 0, actor.stats.maxHealth || 100);
  actor.stats.energy = clamp(actor.stats.energy + energyGain, 0, actor.stats.maxEnergy || 100);

  pushEvent(world, {
    type: 'entity.rested',
    actorIds: [actor.id],
    locationId: actor.locationId,
    payload: { healthGain, energyGain },
    actionId: action.id,
  });

  return { health: actor.stats.health, energy: actor.stats.energy };
}

function handleWork(world, action, actor) {
  const resource = action.payload.resource || 'currency';
  const amount = Number(action.payload.amount || 5);
  const energyCost = Number(action.payload.energyCost || 5);

  actor.stats.energy = clamp(actor.stats.energy - energyCost, 0, actor.stats.maxEnergy || 100);
  actor.resources[resource] = Number(actor.resources[resource] || 0) + amount;

  pushEvent(world, {
    type: 'entity.worked',
    actorIds: [actor.id],
    locationId: actor.locationId,
    payload: { resource, amount, energyCost },
    actionId: action.id,
  });

  return { resource, amount, energyCost };
}

function handleInteract(world, action, actor) {
  const target = world.entities[action.targetId];
  if (!target) throw new Error('interact requires entity target');

  const effect = action.payload.effect || 'social';
  const amount = Number(action.payload.amount || 1);

  pushEvent(world, {
    type: 'entity.interacted',
    actorIds: [actor.id, target.id],
    locationId: actor.locationId,
    payload: { effect, amount },
    actionId: action.id,
  });

  return { targetId: target.id, effect, amount };
}

function handleTransfer(world, action, actor) {
  const target = world.entities[action.targetId];
  if (!target) throw new Error('transfer requires entity target');

  const resource = action.payload.resource || 'currency';
  const amount = Math.max(0, Number(action.payload.amount || 0));
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
  });

  return { targetId: target.id, resource, amount: transferred };
}

function handleDamage(world, action, actor) {
  const target = world.entities[action.targetId];
  if (!target) throw new Error('damage requires entity target');

  const amount = Math.max(0, Number(action.payload.amount || actor.stats.power || 1));
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
  });

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

function pushEvent(world, input) {
  world.events.push({
    id: `event_${world.tick}_${world.events.length + 1}`,
    type: input.type,
    status: 'pending',
    tick: world.tick,
    actorIds: input.actorIds || [],
    locationId: input.locationId || null,
    factionIds: input.factionIds || [],
    payload: input.payload || {},
    effects: input.effects || [],
    causeIds: input.causeIds || [],
    actionId: input.actionId || null,
    tags: input.tags || [],
  });
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
};
