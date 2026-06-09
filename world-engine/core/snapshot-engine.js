'use strict';

const DEFAULT_SNAPSHOT_OPTIONS = {
  topEntities: 10,
  topOrganizations: 10,
  topCities: 10,
  topCivilizations: 5,
  topPlayers: 10,
  recentCommands: 20,
  recentReports: 20,
};

function createWorldSnapshot(world, options = {}) {
  const config = { ...DEFAULT_SNAPSHOT_OPTIONS, ...(options || {}) };
  return {
    schemaVersion: 1,
    world: summarizeWorld(world),
    counters: summarizeCounters(world),
    population: summarizePopulation(world),
    players: summarizePlayers(world, config.topPlayers),
    commands: summarizeCommands(world, config.recentCommands),
    cities: summarizeCities(world, config.topCities),
    organizations: summarizeOrganizations(world, config.topOrganizations),
    civilizations: summarizeCivilizations(world, config.topCivilizations),
    technology: summarizeTechnology(world),
    infrastructure: summarizeInfrastructure(world),
    governance: summarizeGovernance(world),
    conflicts: summarizeConflicts(world),
    processes: summarizeProcesses(world),
    emergence: summarizeEmergence(world),
    information: summarizeInformation(world),
    memories: summarizeMemories(world),
    narrative: summarizeNarrative(world, config.topEntities),
    limits: summarizeLimits(world),
    recentReports: summarizeRecentReports(world, config.recentReports),
  };
}

function summarizeWorld(world) {
  return {
    id: world.id,
    tick: world.tick,
    calendar: world.calendar ? { ...world.calendar } : null,
    version: world.version || 1,
  };
}

function summarizeCounters(world) {
  return world.simulation?.counters ? { ...world.simulation.counters } : {};
}

function summarizePopulation(world) {
  const entities = Object.values(world.entities || {});
  const alive = entities.filter(entity => entity.status === 'alive');
  const dead = entities.filter(entity => entity.status === 'dead');
  return {
    total: entities.length,
    alive: alive.length,
    dead: dead.length,
    bySpecies: countBy(alive.map(entity => entity.species || 'unknown')),
    byLocation: countBy(alive.map(entity => entity.locationId || 'unknown')),
    averagePower: average(alive.map(entity => entity.stats?.power || 0)),
    averageHappiness: average(alive.map(entity => entity.meta?.happiness || 0)),
  };
}

function summarizePlayers(world, limit) {
  const players = Object.values(world.players?.byId || {});
  return {
    total: players.length,
    active: players.filter(player => player.status === 'active').length,
    observing: players.filter(player => player.status === 'observing').length,
    dead: players.filter(player => player.status === 'dead').length,
    byStatus: countBy(players.map(player => player.status)),
    items: players.slice(0, limit).map(player => {
      const entity = player.activeEntityId ? world.entities?.[player.activeEntityId] : null;
      return {
        id: player.id,
        name: player.name,
        status: player.status,
        controlMode: player.controlMode,
        activeEntityId: player.activeEntityId,
        activeEntityName: entity?.name || null,
        activeEntityStatus: entity?.status || null,
        locationId: entity?.locationId || player.observerLocationId || null,
        controlledEntities: (player.controlledEntityIds || []).length,
        updatedAt: player.updatedAt,
      };
    }),
  };
}

function summarizeCommands(world, limit) {
  const state = world.commands || { byId: {}, log: [], stats: {} };
  const recent = (state.log || []).slice(-limit).map(id => state.byId?.[id]).filter(Boolean);
  return {
    total: Object.keys(state.byId || {}).length,
    stats: { ...(state.stats || {}) },
    recent: recent.map(command => ({
      id: command.id,
      playerId: command.playerId,
      type: command.type,
      status: command.status,
      createdAt: command.createdAt,
      updatedAt: command.updatedAt,
      result: command.result ? {
        ok: command.result.ok,
        completed: command.result.completed,
        reason: command.result.reason || null,
        actionId: command.result.actionId || null,
        actionType: command.result.actionType || null,
      } : null,
    })),
  };
}

