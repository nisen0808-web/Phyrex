'use strict';

const { ENTITY_STATUS, EVENT_STATUS } = require('./schema');
const { ensureEngineState } = require('./engine-state-engine');
const { ensureRandomState } = require('./deterministic-rng-engine');

const INTEGRITY_VERSION = 1;
const DEFAULT_INTEGRITY_OPTIONS = {
  maxIssues: 1000,
  strictReferences: true,
  checkIndexes: true,
  checkNeighborSymmetry: true,
};

function validateWorldState(world, options = {}) {
  const config = { ...DEFAULT_INTEGRITY_OPTIONS, ...(options || {}) };
  const errors = [];
  const warnings = [];
  const push = (severity, code, path, message, value) => {
    const target = severity === 'error' ? errors : warnings;
    if (errors.length + warnings.length >= config.maxIssues) return;
    target.push({ severity, code, path, message, value: safeValue(value) });
  };

  if (!world || typeof world !== 'object' || Array.isArray(world)) {
    push('error', 'world_invalid', '$', 'World must be an object', world);
    return createReport(world, errors, warnings);
  }

  if (!world.id || typeof world.id !== 'string') push('error', 'world_id_invalid', 'id', 'World requires string id', world.id);
  if (!Number.isInteger(Number(world.tick)) || Number(world.tick) < 0) {
    push('error', 'world_tick_invalid', 'tick', 'World tick must be a non-negative integer', world.tick);
  }
  if (world.seed === undefined || world.seed === null) push('error', 'world_seed_missing', 'seed', 'World seed is required', world.seed);
  validateCalendar(world.calendar, push);

  const entities = ensureObjectContainer(world.entities, 'entities', push);
  const locations = ensureObjectContainer(world.locations, 'locations', push);
  const factions = ensureObjectContainer(world.factions, 'factions', push);

  validateLocations(locations, push, config);
  validateFactions(factions, locations, push, config);
  validateEntities(entities, locations, factions, push, config);
  validateActionQueue(world.actionQueue, entities, locations, factions, push, config);
  validateEvents(world.events, entities, locations, factions, push, config);
  validateRelationships(world.relationships, entities, push, config);
  if (config.checkIndexes) validateIndexes(world.indexes, entities, locations, factions, push);
  validateEngineState(world.engine, push);

  return createReport(world, errors, warnings);
}

function assertWorldIntegrity(world, options = {}) {
  const report = validateWorldState(world, options);
  if (report.ok) return report;
  const preview = report.errors.slice(0, 5).map(issue => `${issue.path}:${issue.code}`).join(', ');
  const error = new Error(`World integrity failed with ${report.errors.length} error(s): ${preview}`);
  error.code = 'world_integrity_failed';
  error.report = report;
  throw error;
}

function repairWorldState(world, options = {}) {
  if (!world || typeof world !== 'object') throw new Error('repairWorldState requires world');
  if (!world.entities || typeof world.entities !== 'object') world.entities = {};
  if (!world.locations || typeof world.locations !== 'object') world.locations = {};
  if (!world.factions || typeof world.factions !== 'object') world.factions = {};
  if (!Array.isArray(world.actionQueue)) world.actionQueue = [];
  if (!Array.isArray(world.events)) world.events = [];
  if (!world.relationships || typeof world.relationships !== 'object') world.relationships = {};
  if (!world.indexes || typeof world.indexes !== 'object') world.indexes = {};

  for (const [locationId, location] of Object.entries(world.locations)) {
    if (!location || typeof location !== 'object') {
      if (options.removeInvalid !== false) delete world.locations[locationId];
      continue;
    }
    location.id = location.id || locationId;
    const neighbors = Array.isArray(location.neighbors) ? location.neighbors.map(String) : [];
    location.neighbors = [...new Set(neighbors)].filter(id => (
      id !== locationId && (options.removeDanglingReferences !== true || Boolean(world.locations[id]))
    )).sort();
  }

  for (const [entityId, entity] of Object.entries(world.entities)) {
    if (!entity || typeof entity !== 'object') {
      if (options.removeInvalid !== false) delete world.entities[entityId];
      continue;
    }
    entity.id = entity.id || entityId;
    if (!entity.stats || typeof entity.stats !== 'object') entity.stats = {};
    if (!entity.resources || typeof entity.resources !== 'object') entity.resources = {};
    if (!Array.isArray(entity.tags)) entity.tags = [];
    if (!Array.isArray(entity.inventory)) entity.inventory = [];
  }

  rebuildCoreIndexes(world);
  ensureEngineState(world);
  ensureRandomState(world);
  const report = validateWorldState(world, options);
  return { world, report };
}

