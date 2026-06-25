'use strict';

const { nextTransientId } = require('./world-id-engine');

const DEFAULT_WORLD_OPTIONS = {
  id: 'world',
  seed: 1,
  tick: 0,
  calendar: {
    year: 1,
    season: 0,
    day: 1,
    phase: 'day',
    daysPerSeason: 90,
    seasonsPerYear: 4,
  },
};

const RELATION_KEYS = ['affection', 'trust', 'fear', 'hatred', 'debt', 'loyalty'];
const ENTITY_STATUS = ['alive', 'dead', 'missing', 'inactive'];
const EVENT_STATUS = ['pending', 'resolved', 'cancelled'];

function createWorldState(options = {}) {
  const merged = deepMerge(DEFAULT_WORLD_OPTIONS, options);
  return {
    id: merged.id,
    version: 1,
    seed: merged.seed,
    tick: merged.tick,
    calendar: { ...merged.calendar },
    entities: {},
    locations: {},
    factions: {},
    resources: {},
    relationships: {},
    events: [],
    causality: [],
    memory: [],
    actionQueue: [],
    indexes: {
      entitiesByLocation: {},
      entitiesByFaction: {},
    },
  };
}

function createEntity(input = {}) {
  if (!input.id) throw new Error('Entity requires id');
  return {
    id: input.id,
    type: input.type || 'agent',
    name: input.name || input.id,
    status: input.status || 'alive',
    locationId: input.locationId || null,
    factionId: input.factionId || null,
    traits: { ...(input.traits || {}) },
    stats: {
      health: 100,
      maxHealth: 100,
      energy: 100,
      maxEnergy: 100,
      power: 10,
      defense: 5,
      speed: 10,
      intelligence: 10,
      social: 10,
      ...(input.stats || {}),
    },
    resources: { ...(input.resources || {}) },
    inventory: Array.isArray(input.inventory) ? [...input.inventory] : [],
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    memory: [],
    cooldowns: {},
    demographics: {
      birthTick: input.demographics?.birthTick ?? 0,
      deathTick: input.demographics?.deathTick ?? null,
      age: input.demographics?.age ?? input.meta?.age ?? 0,
      ageGroup: input.demographics?.ageGroup || 'adult',
      sex: input.demographics?.sex || null,
      generation: input.demographics?.generation ?? 1,
      fatherId: input.demographics?.fatherId || null,
      motherId: input.demographics?.motherId || null,
      childrenIds: Array.isArray(input.demographics?.childrenIds) ? [...input.demographics.childrenIds] : [],
      fertility: input.demographics?.fertility ?? 1,
      lifeExpectancy: input.demographics?.lifeExpectancy || null,
      familyId: input.demographics?.familyId || input.familyId || null,
      ...(input.demographics || {}),
    },
    meta: { ...(input.meta || {}) },
  };
}

function createLocation(input = {}) {
  if (!input.id) throw new Error('Location requires id');
  return {
    id: input.id,
    type: input.type || 'location',
    name: input.name || input.id,
    regionId: input.regionId || null,
    neighbors: Array.isArray(input.neighbors) ? [...input.neighbors] : [],
    traits: { ...(input.traits || {}) },
    resources: { ...(input.resources || {}) },
    danger: Number(input.danger || 0),
    capacity: input.capacity || null,
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    meta: { ...(input.meta || {}) },
  };
}

function createFaction(input = {}) {
  if (!input.id) throw new Error('Faction requires id');
  return {
    id: input.id,
    type: input.type || 'faction',
    name: input.name || input.id,
    homeLocationId: input.homeLocationId || null,
    resources: { ...(input.resources || {}) },
    reputation: Number(input.reputation || 0),
    policies: { ...(input.policies || {}) },
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    meta: { ...(input.meta || {}) },
  };
}

function createEvent(input = {}) {
  if (!input.type) throw new Error('Event requires type');
  return {
    id: input.id || nextTransientId('event'),
    type: input.type,
    status: input.status || 'pending',
    tick: input.tick || 0,
    actorIds: Array.isArray(input.actorIds) ? [...input.actorIds] : [],
    locationId: input.locationId || null,
    factionIds: Array.isArray(input.factionIds) ? [...input.factionIds] : [],
    payload: { ...(input.payload || {}) },
    effects: Array.isArray(input.effects) ? [...input.effects] : [],
    causeIds: Array.isArray(input.causeIds) ? [...input.causeIds] : [],
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
  };
}

function createAction(input = {}) {
  if (!input.type) throw new Error('Action requires type');
  return {
    id: input.id || nextTransientId('action'),
    type: input.type,
    actorId: input.actorId || null,
    targetId: input.targetId || null,
    locationId: input.locationId || null,
    duration: Math.max(1, Number(input.duration || 1)),
    remaining: Math.max(1, Number(input.remaining || input.duration || 1)),
    priority: Number(input.priority || 0),
    payload: { ...(input.payload || {}) },
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
  };
}

function relationKey(a, b) {
  return `${a}->${b}`;
}

function createRelationship(input = {}) {
  const value = {};
  for (const key of RELATION_KEYS) value[key] = Number(input[key] || 0);
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

module.exports = {
  DEFAULT_WORLD_OPTIONS,
  RELATION_KEYS,
  ENTITY_STATUS,
  EVENT_STATUS,
  createWorldState,
  createEntity,
  createLocation,
  createFaction,
  createEvent,
  createAction,
  createRelationship,
  relationKey,
  clone,
  clamp,
};
