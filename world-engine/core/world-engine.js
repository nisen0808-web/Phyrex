'use strict';

const {
  createWorldState,
  createEntity,
  createLocation,
  createFaction,
  createEvent,
  createAction,
  clone,
} = require('./schema');

const { applyActionTick } = require('./action-engine');
const { processEvents } = require('./event-engine');
const { rebuildRelationshipIndexes } = require('./relationship-engine');
const {
  ensureEngineState,
  nextEngineSequence,
  nextEngineId,
} = require('./engine-state-engine');
const { ensureRandomState } = require('./deterministic-rng-engine');
const { appendTrace } = require('./engine-trace-engine');

function createWorld(options = {}) {
  const world = createWorldState(options);
  ensureEngineState(world);
  ensureRandomState(world);
  return world;
}

function registerEntity(world, input) {
  const entity = createEntity(input);
  world.entities[entity.id] = entity;
  indexEntity(world, entity);
  recordMemory(world, {
    type: 'entity.registered',
    entityId: entity.id,
    tick: world.tick,
  });
  return entity;
}

function registerLocation(world, input) {
  const location = createLocation(input);
  world.locations[location.id] = location;
  if (!world.indexes.entitiesByLocation[location.id]) {
    world.indexes.entitiesByLocation[location.id] = [];
  }
  return location;
}

function connectLocations(world, a, b) {
  const locA = world.locations[a];
  const locB = world.locations[b];
  if (!locA || !locB) throw new Error('Cannot connect missing locations');
  if (!locA.neighbors.includes(b)) locA.neighbors.push(b);
  if (!locB.neighbors.includes(a)) locB.neighbors.push(a);
  locA.neighbors.sort();
  locB.neighbors.sort();
}

function registerFaction(world, input) {
  const faction = createFaction(input);
  world.factions[faction.id] = faction;
  if (!world.indexes.entitiesByFaction[faction.id]) {
    world.indexes.entitiesByFaction[faction.id] = [];
  }
  return faction;
}

function enqueueAction(world, input) {
  const normalized = withDeterministicIdentity(world, input, 'action');
  const action = createAction({
    ...normalized,
    createdTick: normalized.createdTick ?? world.tick,
  });
  world.actionQueue.push(action);
  world.actionQueue.sort(compareActions);
  appendTrace(world, {
    type: 'action.enqueued',
    phase: 'world',
    correlationId: action.correlationId,
    parentId: action.causationId,
    payload: {
      actionId: action.id,
      actionType: action.type,
      actorId: action.actorId,
      priority: action.priority,
      sequence: action.sequence,
    },
  });
  return action;
}

function emitEvent(world, input) {
  const normalized = withDeterministicIdentity(world, input, 'event');
  const event = createEvent({
    ...normalized,
    tick: normalized.tick ?? world.tick,
    createdTick: normalized.createdTick ?? world.tick,
  });
  world.events.push(event);
  appendTrace(world, {
    type: 'event.emitted',
    phase: 'world',
    correlationId: event.correlationId,
    parentId: event.causationId || event.actionId,
    payload: {
      eventId: event.id,
      eventType: event.type,
      actionId: event.actionId,
      sequence: event.sequence,
    },
  });
  return event;
}

function advanceWorld(world, ticks = 1, options = {}) {
  const reports = [];
  for (let i = 0; i < ticks; i += 1) {
    reports.push(advanceOneTick(world, options));
  }
  return reports;
}

function advanceOneTick(world, options = {}) {
  ensureEngineState(world);
  ensureRandomState(world);
  const correlationId = options.correlationId || nextEngineId(world, 'tick');
  world.tick += 1;
  advanceCalendar(world);

  appendTrace(world, {
    type: 'world.tick.started',
    phase: 'world',
    correlationId,
    tick: world.tick,
    payload: { tick: world.tick },
  });

  const engineOptions = { ...options, emitEvent, correlationId };
  const actionReport = processActionQueue(world, engineOptions);
  const eventReport = processEvents(world, engineOptions);
  rebuildIndexes(world);
  rebuildRelationshipIndexes(world);

  const report = {
    tick: world.tick,
    correlationId,
    calendar: clone(world.calendar),
    actions: actionReport,
    events: eventReport,
  };

  if (options.recordReports !== false) {
    recordMemory(world, {
      type: 'world.tick',
      tick: world.tick,
      report,
    });
  }

  appendTrace(world, {
    type: 'world.tick.completed',
    phase: 'world',
    correlationId,
    tick: world.tick,
    payload: {
      tick: world.tick,
      completedActions: actionReport.completed.length,
      failedActions: actionReport.failed.length,
      processedEvents: eventReport.processed.length,
      generatedEvents: eventReport.generated.length,
    },
  });

  return report;
}

function processActionQueue(world, options = {}) {
  const completed = [];
  const active = [];
  const failed = [];
  const actionOptions = { ...options, emitEvent };

  world.actionQueue.sort(compareActions);
  for (const action of world.actionQueue) {
    const result = applyActionTick(world, action, actionOptions);
    if (result.status === 'completed') completed.push(result);
    else if (result.status === 'failed') failed.push(result);
    else active.push(action);
  }

  world.actionQueue = active.sort(compareActions);
  return { completed, failed, activeCount: active.length };
}

