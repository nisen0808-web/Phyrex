'use strict';

const { changeEntityResource, changeEntityStat, recordMemory } = require('./world-engine');
const { getPlayerView, getActivePlayerCharacter } = require('./player-engine');
const { recordPlayerJournal, JOURNAL_TYPES } = require('./player-journal-engine');

const ENCOUNTER_STATUS = {
  RESOLVED: 'resolved',
};

const ENCOUNTER_TYPES = {
  RESOURCE_FIND: 'resource_find',
  QUIET_DISCOVERY: 'quiet_discovery',
  TRAINING_INSIGHT: 'training_insight',
  DANGER: 'danger',
  SOCIAL_TRACE: 'social_trace',
};

const DEFAULT_ENCOUNTER_OPTIONS = {
  resourceAmount: 3,
  dangerDamage: 4,
  maxEncountersPerPlayer: 300,
};

function ensureEncounterState(world) {
  if (!world.encounters) {
    world.encounters = {
      byId: {},
      byPlayer: {},
      stats: {
        created: 0,
        resolved: 0,
        pruned: 0,
      },
    };
  }
  return world.encounters;
}

function exploreLocation(world, playerId, options = {}) {
  const config = { ...DEFAULT_ENCOUNTER_OPTIONS, ...(options || {}) };
  const playerView = getPlayerView(world, playerId);
  const entity = getActivePlayerCharacter(world, playerId);
  if (!playerView || !entity) throw new Error(`Missing active player character for ${playerId}`);
  if (entity.status !== 'alive') throw new Error(`Player character is not alive: ${entity.id}`);
  const location = world.locations?.[entity.locationId];
  if (!location) throw new Error(`Missing location ${entity.locationId}`);

  const encounter = createEncounter(world, {
    playerId,
    entityId: entity.id,
    locationId: location.id,
    type: pickEncounterType(world, playerId, entity, location),
  });
  resolveEncounter(world, encounter.id, config);
  return encounter;
}

function createEncounter(world, input = {}) {
  const state = ensureEncounterState(world);
  const id = input.id || `encounter_${world.tick}_${input.playerId}_${Math.random().toString(16).slice(2)}`;
  const encounter = {
    id,
    playerId: input.playerId,
    entityId: input.entityId || null,
    locationId: input.locationId || null,
    type: input.type || ENCOUNTER_TYPES.QUIET_DISCOVERY,
    status: input.status || ENCOUNTER_STATUS.RESOLVED,
    title: input.title || input.type || 'encounter',
    summary: input.summary || '',
    createdAt: world.tick,
    resolvedAt: null,
    rewards: { resources: {}, stats: {}, ...(input.rewards || {}) },
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    payload: { ...(input.payload || {}) },
  };
  state.byId[id] = encounter;
  if (!state.byPlayer[encounter.playerId]) state.byPlayer[encounter.playerId] = [];
  state.byPlayer[encounter.playerId].push(id);
  state.stats.created += 1;
  trimPlayerEncounters(world, encounter.playerId, DEFAULT_ENCOUNTER_OPTIONS.maxEncountersPerPlayer);
  return encounter;
}