function summarizeCities(world, limit) {
  return Object.values(world.cities?.byId || {})
    .map(city => ({
      id: city.id,
      name: city.name,
      type: city.type,
      locationId: city.locationId,
      population: Number(city.population || 0),
      wealth: Number(city.wealth || 0),
      security: Number(city.security || 0),
      culture: Number(city.culture || 0),
      infrastructure: (city.infrastructureIds || []).length,
      organizations: (city.organizationIds || []).length,
    }))
    .sort((a, b) => scoreCity(b) - scoreCity(a))
    .slice(0, limit);
}

function summarizeOrganizations(world, limit) {
  return Object.values(world.organizations?.byId || {})
    .map(org => ({
      id: org.id,
      name: org.name,
      type: org.type,
      status: org.status,
      leaderId: org.leaderId,
      homeLocationId: org.homeLocationId,
      members: (org.members || []).length,
      wealth: Number(org.assets?.currency || 0),
      authority: Number(org.authority || 0),
      reputation: Number(org.reputation || 0),
      cohesion: Number(org.cohesion || 0),
      rivals: Object.keys(org.rivals || {}).length,
    }))
    .sort((a, b) => scoreOrganization(b) - scoreOrganization(a))
    .slice(0, limit);
}

function summarizeCivilizations(world, limit) {
  return Object.values(world.civilizations?.byId || {})
    .map(civ => ({
      id: civ.id,
      name: civ.name,
      status: civ.status,
      level: civ.level,
      score: Number(civ.score || 0),
      dominantSpecies: civ.dominantSpecies,
      metrics: { ...(civ.metrics || {}) },
      values: [...(civ.values || [])],
      cities: (civ.cityIds || []).length,
      organizations: (civ.organizationIds || []).length,
      religions: (civ.religionIds || []).length,
      cultures: (civ.cultureIds || []).length,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function summarizeTechnology(world) {
  const civStates = Object.values(world.technologies?.byCivilization || {});
  return {
    definitions: Object.keys(world.technologies?.definitions || {}).length,
    civilizations: civStates.length,
    unlocked: civStates.reduce((sum, state) => sum + Object.values(state.techs || {}).filter(tech => tech.status === 'unlocked').length, 0),
    researching: civStates.reduce((sum, state) => sum + Object.values(state.techs || {}).filter(tech => tech.status === 'researching').length, 0),
  };
}

function summarizeInfrastructure(world) {
  const items = Object.values(world.infrastructure?.byId || {});
  return {
    total: items.length,
    active: items.filter(item => item.status === 'active').length,
    building: items.filter(item => item.status === 'building').length,
    damaged: items.filter(item => item.status === 'damaged').length,
    ruined: items.filter(item => item.status === 'ruined').length,
    byType: countBy(items.map(item => item.type)),
    byStatus: countBy(items.map(item => item.status)),
  };
}

function summarizeGovernance(world) {
  const governments = Object.values(world.governance?.governments || {});
  return {
    total: governments.length,
    active: governments.filter(gov => gov.status === 'active').length,
    unstable: governments.filter(gov => gov.status === 'unstable').length,
    collapsed: governments.filter(gov => gov.status === 'collapsed').length,
    averageLegitimacy: average(governments.map(gov => gov.legitimacy || 0)),
    averageUnrest: average(governments.map(gov => gov.unrest || 0)),
    treasury: sum(governments.map(gov => gov.treasury || 0)),
  };
}

function summarizeConflicts(world) {
  const conflicts = Object.values(world.conflicts?.byId || {});
  return {
    total: conflicts.length,
    active: conflicts.filter(conflict => conflict.status === 'active').length,
    tension: conflicts.filter(conflict => conflict.status === 'tension').length,
    resolved: conflicts.filter(conflict => conflict.status === 'resolved').length,
    casualties: sum(conflicts.map(conflict => conflict.casualties || 0)),
    byType: countBy(conflicts.map(conflict => conflict.type)),
  };
}

function summarizeProcesses(world) {
  const processes = Object.values(world.processes?.byId || {});
  return {
    total: processes.length,
    active: processes.filter(process => process.status === 'active').length,
    resolved: processes.filter(process => process.status === 'resolved').length,
    stalled: processes.filter(process => process.status === 'stalled').length,
    byType: countBy(processes.map(process => process.type)),
  };
}

function summarizeEmergence(world) {
  const items = Object.values(world.emergence?.byId || {});
  return {
    total: items.length,
    active: items.filter(item => item.status === 'active').length,
    resolved: items.filter(item => item.status === 'resolved').length,
    byType: countBy(items.map(item => item.type)),
  };
}

function summarizeInformation(world) {
  const items = Object.values(world.information?.items || {});
  return {
    total: items.length,
    byType: countBy(items.map(item => item.type)),
    byStatus: countBy(items.map(item => item.status)),
    knownOwners: Object.keys(world.information?.knownBy || {}).length,
  };
}

function summarizeMemories(world) {
  const memories = Object.values(world.memories?.byId || {});
  return {
    total: memories.length,
    owners: Object.keys(world.memories?.byOwner || {}).length,
    byType: countBy(memories.map(memory => memory.type)),
    byScope: countBy(memories.map(memory => memory.scope)),
  };
}

function summarizeNarrative(world, limit) {
  const scores = Object.values(world.narrativeScores?.byEntity || {});
  const fallback = Object.values(world.entities || {}).map(entity => ({
    entityId: entity.id,
    totalScore: Number(entity.stats?.power || 0) + Number(entity.meta?.reputation || 0),
  }));
  const source = scores.length ? scores : fallback;
  return {
    topEntities: source
      .sort((a, b) => Number(b.totalScore || 0) - Number(a.totalScore || 0))
      .slice(0, limit)
      .map(score => ({
        entityId: score.entityId,
        name: world.entities?.[score.entityId]?.name || score.entityId,
        score: Number(score.totalScore || 0),
        status: world.entities?.[score.entityId]?.status || 'unknown',
      })),
  };
}

function summarizeLimits(world) {
  return {
    worldMemory: { current: (world.memory || []).length, limit: 1000 },
    reports: { current: (world.simulation?.reports || []).length, limit: 200 },
    processes: { current: Object.keys(world.processes?.byId || {}).length, limit: 500 },
    information: { current: Object.keys(world.information?.items || {}).length, limit: 1000 },
    memories: { current: Object.keys(world.memories?.byId || {}).length, limit: 3000 },
    commands: { current: Object.keys(world.commands?.byId || {}).length, limit: 500 },
  };
}

function summarizeRecentReports(world, limit) {
  return (world.simulation?.reports || []).slice(-limit);
}

function scoreCity(city) {
  return city.population * 5 + city.wealth * 0.01 + city.security + city.culture;
}

function scoreOrganization(org) {
  return org.members * 10 + org.wealth * 0.01 + org.authority + org.reputation + org.cohesion;
}

function countBy(values) {
  const out = {};
  for (const value of values || []) {
    const key = value === undefined || value === null ? 'unknown' : String(value);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function average(values) {
  const filtered = (values || []).map(Number).filter(Number.isFinite);
  if (!filtered.length) return 0;
  return sum(filtered) / filtered.length;
}

function sum(values) {
  return (values || []).map(Number).filter(Number.isFinite).reduce((a, b) => a + b, 0);
}

module.exports = {
  DEFAULT_SNAPSHOT_OPTIONS,
  createWorldSnapshot,
  summarizeWorld,
  summarizePopulation,
  summarizePlayers,
  summarizeCommands,
  summarizeCities,
  summarizeOrganizations,
  summarizeCivilizations,
  summarizeTechnology,
  summarizeInfrastructure,
  summarizeGovernance,
  summarizeConflicts,
  summarizeProcesses,
  summarizeEmergence,
  summarizeInformation,
  summarizeMemories,
  summarizeNarrative,
  summarizeLimits,
};
