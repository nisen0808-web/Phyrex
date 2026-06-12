'use strict';

const DEFAULT_MAP_OPTIONS = {
  includeEntities: true,
  includeOrganizations: true,
  includeCities: true,
  includeResources: true,
  maxEntities: 20,
};

function createLocationMap(world, locationId, options = {}) {
  const config = { ...DEFAULT_MAP_OPTIONS, ...(options || {}) };
  const location = world.locations?.[locationId];
  if (!location) return null;
  const aliveEntities = Object.values(world.entities || {}).filter(entity => entity.status === 'alive' && entity.locationId === locationId);
  const organizations = Object.values(world.organizations?.byId || {}).filter(org => org.homeLocationId === locationId || org.locationId === locationId);
  const cities = Object.values(world.cities?.byId || {}).filter(city => city.locationId === locationId);

  return {
    id: location.id,
    name: location.name,
    type: location.type,
    regionId: location.regionId,
    danger: Number(location.danger || 0),
    capacity: location.capacity || null,
    tags: [...(location.tags || [])],
    resources: config.includeResources ? { ...(location.resources || {}) } : {},
    neighbors: (location.neighbors || []).map(id => {
      const neighbor = world.locations?.[id];
      return {
        id,
        name: neighbor?.name || id,
        type: neighbor?.type || 'location',
        danger: Number(neighbor?.danger || 0),
      };
    }),
    entities: config.includeEntities ? aliveEntities.slice(0, config.maxEntities).map(entity => ({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      species: entity.species || entity.meta?.species || 'unknown',
      power: Number(entity.stats?.power || 0),
      status: entity.status,
      isPlayer: Boolean(entity.meta?.playerId),
    })) : [],
    entityCount: aliveEntities.length,
    organizations: config.includeOrganizations ? organizations.map(org => ({
      id: org.id,
      name: org.name,
      type: org.type,
      status: org.status,
      members: (org.members || []).length,
      leaderId: org.leaderId,
    })) : [],
    cities: config.includeCities ? cities.map(city => ({
      id: city.id,
      name: city.name,
      type: city.type,
      population: Number(city.population || 0),
      wealth: Number(city.wealth || 0),
      security: Number(city.security || 0),
      culture: Number(city.culture || 0),
    })) : [],
  };
}

function createPlayerMap(world, playerId, options = {}) {
  const player = world.players?.byId?.[playerId];
  const entity = player?.activeEntityId ? world.entities?.[player.activeEntityId] : null;
  const locationId = entity?.locationId || player?.observerLocationId || Object.keys(world.locations || {})[0] || null;
  if (!locationId) return null;
  return {
    playerId,
    activeEntityId: entity?.id || null,
    currentLocationId: locationId,
    current: createLocationMap(world, locationId, options),
  };
}

function formatLocationMap(map) {
  if (!map) return 'No map data.';
  const lines = [];
  const current = map.current || map;
  lines.push(`Location: ${current.name} [${current.id}] type=${current.type} danger=${current.danger}`);
  const resources = Object.entries(current.resources || {}).map(([key, value]) => `${key}=${value}`).join(', ');
  lines.push(`Resources: ${resources || 'none'}`);
  lines.push(`Exits: ${(current.neighbors || []).map(n => `${n.name}(${n.id})`).join(', ') || 'none'}`);

  if ((current.cities || []).length) {
    lines.push('Cities:');
    for (const city of current.cities) lines.push(`- ${city.name} [${city.id}] pop=${city.population} security=${city.security}`);
  }

  if ((current.organizations || []).length) {
    lines.push('Organizations:');
    for (const org of current.organizations) lines.push(`- ${org.name} [${org.id}] ${org.type} members=${org.members}`);
  }

  lines.push(`Entities here: ${current.entityCount || 0}`);
  for (const entity of (current.entities || []).slice(0, 10)) {
    const mark = entity.isPlayer ? '*' : '-';
    lines.push(`${mark} ${entity.name} [${entity.id}] species=${entity.species} power=${entity.power}`);
  }
  return lines.join('\n');
}

function listWorldLocations(world) {
  return Object.values(world.locations || {}).map(location => ({
    id: location.id,
    name: location.name,
    type: location.type,
    neighbors: [...(location.neighbors || [])],
    resources: { ...(location.resources || {}) },
    alive: Object.values(world.entities || {}).filter(entity => entity.status === 'alive' && entity.locationId === location.id).length,
  }));
}

module.exports = {
  DEFAULT_MAP_OPTIONS,
  createLocationMap,
  createPlayerMap,
  formatLocationMap,
  listWorldLocations,
};
