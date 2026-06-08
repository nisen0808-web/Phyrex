'use strict';

const { registerEntity, recordMemory } = require('./world-engine');
const { assignSpecies } = require('./species-engine');

const PLAYER_STATUS = {
  ACTIVE: 'active',
  OBSERVING: 'observing',
  DEAD: 'dead',
  INACTIVE: 'inactive',
};

const PLAYER_CONTROL_MODE = {
  CHARACTER: 'character',
  OBSERVER: 'observer',
};

const DEFAULT_PLAYER_OPTIONS = {
  defaultSpecies: 'human',
  defaultLocationId: null,
};

function ensurePlayerState(world) {
  if (!world.players) {
    world.players = {
      byId: {},
      byEntityId: {},
      activePlayerId: null,
      stats: {
        created: 0,
        charactersCreated: 0,
        switched: 0,
        deathsObserved: 0,
      },
    };
  }
  return world.players;
}

function createPlayer(world, input = {}) {
  const state = ensurePlayerState(world);
  const id = input.id || `player_${world.tick}_${Math.random().toString(16).slice(2)}`;
  if (state.byId[id]) throw new Error(`Player already exists: ${id}`);

  const player = {
    id,
    name: input.name || id,
    status: input.status || PLAYER_STATUS.ACTIVE,
    controlMode: input.controlMode || PLAYER_CONTROL_MODE.CHARACTER,
    activeEntityId: input.activeEntityId || null,
    controlledEntityIds: Array.isArray(input.controlledEntityIds) ? [...input.controlledEntityIds] : [],
    observerLocationId: input.observerLocationId || null,
    createdAt: world.tick,
    updatedAt: world.tick,
    memory: [],
    preferences: { ...(input.preferences || {}) },
    meta: { ...(input.meta || {}) },
  };

  state.byId[id] = player;
  state.stats.created += 1;
  if (!state.activePlayerId) state.activePlayerId = id;
  if (player.activeEntityId) bindPlayerToEntity(world, id, player.activeEntityId, { active: true });
  recordPlayerMemory(world, player, 'player.created', {});
  return player;
}

function createPlayerCharacter(world, playerId, input = {}, options = {}) {
  const player = getPlayer(world, playerId) || createPlayer(world, { id: playerId, name: input.playerName || playerId });
  const locationId = input.locationId || options.defaultLocationId || pickDefaultLocation(world);
  const entityId = input.id || `${playerId}_character_${player.controlledEntityIds.length + 1}`;

  const entity = registerEntity(world, {
    id: entityId,
    name: input.name || player.name || entityId,
    type: input.type || 'player_character',
    locationId,
    traits: { ambition: 60, social: 55, ...(input.traits || {}) },
    stats: {
      health: 100,
      maxHealth: 100,
      energy: 100,
      maxEnergy: 100,
      power: 12,
      defense: 5,
      speed: 10,
      intelligence: 16,
      social: 50,
      ...(input.stats || {}),
    },
    resources: { currency: 100, food: 5, ...(input.resources || {}) },
    demographics: {
      age: input.age ?? input.demographics?.age ?? 18,
      generation: input.demographics?.generation ?? 1,
      sex: input.sex || input.demographics?.sex || null,
      ...(input.demographics || {}),
    },
    tags: ['player_character', ...(input.tags || [])],
    meta: { playerId, control: 'player', ...(input.meta || {}) },
  });

  assignSpecies(world, entity.id, input.species || options.defaultSpecies || DEFAULT_PLAYER_OPTIONS.defaultSpecies);
  bindPlayerToEntity(world, player.id, entity.id, { active: input.active !== false });
  ensurePlayerState(world).stats.charactersCreated += 1;
  recordPlayerMemory(world, player, 'player.character_created', { entityId: entity.id });
  recordMemory(world, { type: 'player.character_created', payload: { playerId: player.id, entityId: entity.id } });
  return entity;
}

function createPlayerWithCharacter(world, input = {}) {
  const player = createPlayer(world, input.player || { id: input.playerId, name: input.playerName });
  const entity = createPlayerCharacter(world, player.id, input.character || input.entity || {}, input.options || {});
  return { player, entity };
}

function bindPlayerToEntity(world, playerId, entityId, options = {}) {
  const player = getPlayer(world, playerId);
  const entity = world.entities[entityId];
  if (!player) throw new Error(`Missing player ${playerId}`);
  if (!entity) throw new Error(`Missing entity ${entityId}`);

  if (!player.controlledEntityIds.includes(entityId)) player.controlledEntityIds.push(entityId);
  if (options.active !== false) player.activeEntityId = entityId;
  player.controlMode = PLAYER_CONTROL_MODE.CHARACTER;
  player.status = entity.status === 'alive' ? PLAYER_STATUS.ACTIVE : PLAYER_STATUS.DEAD;
  player.updatedAt = world.tick;
  entity.meta = { ...(entity.meta || {}), playerId, control: 'player' };
  ensurePlayerState(world).byEntityId[entityId] = playerId;
  ensurePlayerState(world).stats.switched += options.active === false ? 0 : 1;
  recordPlayerMemory(world, player, 'player.bound_entity', { entityId, active: options.active !== false });
  return player;
}