function rebuildCoreIndexes(world) {
  world.indexes = world.indexes || {};
  world.indexes.entitiesByLocation = {};
  world.indexes.entitiesByFaction = {};
  for (const locationId of Object.keys(world.locations || {})) world.indexes.entitiesByLocation[locationId] = [];
  for (const factionId of Object.keys(world.factions || {})) world.indexes.entitiesByFaction[factionId] = [];
  for (const entity of Object.values(world.entities || {})) {
    if (entity.locationId && world.indexes.entitiesByLocation[entity.locationId]) {
      world.indexes.entitiesByLocation[entity.locationId].push(entity.id);
    }
    if (entity.factionId && world.indexes.entitiesByFaction[entity.factionId]) {
      world.indexes.entitiesByFaction[entity.factionId].push(entity.id);
    }
  }
  for (const values of Object.values(world.indexes.entitiesByLocation)) values.sort();
  for (const values of Object.values(world.indexes.entitiesByFaction)) values.sort();
  return world.indexes;
}

function validateCalendar(calendar, push) {
  if (!calendar || typeof calendar !== 'object') {
    push('error', 'calendar_missing', 'calendar', 'Calendar is required', calendar);
    return;
  }
  for (const key of ['year', 'season', 'day', 'daysPerSeason', 'seasonsPerYear']) {
    if (!Number.isFinite(Number(calendar[key]))) {
      push('error', 'calendar_number_invalid', `calendar.${key}`, `${key} must be finite`, calendar[key]);
    }
  }
  if (!['day', 'night'].includes(calendar.phase)) {
    push('error', 'calendar_phase_invalid', 'calendar.phase', 'Calendar phase must be day or night', calendar.phase);
  }
  if (Number(calendar.daysPerSeason) <= 0) push('error', 'calendar_days_invalid', 'calendar.daysPerSeason', 'daysPerSeason must be positive', calendar.daysPerSeason);
  if (Number(calendar.seasonsPerYear) <= 0) push('error', 'calendar_seasons_invalid', 'calendar.seasonsPerYear', 'seasonsPerYear must be positive', calendar.seasonsPerYear);
}

function validateLocations(locations, push, config) {
  for (const [key, location] of Object.entries(locations)) {
    const path = `locations.${key}`;
    if (!location || typeof location !== 'object') {
      push('error', 'location_invalid', path, 'Location must be an object', location);
      continue;
    }
    if (location.id !== key) push('error', 'location_id_mismatch', `${path}.id`, 'Location id must match map key', location.id);
    if (!Array.isArray(location.neighbors)) {
      push('error', 'location_neighbors_invalid', `${path}.neighbors`, 'Location neighbors must be an array', location.neighbors);
      continue;
    }
    const duplicates = duplicatesOf(location.neighbors);
    if (duplicates.length) push('warning', 'location_neighbors_duplicate', `${path}.neighbors`, 'Location contains duplicate neighbors', duplicates);
    for (const neighborId of location.neighbors) {
      if (!locations[neighborId]) {
        push(config.strictReferences ? 'error' : 'warning', 'location_neighbor_missing', `${path}.neighbors`, `Missing neighbor ${neighborId}`, neighborId);
      } else if (config.checkNeighborSymmetry && !locations[neighborId].neighbors?.includes(key)) {
        push('warning', 'location_neighbor_asymmetric', `${path}.neighbors`, `Neighbor ${neighborId} does not link back`, neighborId);
      }
    }
    validateFiniteMap(location.resources, `${path}.resources`, push);
  }
}

function validateFactions(factions, locations, push, config) {
  for (const [key, faction] of Object.entries(factions)) {
    const path = `factions.${key}`;
    if (!faction || typeof faction !== 'object') {
      push('error', 'faction_invalid', path, 'Faction must be an object', faction);
      continue;
    }
    if (faction.id !== key) push('error', 'faction_id_mismatch', `${path}.id`, 'Faction id must match map key', faction.id);
    if (faction.homeLocationId && !locations[faction.homeLocationId]) {
      push(config.strictReferences ? 'error' : 'warning', 'faction_home_missing', `${path}.homeLocationId`, 'Faction home location is missing', faction.homeLocationId);
    }
    validateFiniteMap(faction.resources, `${path}.resources`, push);
  }
}

