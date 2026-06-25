'use strict';

const { createEvent } = require('./schema');
const { nextEngineId, ensureEngineState } = require('./engine-state-engine');
const { createRandomFunction } = require('./deterministic-rng-engine');
const {
  applyEventRelationshipEffects,
  decayRelationships,
  propagateRelationship,
  scoreRelationship,
} = require('./relationship-engine');

const DEFAULT_EVENT_HANDLERS = {
  'entity.moved': handleEntityMoved,
  'entity.rested': handleEntityRested,
  'entity.worked': handleEntityWorked,
  'entity.interacted': handleRelationshipEvent,
  'resource.gathered': handleResourceEvent,
  'resource.transferred': handleRelationshipEvent,
  'entity.damaged': handleDamageEvent,
};

function processEvents(world, options = {}) {
  const processed = [];
  const generated = [];
  const handlers = { ...DEFAULT_EVENT_HANDLERS, ...(options.eventHandlers || {}) };

  for (const event of world.events) {
    if (event.status !== 'pending') continue;

    const handler = handlers[event.type] || handleGenericEvent;
    const result = handler(world, event, options);

    event.status = result.cancelled ? 'cancelled' : 'resolved';
    event.resolvedAt = world.tick;
    event.result = result;

    processed.push({
      id: event.id,
      type: event.type,
      status: event.status,
      result,
    });

    for (const next of result.generatedEvents || []) {
      const created = emitGeneratedEvent(world, {
        ...next,
        tick: world.tick,
        correlationId: next.correlationId || event.correlationId || options.correlationId || null,
        causationId: next.causationId || event.id,
        causeIds: [event.id, ...(next.causeIds || [])],
      }, options);
      generated.push(created);
    }
  }

  if (options.relationshipDecay !== false) {
    decayRelationships(world, options.relationshipDecayOptions || {});
  }

  trimResolvedEvents(world, options.maxResolvedEvents || 500);

  return { processed, generated };
}

function handleGenericEvent(world, event) {
  recordEventMemory(world, event, { generic: true });
  recordCausalityFromEvent(world, event, 'generic');
  return { ok: true };
}

function handleEntityMoved(world, event) {
  const actorId = event.actorIds[0];
  const actor = world.entities[actorId];

  recordEventMemory(world, event, {
    actorId,
    from: event.payload.from,
    to: event.payload.to,
  });

  recordCausalityFromEvent(world, event, 'movement');

  return {
    ok: true,
    actorId,
    locationId: actor?.locationId || event.locationId,
  };
}

function handleEntityRested(world, event) {
  recordEventMemory(world, event, event.payload);
  recordCausalityFromEvent(world, event, 'recovery');
  return { ok: true };
}

function handleEntityWorked(world, event) {
  recordEventMemory(world, event, event.payload);
  recordCausalityFromEvent(world, event, 'labor');
  return { ok: true };
}

function handleResourceEvent(world, event) {
  recordEventMemory(world, event, event.payload);
  recordCausalityFromEvent(world, event, 'resource');
  return { ok: true };
}

function handleRelationshipEvent(world, event, options = {}) {
  const relationshipResults = applyEventRelationshipEffects(world, event);

  for (const item of relationshipResults) {
    if (options.propagateRelationships !== false) {
      propagateRelationship(world, item.fromId, item.toId, options.relationshipPropagationOptions || {});
    }
  }

  recordEventMemory(world, event, { relationshipResults });
  recordCausalityFromEvent(world, event, 'relationship');

  return { ok: true, relationshipResults };
}