function advanceCalendar(world) {
  const calendar = world.calendar;
  if (calendar.phase === 'day') {
    calendar.phase = 'night';
    return;
  }

  calendar.phase = 'day';
  calendar.day += 1;

  if (calendar.day > calendar.daysPerSeason) {
    calendar.day = 1;
    calendar.season += 1;
  }

  if (calendar.season >= calendar.seasonsPerYear) {
    calendar.season = 0;
    calendar.year += 1;
  }
}

function moveEntity(world, entityId, locationId) {
  const entity = world.entities[entityId];
  if (!entity) throw new Error(`Missing entity ${entityId}`);
  if (!world.locations[locationId]) throw new Error(`Missing location ${locationId}`);
  const from = entity.locationId;
  entity.locationId = locationId;
  rebuildIndexes(world);
  emitEvent(world, {
    type: 'entity.moved',
    actorIds: [entityId],
    locationId,
    payload: { from, to: locationId },
  });
  return entity;
}

function changeEntityResource(world, entityId, resourceKey, delta) {
  const entity = world.entities[entityId];
  if (!entity) throw new Error(`Missing entity ${entityId}`);
  const current = Number(entity.resources[resourceKey] || 0);
  entity.resources[resourceKey] = current + Number(delta || 0);
  return entity.resources[resourceKey];
}

function changeEntityStat(world, entityId, statKey, delta) {
  const entity = world.entities[entityId];
  if (!entity) throw new Error(`Missing entity ${entityId}`);
  const current = Number(entity.stats[statKey] || 0);
  entity.stats[statKey] = current + Number(delta || 0);
  return entity.stats[statKey];
}

function recordCausality(world, input) {
  const record = {
    id: input.id || nextEngineId(world, 'cause'),
    tick: world.tick,
    type: input.type,
    sourceId: input.sourceId || null,
    targetId: input.targetId || null,
    eventId: input.eventId || null,
    actionId: input.actionId || null,
    weight: Number(input.weight || 1),
    payload: { ...(input.payload || {}) },
  };
  world.causality.push(record);
  return record;
}

function recordMemory(world, input) {
  const memory = {
    id: input.id || nextEngineId(world, 'memory'),
    tick: input.tick ?? world.tick,
    type: input.type,
    payload: input.payload || input,
  };
  world.memory.push(memory);
  if (world.memory.length > 1000) world.memory.shift();
  return memory;
}

function indexEntity(world, entity) {
  if (entity.locationId) {
    if (!world.indexes.entitiesByLocation[entity.locationId]) {
      world.indexes.entitiesByLocation[entity.locationId] = [];
    }
    if (!world.indexes.entitiesByLocation[entity.locationId].includes(entity.id)) {
      world.indexes.entitiesByLocation[entity.locationId].push(entity.id);
      world.indexes.entitiesByLocation[entity.locationId].sort();
    }
  }

  if (entity.factionId) {
    if (!world.indexes.entitiesByFaction[entity.factionId]) {
      world.indexes.entitiesByFaction[entity.factionId] = [];
    }
    if (!world.indexes.entitiesByFaction[entity.factionId].includes(entity.id)) {
      world.indexes.entitiesByFaction[entity.factionId].push(entity.id);
      world.indexes.entitiesByFaction[entity.factionId].sort();
    }
  }
}

function rebuildIndexes(world) {
  world.indexes.entitiesByLocation = {};
  world.indexes.entitiesByFaction = {};

  for (const locationId of Object.keys(world.locations).sort()) {
    world.indexes.entitiesByLocation[locationId] = [];
  }
  for (const factionId of Object.keys(world.factions).sort()) {
    world.indexes.entitiesByFaction[factionId] = [];
  }

  for (const entityId of Object.keys(world.entities).sort()) {
    indexEntity(world, world.entities[entityId]);
  }
}

function getEntitiesAt(world, locationId) {
  return (world.indexes.entitiesByLocation[locationId] || [])
    .map(id => world.entities[id])
    .filter(Boolean);
}

function getFactionMembers(world, factionId) {
  return (world.indexes.entitiesByFaction[factionId] || [])
    .map(id => world.entities[id])
    .filter(Boolean);
}

function withDeterministicIdentity(world, input, namespace) {
  const value = { ...(input || {}) };
  if (!value.id) {
    value.id = nextEngineId(world, namespace);
    value.sequence = value.sequence ?? ensureEngineState(world).ids.total;
  } else if (value.sequence === undefined || value.sequence === null) {
    value.sequence = nextEngineSequence(world);
  }
  return value;
}

function compareActions(left, right) {
  const priority = Number(right.priority || 0) - Number(left.priority || 0);
  if (priority) return priority;
  const sequence = Number(left.sequence || 0) - Number(right.sequence || 0);
  if (sequence) return sequence;
  return String(left.id || '').localeCompare(String(right.id || ''));
}

module.exports = {
  createWorld,
  registerEntity,
  registerLocation,
  connectLocations,
  registerFaction,
  enqueueAction,
  emitEvent,
  advanceWorld,
  advanceOneTick,
  moveEntity,
  changeEntityResource,
  changeEntityStat,
  recordCausality,
  recordMemory,
  rebuildIndexes,
  getEntitiesAt,
  getFactionMembers,
  compareActions,
};