function validateEntities(entities, locations, factions, push, config) {
  for (const [key, entity] of Object.entries(entities)) {
    const path = `entities.${key}`;
    if (!entity || typeof entity !== 'object') {
      push('error', 'entity_invalid', path, 'Entity must be an object', entity);
      continue;
    }
    if (entity.id !== key) push('error', 'entity_id_mismatch', `${path}.id`, 'Entity id must match map key', entity.id);
    if (!ENTITY_STATUS.includes(entity.status)) push('error', 'entity_status_invalid', `${path}.status`, 'Entity status is invalid', entity.status);
    if (entity.locationId && !locations[entity.locationId]) {
      push(config.strictReferences ? 'error' : 'warning', 'entity_location_missing', `${path}.locationId`, 'Entity location is missing', entity.locationId);
    }
    if (entity.factionId && !factions[entity.factionId]) {
      push(config.strictReferences ? 'error' : 'warning', 'entity_faction_missing', `${path}.factionId`, 'Entity faction is missing', entity.factionId);
    }
    validateFiniteMap(entity.stats, `${path}.stats`, push);
    validateFiniteMap(entity.resources, `${path}.resources`, push);
    if (entity.demographics?.childrenIds) {
      for (const childId of entity.demographics.childrenIds) {
        if (!entities[childId]) push('warning', 'entity_child_missing', `${path}.demographics.childrenIds`, 'Child entity is missing', childId);
      }
    }
  }
}

function validateActionQueue(queue, entities, locations, factions, push, config) {
  if (!Array.isArray(queue)) {
    push('error', 'action_queue_invalid', 'actionQueue', 'Action queue must be an array', queue);
    return;
  }
  const ids = new Set();
  queue.forEach((action, index) => {
    const path = `actionQueue[${index}]`;
    if (!action || typeof action !== 'object') return push('error', 'action_invalid', path, 'Action must be an object', action);
    if (!action.id) push('error', 'action_id_missing', `${path}.id`, 'Action requires id', action.id);
    else if (ids.has(action.id)) push('error', 'action_id_duplicate', `${path}.id`, 'Action id must be unique', action.id);
    else ids.add(action.id);
    if (!action.type) push('error', 'action_type_missing', `${path}.type`, 'Action requires type', action.type);
    if (action.actorId && !entities[action.actorId]) push(config.strictReferences ? 'error' : 'warning', 'action_actor_missing', `${path}.actorId`, 'Action actor is missing', action.actorId);
    if (action.locationId && !locations[action.locationId]) push(config.strictReferences ? 'error' : 'warning', 'action_location_missing', `${path}.locationId`, 'Action location is missing', action.locationId);
    if (action.targetId && !entities[action.targetId] && !locations[action.targetId] && !factions[action.targetId]) {
      push(config.strictReferences ? 'error' : 'warning', 'action_target_missing', `${path}.targetId`, 'Action target is missing', action.targetId);
    }
  });
}

function validateEvents(events, entities, locations, factions, push, config) {
  if (!Array.isArray(events)) {
    push('error', 'events_invalid', 'events', 'Events must be an array', events);
    return;
  }
  const ids = new Set();
  events.forEach((event, index) => {
    const path = `events[${index}]`;
    if (!event || typeof event !== 'object') return push('error', 'event_invalid', path, 'Event must be an object', event);
    if (!event.id) push('error', 'event_id_missing', `${path}.id`, 'Event requires id', event.id);
    else if (ids.has(event.id)) push('error', 'event_id_duplicate', `${path}.id`, 'Event id must be unique', event.id);
    else ids.add(event.id);
    if (!event.type) push('error', 'event_type_missing', `${path}.type`, 'Event requires type', event.type);
    if (!EVENT_STATUS.includes(event.status)) push('error', 'event_status_invalid', `${path}.status`, 'Event status is invalid', event.status);
    if (event.locationId && !locations[event.locationId]) push(config.strictReferences ? 'error' : 'warning', 'event_location_missing', `${path}.locationId`, 'Event location is missing', event.locationId);
    for (const entityId of event.actorIds || []) {
      if (!entities[entityId]) push('warning', 'event_actor_missing', `${path}.actorIds`, 'Event actor is missing', entityId);
    }
    for (const factionId of event.factionIds || []) {
      if (!factions[factionId]) push('warning', 'event_faction_missing', `${path}.factionIds`, 'Event faction is missing', factionId);
    }
  });
}