function resolveEncounter(world, encounterId, options = {}) {
  const encounter = getEncounter(world, encounterId);
  if (!encounter) return null;
  const entity = world.entities?.[encounter.entityId];
  const location = world.locations?.[encounter.locationId];
  const config = { ...DEFAULT_ENCOUNTER_OPTIONS, ...(options || {}) };

  if (encounter.type === ENCOUNTER_TYPES.RESOURCE_FIND) {
    const resource = pickLocationResource(location) || 'food';
    const amount = Math.max(1, Number(config.resourceAmount || 3) + deterministicNumber(encounter.id, 3));
    changeEntityResource(world, entity.id, resource, amount);
    encounter.title = 'Useful discovery';
    encounter.summary = `${entity.name} found ${amount} ${resource} while exploring ${location?.name || encounter.locationId}.`;
    encounter.rewards.resources[resource] = amount;
    encounter.tags.push('resource', resource);
  } else if (encounter.type === ENCOUNTER_TYPES.TRAINING_INSIGHT) {
    changeEntityStat(world, entity.id, 'power', 1);
    encounter.title = 'Training insight';
    encounter.summary = `${entity.name} gained a small combat insight while exploring.`;
    encounter.rewards.stats.power = 1;
    encounter.tags.push('training');
  } else if (encounter.type === ENCOUNTER_TYPES.DANGER) {
    const damage = Math.max(1, Number(config.dangerDamage || 4));
    entity.stats.health = Math.max(1, Number(entity.stats.health || 0) - damage);
    encounter.title = 'Minor danger';
    encounter.summary = `${entity.name} faced danger at ${location?.name || encounter.locationId} and lost ${damage} health.`;
    encounter.payload.damage = damage;
    encounter.tags.push('danger');
  } else if (encounter.type === ENCOUNTER_TYPES.SOCIAL_TRACE) {
    changeEntityResource(world, entity.id, 'rumor', 1);
    encounter.title = 'Traces of other people';
    encounter.summary = `${entity.name} found traces of other travelers and learned a rumor.`;
    encounter.rewards.resources.rumor = 1;
    encounter.tags.push('social', 'rumor');
  } else {
    changeEntityResource(world, entity.id, 'knowledge', 1);
    encounter.title = 'Quiet discovery';
    encounter.summary = `${entity.name} learned something about ${location?.name || encounter.locationId}.`;
    encounter.rewards.resources.knowledge = 1;
    encounter.tags.push('discovery');
  }

  encounter.status = ENCOUNTER_STATUS.RESOLVED;
  encounter.resolvedAt = world.tick;
  ensureEncounterState(world).stats.resolved += 1;
  recordPlayerJournal(world, encounter.playerId, {
    type: JOURNAL_TYPES.ENCOUNTER,
    title: encounter.title,
    summary: encounter.summary,
    locationId: encounter.locationId,
    entityId: encounter.entityId,
    tags: ['encounter', encounter.type, ...(encounter.tags || [])],
    payload: { encounterId: encounter.id, rewards: encounter.rewards },
  });
  recordMemory(world, { type: 'player.encounter.resolved', payload: { playerId: encounter.playerId, encounterId: encounter.id, type: encounter.type, locationId: encounter.locationId } });
  return encounter;
}

function getEncounter(world, encounterId) {
  return ensureEncounterState(world).byId[encounterId] || null;
}

function getPlayerEncounters(world, playerId, limit = 20) {
  const state = ensureEncounterState(world);
  return (state.byPlayer[playerId] || []).slice(-limit).map(id => state.byId[id]).filter(Boolean).reverse();
}

function getEncounterStats(world) {
  const state = ensureEncounterState(world);
  const encounters = Object.values(state.byId || {});
  return {
    total: encounters.length,
    byType: countBy(encounters.map(encounter => encounter.type)),
    stats: { ...state.stats },
  };
}

function formatEncounter(encounter) {
  if (!encounter) return 'No encounter.';
  const rewards = [];
  for (const [key, value] of Object.entries(encounter.rewards?.resources || {})) rewards.push(`${key}+${value}`);
  for (const [key, value] of Object.entries(encounter.rewards?.stats || {})) rewards.push(`${key}+${value}`);
  return [
    `${encounter.title} [${encounter.type}]`,
    encounter.summary,
    rewards.length ? `Rewards: ${rewards.join(', ')}` : 'Rewards: none',
  ].join('\n');
}

function trimPlayerEncounters(world, playerId, limit) {
  const state = ensureEncounterState(world);
  const ids = state.byPlayer[playerId] || [];
  if (ids.length <= limit) return [];
  const removed = ids.splice(0, ids.length - limit);
  for (const id of removed) delete state.byId[id];
  state.stats.pruned += removed.length;
  return removed;
}

function pickEncounterType(world, playerId, entity, location) {
  const types = [
    ENCOUNTER_TYPES.RESOURCE_FIND,
    ENCOUNTER_TYPES.QUIET_DISCOVERY,
    ENCOUNTER_TYPES.TRAINING_INSIGHT,
    ENCOUNTER_TYPES.SOCIAL_TRACE,
  ];
  if (Number(location?.danger || 0) > 0 || Object.keys(location?.resources || {}).includes('danger')) types.push(ENCOUNTER_TYPES.DANGER);
  const index = deterministicNumber(`${world.tick}:${playerId}:${entity.id}:${location?.id}`, types.length);
  return types[index];
}

function pickLocationResource(location) {
  const resources = Object.entries(location?.resources || {}).filter(([, value]) => Number(value || 0) > 0).map(([key]) => key);
  return resources[0] || null;
}

function deterministicNumber(text, max) {
  let hash = 0;
  for (const ch of String(text || '')) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return Math.abs(hash) % Math.max(1, max);
}

function countBy(values) {
  const out = {};
  for (const value of values || []) {
    const key = value === undefined || value === null ? 'unknown' : String(value);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

module.exports = {
  ENCOUNTER_STATUS,
  ENCOUNTER_TYPES,
  DEFAULT_ENCOUNTER_OPTIONS,
  ensureEncounterState,
  exploreLocation,
  createEncounter,
  resolveEncounter,
  getEncounter,
  getPlayerEncounters,
  getEncounterStats,
  formatEncounter,
};
