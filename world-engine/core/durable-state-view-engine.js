'use strict';
const { commerceView } = require('./inventory-operations-engine');
const { getPlayerActionRules, stateOf } = require('./player-action-rules-engine');

// Explicit DTOs: adding a field to a world/entity must not expose it over HTTP.
function text(value) { return typeof value === 'string' ? value.slice(0, 256) : null; }
function numbers(source, keys) {
  return Object.fromEntries(keys.filter(key => Number.isFinite(source?.[key])).map(key => [key, source[key]]));
}
function playerStateView(world, revision, playerId) {
  const player = world.players.byId[playerId];
  const entity = player.activeEntityId && player.controlledEntityIds?.includes(player.activeEntityId)
    ? world.entities?.[player.activeEntityId] : null;
  const location = world.locations?.[entity?.locationId || player.observerLocationId];
  return {
    worldId: world.id, revision, tick: world.tick,
    player: { id: player.id, name: text(player.name), status: text(player.status), controlMode: text(player.controlMode) },
    character: entity ? { id: entity.id, name: text(entity.name), status: text(entity.status),
      stats: numbers(entity.stats, ['health', 'maxHealth', 'energy', 'maxEnergy', 'power', 'defense', 'speed', 'intelligence', 'social']),
      resources: numbers(entity.resources, ['currency', 'food']),
      actionState: stateOf(entity) } : null,
    actionRules: getPlayerActionRules(world),
    inventory: commerceView(world, entity),
    location: location ? { id: location.id, name: text(location.name) } : null,
  };
}
function worldSummaryView(world, revision) {
  let entities = 0, alive = 0;
  for (const entity of Object.values(world.entities || {})) { entities++; if (entity.status === 'alive') alive++; }
  return { worldId: world.id, revision, tick: world.tick,
    counts: { entities, alive, locations: Object.keys(world.locations || {}).length,
      factions: Object.keys(world.factions || {}).length, players: Object.keys(world.players?.byId || {}).length } };
}
module.exports = { playerStateView, worldSummaryView };