function validateRelationships(relationships, entities, push, config) {
  if (!relationships || typeof relationships !== 'object') {
    push('error', 'relationships_invalid', 'relationships', 'Relationships must be an object', relationships);
    return;
  }
  for (const [key, relation] of Object.entries(relationships)) {
    const [fromId, toId] = key.split('->');
    if (!fromId || !toId) push('warning', 'relationship_key_invalid', `relationships.${key}`, 'Relationship key should use from->to', key);
    if (fromId && !entities[fromId]) push(config.strictReferences ? 'error' : 'warning', 'relationship_from_missing', `relationships.${key}`, 'Relationship source is missing', fromId);
    if (toId && !entities[toId]) push(config.strictReferences ? 'error' : 'warning', 'relationship_to_missing', `relationships.${key}`, 'Relationship target is missing', toId);
    validateFiniteMap(relation, `relationships.${key}`, push);
  }
}

function validateIndexes(indexes, entities, locations, factions, push) {
  if (!indexes || typeof indexes !== 'object') {
    push('error', 'indexes_invalid', 'indexes', 'Indexes must be an object', indexes);
    return;
  }
  const expectedLocations = Object.fromEntries(Object.keys(locations).map(id => [id, []]));
  const expectedFactions = Object.fromEntries(Object.keys(factions).map(id => [id, []]));
  for (const entity of Object.values(entities)) {
    if (entity.locationId && expectedLocations[entity.locationId]) expectedLocations[entity.locationId].push(entity.id);
    if (entity.factionId && expectedFactions[entity.factionId]) expectedFactions[entity.factionId].push(entity.id);
  }
  compareIndex(indexes.entitiesByLocation, expectedLocations, 'indexes.entitiesByLocation', push);
  compareIndex(indexes.entitiesByFaction, expectedFactions, 'indexes.entitiesByFaction', push);
}

function validateEngineState(engine, push) {
  if (engine === undefined || engine === null) return;
  if (typeof engine !== 'object' || Array.isArray(engine)) {
    push('error', 'engine_state_invalid', 'engine', 'Engine state must be an object', engine);
    return;
  }
  if (engine.ids && (!engine.ids.byNamespace || typeof engine.ids.byNamespace !== 'object')) {
    push('error', 'engine_ids_invalid', 'engine.ids', 'Engine id state is invalid', engine.ids);
  }
  for (const [streamId, stream] of Object.entries(engine.random?.streams || {})) {
    if (!Array.isArray(stream.state) || stream.state.length !== 4 || stream.state.some(value => !Number.isInteger(Number(value)))) {
      push('error', 'rng_stream_invalid', `engine.random.streams.${streamId}`, 'RNG stream must contain four integer words', stream.state);
    }
  }
}

function compareIndex(actual, expected, path, push) {
  if (!actual || typeof actual !== 'object') {
    push('error', 'index_missing', path, 'Index is missing', actual);
    return;
  }
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) {
    const left = [...new Set(actual[key] || [])].sort();
    const right = [...new Set(expected[key] || [])].sort();
    if (left.join('\u0000') !== right.join('\u0000')) {
      push('error', 'index_mismatch', `${path}.${key}`, 'Index does not match entities', { actual: left, expected: right });
    }
  }
}

function validateFiniteMap(value, path, push) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    push('error', 'numeric_map_invalid', path, 'Expected an object containing numeric values', value);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (!Number.isFinite(Number(item))) push('error', 'number_not_finite', `${path}.${key}`, 'Value must be finite', item);
  }
}

function ensureObjectContainer(value, path, push) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    push('error', 'container_invalid', path, `${path} must be an object`, value);
    return {};
  }
  return value;
}

function duplicatesOf(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values || []) {
    if (seen.has(value)) duplicates.add(value);
    else seen.add(value);
  }
  return [...duplicates];
}

function createReport(world, errors, warnings) {
  return {
    version: INTEGRITY_VERSION,
    ok: errors.length === 0,
    worldId: world?.id || null,
    tick: Number(world?.tick || 0),
    errors,
    warnings,
    counts: { errors: errors.length, warnings: warnings.length },
  };
}

function safeValue(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); }
  catch (_error) { return String(value); }
}

module.exports = {
  INTEGRITY_VERSION,
  DEFAULT_INTEGRITY_OPTIONS,
  validateWorldState,
  assertWorldIntegrity,
  repairWorldState,
  rebuildCoreIndexes,
};
