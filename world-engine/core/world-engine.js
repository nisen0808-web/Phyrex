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

function createWorld(options = {}) {
  return createWorldState(options);
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
  const action = createAction(input);
  world.actionQueue.push(action);
  world.actionQueue.sort((a, b) => b.priority - a.priority);
  return action;
}

function emitEvent(world, input) {
  const event = createEvent({ ...input, tick: input.tick ?? world.tick });
  world.events.push(event);
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
  world.tick += 1;
  advanceCalendar(world);

  const actionReport = processActionQueue(world, options);
  const eventReport = processEvents(world, options);
  rebuildIndexes(world);
  rebuildRelationshipIndexes(world);

  const report = {
    tick: world.tick,
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

  return report;
}

function processActionQueue(world, options = {}) {
  const completed = [];
  const active = [];
  const failed = [];
  const actionOptions = { ...options, emitEvent };

  for (const action of world.actionQueue) {
    const result = applyActionTick(world, action, actionOptions);
    if (result.status === 'completed') completed.push(result);
    else if (result.status === 'failed') failed.push(result);
    else active.push(action);
  }

  world.actionQueue = active;
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
    id: input.id || `cause_${world.tick}_${world.causality.length + 1}`,
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
    id: input.id || `memory_${world.tick}_${world.memory.length + 1}`,
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
    }
  }

  if (entity.factionId) {
    if (!world.indexes.entitiesByFaction[entity.factionId]) {
      world.indexes.entitiesByFaction[entity.factionId] = [];
    }
    if (!world.indexes.entitiesByFaction[entity.factionId].includes(entity.id)) {
      world.indexes.entitiesByFaction[entity.factionId].push(entity.id);
    }
  }
}

function rebuildIndexes(world) {
  world.indexes.entitiesByLocation = {};
  world.indexes.entitiesByFaction = {};

  for (const locationId of Object.keys(world.locations)) {
    world.indexes.entitiesByLocation[locationId] = [];
  }
  for (const factionId of Object.keys(world.factions)) {
    world.indexes.entitiesByFaction[factionId] = [];
  }

  for (const entity of Object.values(world.entities)) {
    indexEntity(world, entity);
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
};
