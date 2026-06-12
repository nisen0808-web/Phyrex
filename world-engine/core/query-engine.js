'use strict';

const { createWorldSnapshot } = require('./snapshot-engine');
const { getPlayerView } = require('./player-engine');
const { getPlayerCommands, getCommandStats } = require('./command-engine');
const { getOrganizationChronicle } = require('./organization-engine');
const { getCivilizationChronicle } = require('./civilization-engine');
const { getKnownInformation } = require('./information-engine');
const { getMemories } = require('./memory-engine');
const { createPlayerMap, createLocationMap, listWorldLocations } = require('./map-engine');
const { getPlayerQuests, getQuestStats } = require('./quest-engine');
const { getTutorialView } = require('./tutorial-engine');

const QUERY_TYPES = {
  WORLD: 'world',
  PLAYER: 'player',
  ENTITY: 'entity',
  LOCATION: 'location',
  CITY: 'city',
  ORGANIZATION: 'organization',
  CIVILIZATION: 'civilization',
  LEADERBOARD: 'leaderboard',
  COMMANDS: 'commands',
  QUESTS: 'quests',
  TUTORIAL: 'tutorial',
  MAP: 'map',
  SNAPSHOT: 'snapshot',
};

function queryWorld(world, input = {}) {
  const type = input.type || QUERY_TYPES.WORLD;
  if (type === QUERY_TYPES.SNAPSHOT) return createWorldSnapshot(world, input.options || {});
  if (type === QUERY_TYPES.WORLD) return getWorldOverview(world);
  if (type === QUERY_TYPES.PLAYER) return getPlayerQuery(world, required(input, 'playerId'));
  if (type === QUERY_TYPES.ENTITY) return getEntityQuery(world, required(input, 'entityId'), input.options || {});
  if (type === QUERY_TYPES.LOCATION) return getLocationQuery(world, required(input, 'locationId'));
  if (type === QUERY_TYPES.CITY) return getCityQuery(world, required(input, 'cityId'));
  if (type === QUERY_TYPES.ORGANIZATION) return getOrganizationQuery(world, required(input, 'organizationId'));
  if (type === QUERY_TYPES.CIVILIZATION) return getCivilizationQuery(world, required(input, 'civilizationId'));
  if (type === QUERY_TYPES.LEADERBOARD) return getLeaderboard(world, input.options || {});
  if (type === QUERY_TYPES.COMMANDS) return getCommandQuery(world, required(input, 'playerId'), input.options || {});
  if (type === QUERY_TYPES.QUESTS) return getQuestQuery(world, required(input, 'playerId'), input.options || {});
  if (type === QUERY_TYPES.TUTORIAL) return getTutorialQuery(world, required(input, 'playerId'));
  if (type === QUERY_TYPES.MAP) return getMapQuery(world, input);
  throw new Error(`Unknown query type ${type}`);
}

function getWorldOverview(world) {
  const alive = Object.values(world.entities || {}).filter(entity => entity.status === 'alive');
  return {
    world: {
      id: world.id,
      tick: world.tick,
      calendar: world.calendar ? { ...world.calendar } : null,
    },
    totals: {
      entities: Object.keys(world.entities || {}).length,
      alive: alive.length,
      locations: Object.keys(world.locations || {}).length,
      cities: Object.keys(world.cities?.byId || {}).length,
      organizations: Object.keys(world.organizations?.byId || {}).length,
      civilizations: Object.keys(world.civilizations?.byId || {}).length,
      players: Object.keys(world.players?.byId || {}).length,
      commands: Object.keys(world.commands?.byId || {}).length,
      quests: Object.keys(world.quests?.byId || {}).length,
      tutorials: Object.keys(world.tutorials?.byPlayer || {}).length,
    },
    limits: {
      worldMemory: (world.memory || []).length,
      reports: (world.simulation?.reports || []).length,
      processes: Object.keys(world.processes?.byId || {}).length,
      information: Object.keys(world.information?.items || {}).length,
      memories: Object.keys(world.memories?.byId || {}).length,
      commands: Object.keys(world.commands?.byId || {}).length,
      quests: Object.keys(world.quests?.byId || {}).length,
    },
    commandStats: getCommandStats(world),
    questStats: getQuestStats(world),
  };
}

function getPlayerQuery(world, playerId) {
  const view = getPlayerView(world, playerId);
  if (!view) return null;
  return {
    ...view,
    commands: getPlayerCommands(world, playerId, 20),
    quests: getPlayerQuests(world, playerId).slice(0, 20),
    tutorial: getTutorialView(world, playerId),
  };
}

function getEntityQuery(world, entityId, options = {}) {
  const entity = world.entities?.[entityId];
  if (!entity) return null;
  return {
    id: entity.id,
    name: entity.name,
    type: entity.type,
    status: entity.status,
    species: entity.species || entity.meta?.species || 'unknown',
    location: entity.locationId ? getLocationQuery(world, entity.locationId, { compact: true }) : null,
    stats: { ...(entity.stats || {}) },
    resources: { ...(entity.resources || {}) },
    traits: { ...(entity.traits || {}) },
    demographics: { ...(entity.demographics || {}) },
    organizations: (entity.organizationIds || []).map(id => getOrganizationSummary(world, id)).filter(Boolean),
    goals: (entity.goals || []).map(goal => ({ ...goal })).slice(0, options.maxGoals || 10),
    knownInformation: getKnownInformation(world, 'entity', entity.id).slice(0, options.maxKnownInformation || 10).map(entry => ({
      informationId: entry.informationId,
      confidence: entry.confidence,
      item: entry.item ? { id: entry.item.id, type: entry.item.type, summary: entry.item.summary, status: entry.item.status } : null,
    })),
    memories: getMemories(world, 'entity', entity.id).slice(0, options.maxMemories || 10).map(memory => ({
      id: memory.id,
      type: memory.type,
      summary: memory.summary,
      importance: memory.importance,
      clarity: memory.clarity,
    })),
    meta: { ...(entity.meta || {}) },
  };
}