function switchPlayerCharacter(world, playerId, entityId) {
  const player = getPlayer(world, playerId);
  const entity = world.entities[entityId];
  if (!player) throw new Error(`Missing player ${playerId}`);
  if (!entity) throw new Error(`Missing entity ${entityId}`);
  if (!player.controlledEntityIds.includes(entityId)) throw new Error(`Player ${playerId} does not control ${entityId}`);
  player.activeEntityId = entityId;
  player.controlMode = PLAYER_CONTROL_MODE.CHARACTER;
  player.status = entity.status === 'alive' ? PLAYER_STATUS.ACTIVE : PLAYER_STATUS.DEAD;
  player.updatedAt = world.tick;
  ensurePlayerState(world).stats.switched += 1;
  recordPlayerMemory(world, player, 'player.switched_character', { entityId });
  return player;
}

function setPlayerObserverMode(world, playerId, locationId = null) {
  const player = getPlayer(world, playerId);
  if (!player) throw new Error(`Missing player ${playerId}`);
  if (locationId && !world.locations[locationId]) throw new Error(`Missing location ${locationId}`);
  player.controlMode = PLAYER_CONTROL_MODE.OBSERVER;
  player.status = PLAYER_STATUS.OBSERVING;
  player.observerLocationId = locationId || player.observerLocationId || world.entities[player.activeEntityId]?.locationId || pickDefaultLocation(world);
  player.updatedAt = world.tick;
  recordPlayerMemory(world, player, 'player.observer_mode', { locationId: player.observerLocationId });
  return player;
}

function processPlayersTick(world) {
  const state = ensurePlayerState(world);
  const changed = [];
  for (const player of Object.values(state.byId)) {
    const before = player.status;
    const active = player.activeEntityId ? world.entities[player.activeEntityId] : null;
    if (player.controlMode === PLAYER_CONTROL_MODE.CHARACTER && active?.status !== 'alive') {
      const next = findNextControlledAliveEntity(world, player);
      if (next) {
        player.activeEntityId = next.id;
        player.status = PLAYER_STATUS.ACTIVE;
        recordPlayerMemory(world, player, 'player.auto_switched_after_death', { entityId: next.id });
      } else {
        player.status = PLAYER_STATUS.DEAD;
        state.stats.deathsObserved += before !== PLAYER_STATUS.DEAD ? 1 : 0;
        recordPlayerMemory(world, player, 'player.character_dead', { entityId: active?.id || null });
      }
    }
    player.updatedAt = world.tick;
    if (before !== player.status) changed.push(player.id);
  }
  return { changed, stats: { ...state.stats } };
}

function getPlayer(world, playerId) {
  return ensurePlayerState(world).byId[playerId] || null;
}

function getPlayerByEntity(world, entityId) {
  const playerId = ensurePlayerState(world).byEntityId[entityId];
  return playerId ? getPlayer(world, playerId) : null;
}

function getActivePlayerCharacter(world, playerId) {
  const player = getPlayer(world, playerId);
  if (!player || !player.activeEntityId) return null;
  return world.entities[player.activeEntityId] || null;
}

function getPlayerView(world, playerId) {
  const player = getPlayer(world, playerId);
  if (!player) return null;
  const entity = getActivePlayerCharacter(world, playerId);
  return {
    player: sanitizePlayer(player),
    activeEntity: entity ? summarizeEntity(entity) : null,
    controlledEntities: player.controlledEntityIds.map(id => world.entities[id]).filter(Boolean).map(summarizeEntity),
    observerLocation: player.observerLocationId ? summarizeLocation(world.locations[player.observerLocationId]) : null,
  };
}

function sanitizePlayer(player) {
  return {
    id: player.id,
    name: player.name,
    status: player.status,
    controlMode: player.controlMode,
    activeEntityId: player.activeEntityId,
    controlledEntityIds: [...player.controlledEntityIds],
    observerLocationId: player.observerLocationId,
    createdAt: player.createdAt,
    updatedAt: player.updatedAt,
    preferences: { ...player.preferences },
    meta: { ...player.meta },
  };
}

function summarizeEntity(entity) {
  return {
    id: entity.id,
    name: entity.name,
    status: entity.status,
    species: entity.species || entity.meta?.species || 'unknown',
    locationId: entity.locationId,
    stats: { ...(entity.stats || {}) },
    resources: { ...(entity.resources || {}) },
    demographics: { ...(entity.demographics || {}) },
    organizations: [...(entity.organizationIds || [])],
    meta: { ...(entity.meta || {}) },
  };
}

function summarizeLocation(location) {
  if (!location) return null;
  return {
    id: location.id,
    name: location.name,
    type: location.type,
    neighbors: [...(location.neighbors || [])],
    resources: { ...(location.resources || {}) },
  };
}

function findNextControlledAliveEntity(world, player) {
  return player.controlledEntityIds.map(id => world.entities[id]).find(entity => entity?.status === 'alive') || null;
}

function pickDefaultLocation(world) {
  return Object.keys(world.locations || {})[0] || null;
}

function recordPlayerMemory(world, player, type, payload = {}) {
  const memory = {
    id: `player_memory_${world.tick}_${player.memory.length + 1}`,
    tick: world.tick,
    type,
    payload: { playerId: player.id, ...payload },
  };
  player.memory.push(memory);
  if (player.memory.length > 500) player.memory.shift();
  return memory;
}

module.exports = {
  PLAYER_STATUS,
  PLAYER_CONTROL_MODE,
  DEFAULT_PLAYER_OPTIONS,
  ensurePlayerState,
  createPlayer,
  createPlayerCharacter,
  createPlayerWithCharacter,
  bindPlayerToEntity,
  switchPlayerCharacter,
  setPlayerObserverMode,
  processPlayersTick,
  getPlayer,
  getPlayerByEntity,
  getActivePlayerCharacter,
  getPlayerView,
};