function handleDamageEvent(world, event, options = {}) {
  const relationshipResults = applyEventRelationshipEffects(world, event);
  const [attackerId, targetId] = event.actorIds || [];
  const target = world.entities[targetId];
  const generatedEvents = [];

  if (target && target.status === 'dead') {
    generatedEvents.push({
      type: 'entity.dead',
      actorIds: [targetId],
      locationId: target.locationId,
      payload: {
        killerId: attackerId || null,
        sourceEventId: event.id,
      },
      tags: ['death'],
    });
  }

  if (attackerId && targetId) {
    const scores = scoreRelationship(world, targetId, attackerId);
    if (scores.hostility > 50) {
      generatedEvents.push({
        type: 'conflict.escalated',
        actorIds: [targetId, attackerId],
        locationId: event.locationId,
        payload: {
          hostility: scores.hostility,
          reason: 'damage_event',
        },
        tags: ['conflict'],
      });
    }
  }

  for (const item of relationshipResults) {
    if (options.propagateRelationships !== false) {
      propagateRelationship(world, item.fromId, item.toId, options.relationshipPropagationOptions || {});
    }
  }

  recordEventMemory(world, event, { relationshipResults, generatedEvents });
  recordCausalityFromEvent(world, event, 'damage');

  return { ok: true, relationshipResults, generatedEvents };
}

function scheduleRandomEvents(world, options = {}) {
  const generated = [];
  const chance = Number(options.chance || 0.03);
  const random = options.random || createRandomFunction(world, options.randomStream || 'events.random_incident');

  if (random() > chance) return generated;

  const aliveEntities = Object.values(world.entities)
    .filter(entity => entity.status === 'alive')
    .sort((left, right) => left.id.localeCompare(right.id));
  const locations = Object.values(world.locations)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (!aliveEntities.length || !locations.length) return generated;

  const actor = aliveEntities[Math.floor(random() * aliveEntities.length)];
  const location = world.locations[actor.locationId] || locations[Math.floor(random() * locations.length)];

  const event = emitGeneratedEvent(world, {
    type: 'world.random_incident',
    tick: world.tick,
    actorIds: [actor.id],
    locationId: location.id,
    correlationId: options.correlationId || null,
    payload: {
      danger: location.danger || 0,
      intensity: Math.round(random() * 100),
    },
    tags: ['random'],
  }, options);

  generated.push(event);
  return generated;
}

function emitGeneratedEvent(world, input, options = {}) {
  if (typeof options.emitEvent === 'function') return options.emitEvent(world, input);
  const id = input.id || nextEngineId(world, 'event');
  const event = createEvent({
    ...input,
    id,
    sequence: input.sequence ?? ensureEngineState(world).ids.total,
    tick: input.tick ?? world.tick,
    createdTick: input.createdTick ?? world.tick,
  });
  world.events.push(event);
  return event;
}

function recordEventMemory(world, event, payload = {}) {
  world.memory.push({
    id: `memory_${world.tick}_${world.memory.length + 1}`,
    tick: world.tick,
    type: `event.${event.type}`,
    payload: {
      eventId: event.id,
      actorIds: event.actorIds,
      locationId: event.locationId,
      ...payload,
    },
  });

  if (world.memory.length > 1000) world.memory.shift();
}

function recordCausalityFromEvent(world, event, type) {
  world.causality.push({
    id: `cause_${world.tick}_${world.causality.length + 1}`,
    tick: world.tick,
    type,
    sourceId: event.actorIds?.[0] || null,
    targetId: event.actorIds?.[1] || null,
    eventId: event.id,
    actionId: event.actionId || null,
    weight: Number(event.payload?.amount || event.payload?.intensity || 1),
    payload: {
      eventType: event.type,
      locationId: event.locationId,
      tags: event.tags || [],
    },
  });
}

function trimResolvedEvents(world, maxResolvedEvents) {
  const pending = world.events.filter(event => event.status === 'pending');
  const resolved = world.events.filter(event => event.status !== 'pending');
  const keptResolved = resolved.slice(Math.max(0, resolved.length - maxResolvedEvents));
  world.events = [...keptResolved, ...pending];
}

module.exports = {
  DEFAULT_EVENT_HANDLERS,
  processEvents,
  scheduleRandomEvents,
  emitGeneratedEvent,
  handleGenericEvent,
  handleEntityMoved,
  handleRelationshipEvent,
  handleDamageEvent,
  recordEventMemory,
  recordCausalityFromEvent,
};