function getLocationQuery(world, locationId, options = {}) {
  const location = world.locations?.[locationId];
  if (!location) return null;
  const entities = Object.values(world.entities || {}).filter(entity => entity.locationId === locationId && entity.status === 'alive');
  if (options.compact) {
    return { id: location.id, name: location.name, type: location.type, alive: entities.length };
  }
  return {
    id: location.id,
    name: location.name,
    type: location.type,
    regionId: location.regionId,
    neighbors: [...(location.neighbors || [])],
    resources: { ...(location.resources || {}) },
    danger: location.danger,
    aliveEntities: entities.map(entity => ({ id: entity.id, name: entity.name, species: entity.species || 'unknown', power: entity.stats?.power || 0 })),
    cities: Object.values(world.cities?.byId || {}).filter(city => city.locationId === locationId).map(summarizeCity),
    organizations: Object.values(world.organizations?.byId || {}).filter(org => org.homeLocationId === locationId).map(summarizeOrganization),
    map: createLocationMap(world, locationId),
    meta: { ...(location.meta || {}) },
  };
}

function getCityQuery(world, cityId) {
  const city = world.cities?.byId?.[cityId];
  if (!city) return null;
  return summarizeCity(city);
}

function getOrganizationQuery(world, organizationId) {
  return getOrganizationChronicle(world, organizationId);
}

function getCivilizationQuery(world, civilizationId) {
  return getCivilizationChronicle(world, civilizationId);
}

function getCommandQuery(world, playerId, options = {}) {
  return {
    playerId,
    commands: getPlayerCommands(world, playerId, options.limit || 50),
    stats: getCommandStats(world),
  };
}

function getQuestQuery(world, playerId, options = {}) {
  return {
    playerId,
    quests: getPlayerQuests(world, playerId, options.filters || {}).slice(0, options.limit || 50),
    stats: getQuestStats(world),
  };
}

function getTutorialQuery(world, playerId) {
  return getTutorialView(world, playerId);
}

function getMapQuery(world, input = {}) {
  if (input.playerId) return createPlayerMap(world, input.playerId, input.options || {});
  if (input.locationId) return createLocationMap(world, input.locationId, input.options || {});
  return { locations: listWorldLocations(world) };
}

function getLeaderboard(world, options = {}) {
  const limit = options.limit || 10;
  const by = options.by || 'power';
  const entities = Object.values(world.entities || {}).filter(entity => entity.status === 'alive');
  return entities
    .map(entity => ({
      entityId: entity.id,
      name: entity.name,
      species: entity.species || entity.meta?.species || 'unknown',
      locationId: entity.locationId,
      score: scoreEntity(entity, by),
      power: Number(entity.stats?.power || 0),
      currency: Number(entity.resources?.currency || 0),
      happiness: Number(entity.meta?.happiness || 0),
      reputation: Number(entity.meta?.reputation || 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function scoreEntity(entity, by) {
  if (by === 'wealth') return Number(entity.resources?.currency || 0);
  if (by === 'happiness') return Number(entity.meta?.happiness || 0);
  if (by === 'reputation') return Number(entity.meta?.reputation || 0);
  if (by === 'overall') return Number(entity.stats?.power || 0) + Number(entity.resources?.currency || 0) * 0.02 + Number(entity.meta?.reputation || 0);
  return Number(entity.stats?.power || 0);
}

function getOrganizationSummary(world, id) {
  const org = world.organizations?.byId?.[id];
  return org ? summarizeOrganization(org) : null;
}

function summarizeOrganization(org) {
  return {
    id: org.id,
    name: org.name,
    type: org.type,
    status: org.status,
    leaderId: org.leaderId,
    members: (org.members || []).length,
    reputation: org.reputation,
    authority: org.authority,
    cohesion: org.cohesion,
  };
}

function summarizeCity(city) {
  return {
    id: city.id,
    name: city.name,
    type: city.type,
    locationId: city.locationId,
    population: city.population,
    wealth: city.wealth,
    security: city.security,
    culture: city.culture,
    infrastructureIds: [...(city.infrastructureIds || [])],
    organizationIds: [...(city.organizationIds || [])],
  };
}

function required(input, key) {
  if (input[key] === undefined || input[key] === null) throw new Error(`Query requires ${key}`);
  return input[key];
}

module.exports = {
  QUERY_TYPES,
  queryWorld,
  getWorldOverview,
  getPlayerQuery,
  getEntityQuery,
  getLocationQuery,
  getCityQuery,
  getOrganizationQuery,
  getCivilizationQuery,
  getCommandQuery,
  getQuestQuery,
  getTutorialQuery,
  getMapQuery,
  getLeaderboard,
};
