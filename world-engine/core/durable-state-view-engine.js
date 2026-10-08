'use strict';
const { commerceView } = require('./inventory-operations-engine');
const { getPlayerActionRules, stateOf } = require('./player-action-rules-engine');
const { DEFAULT_SPECIES } = require('./species-engine');
const { MAX_PLAYER_CHARACTERS, identifier, own } = require('./player-command-contract');

// Explicit DTOs: adding a field to a world/entity must not expose it over HTTP.
function text(value) { return typeof value === 'string' ? value.slice(0, 256) : null; }
function numbers(source, keys) {
  return Object.fromEntries(keys.filter(key => Number.isFinite(source?.[key])).map(key => [key, source[key]]));
}
const PUBLIC_LOCAL_EVENTS = new Set(['entity.moved', 'entity.rested', 'entity.worked', 'resource.gathered']);
function locationView(location) { return location ? { id: location.id, name: text(location.name) } : null; }
function ownedCharacter(world, player, id) {
  const entity = own(world.entities, id);
  return entity && player.controlledEntityIds?.includes(id) && own(world.players.byEntityId, id) === player.id
    && entity.meta?.playerId === player.id ? entity : null;
}
function explorationView(world, player, entity, location) {
  const ids = [...new Set(player.controlledEntityIds || [])];
  const characters = ids.map(id => ownedCharacter(world, player, id)).filter(Boolean);
  const locations = Object.values(world.locations || {}).filter(row => identifier(row.id, 200));
  const species = Object.values(world.species?.byId || DEFAULT_SPECIES).filter(row => identifier(row.id, 200));
  const neighbors = [...new Set(location?.neighbors || [])].map(id => own(world.locations, id)).filter(row => row && identifier(row.id, 200));
  const people = location ? Object.values(world.entities || {}).filter(row => row.locationId === location.id && row.status === 'alive') : [];
  const organizations = location ? Object.values(world.organizations?.byId || {}).filter(row => row.homeLocationId === location.id && row.status !== 'dissolved') : [];
  // Only resolved, explicitly public event kinds at the viewed location. Never
  // serialize generic payload/result/memory, account events or remote activity.
  const events = [];
  if (location) for (let i = (world.events?.length || 0) - 1; i >= 0 && events.length < 20; i--) {
    const event = world.events[i];
    if (event.locationId !== location.id || event.status !== 'resolved' || !PUBLIC_LOCAL_EVENTS.has(event.type)) continue;
    events.push({ id: text(event.id), type: event.type, tick: Number.isSafeInteger(event.tick) ? event.tick : null,
      actors: (event.actorIds || []).slice(0, 4).map(id => ({ id: text(id), name: text(own(world.entities, id)?.name) })) });
  }
  return {
    characters: characters.slice(0, MAX_PLAYER_CHARACTERS).map(row => ({ id: row.id, name: text(row.name), status: text(row.status), species: text(row.species),
      location: locationView(own(world.locations, row.locationId)), active: row.id === entity?.id && player.controlMode === 'character' })),
    characterCount: characters.length,
    characterCreation: { count: player.controlledEntityIds?.length || 0, limit: MAX_PLAYER_CHARACTERS,
      locations: locations.slice(0, 128).map(locationView), locationCount: locations.length,
      species: species.slice(0, 32).map(row => ({ id: row.id, name: text(row.name) })), speciesCount: species.length },
    surroundings: { neighbors: neighbors.slice(0, 128).map(locationView), neighborCount: neighbors.length,
      people: people.slice(0, 32).map(row => ({ id: row.id, name: text(row.name), current: row.id === entity?.id && player.controlMode === 'character' })), peopleCount: people.length,
      organizations: organizations.slice(0, 16).map(row => ({ id: row.id, name: text(row.name), memberCount: row.members?.length || 0 })), organizationCount: organizations.length,
      events },
  };
}
function playerStateView(world, revision, playerId) {
  const player = world.players.byId[playerId];
  const entity = player.controlMode === 'character' ? ownedCharacter(world, player, player.activeEntityId) : null;
  const location = own(world.locations, player.controlMode === 'observer' ? player.observerLocationId : entity?.locationId);
  return {
    worldId: world.id, revision, tick: world.tick,
    player: { id: player.id, name: text(player.name), status: text(player.status), controlMode: text(player.controlMode) },
    character: entity ? { id: entity.id, name: text(entity.name), status: text(entity.status),
      stats: numbers(entity.stats, ['health', 'maxHealth', 'energy', 'maxEnergy', 'power', 'defense', 'speed', 'intelligence', 'social']),
      resources: numbers(entity.resources, ['currency', 'food']),
      actionState: stateOf(entity) } : null,
    actionRules: getPlayerActionRules(world),
    inventory: commerceView(world, entity),
    location: locationView(location),
    ...explorationView(world, player, entity, location),
  };
}
function worldSummaryView(world, revision) {
  let entities = 0, alive = 0;
  for (const entity of Object.values(world.entities || {})) { entities++; if (entity.status === 'alive') alive++; }
  return { worldId: world.id, revision, tick: world.tick,
    counts: { entities, alive, locations: Object.keys(world.locations || {}).length,
      factions: Object.keys(world.factions || {}).length, organizations: Object.keys(world.organizations?.byId || {}).length,
      players: Object.keys(world.players?.byId || {}).length } };
}
module.exports = { playerStateView, worldSummaryView };
