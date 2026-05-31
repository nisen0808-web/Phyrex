'use strict';

const CIVILIZATION_STATUS = {
  ACTIVE: 'active',
  DECLINING: 'declining',
  COLLAPSED: 'collapsed',
};

const CIVILIZATION_LEVELS = [
  { level: 'band', minScore: 0 },
  { level: 'tribe', minScore: 100 },
  { level: 'settlement_network', minScore: 300 },
  { level: 'city_state', minScore: 800 },
  { level: 'kingdom', minScore: 1800 },
  { level: 'empire', minScore: 4000 },
  { level: 'civilization', minScore: 9000 },
];

const DEFAULT_CIVILIZATION_OPTIONS = {
  minPopulation: 1,
  collapseScore: 30,
  memoryLimit: 1000,
};

function ensureCivilizationState(world) {
  if (!world.civilizations) {
    world.civilizations = {
      byId: {},
      indexes: { byStatus: {}, byLevel: {}, byDominantSpecies: {} },
      stats: { created: 0, collapsed: 0, updated: 0 },
    };
  }
  return world.civilizations;
}

function createCivilization(world, input = {}) {
  const state = ensureCivilizationState(world);
  const id = input.id || `civ_${world.tick}_${Math.random().toString(16).slice(2)}`;
  const civilization = {
    id,
    name: input.name || inferCivilizationName(world, input),
    status: input.status || CIVILIZATION_STATUS.ACTIVE,
    foundedTick: input.foundedTick ?? world.tick,
    collapsedTick: null,
    dominantSpecies: input.dominantSpecies || inferDominantSpecies(world),
    locationIds: Array.isArray(input.locationIds) ? [...input.locationIds] : [],
    cityIds: Array.isArray(input.cityIds) ? [...input.cityIds] : [],
    organizationIds: Array.isArray(input.organizationIds) ? [...input.organizationIds] : [],
    familyIds: Array.isArray(input.familyIds) ? [...input.familyIds] : [],
    religionIds: Array.isArray(input.religionIds) ? [...input.religionIds] : [],
    cultureIds: Array.isArray(input.cultureIds) ? [...input.cultureIds] : [],
    level: input.level || 'band',
    score: Number(input.score || 0),
    metrics: {
      population: 0,
      wealth: 0,
      cities: 0,
      organizations: 0,
      families: 0,
      religions: 0,
      culture: 0,
      stability: 50,
      knowledge: 0,
      military: 0,
      trade: 0,
    },
    values: [],
    memory: [],
    meta: { ...(input.meta || {}) },
  };
  state.byId[id] = civilization;
  state.stats.created += 1;
  recordCivilizationMemory(world, civilization, 'civilization.created', {});
  rebuildCivilizationIndexes(world);
  return civilization;
}

function processCivilizationTick(world, options = {}) {
  const config = { ...DEFAULT_CIVILIZATION_OPTIONS, ...(options || {}) };
  const created = ensureDefaultCivilizations(world, config);
  const updated = [];
  const collapsed = [];

  for (const civilization of Object.values(ensureCivilizationState(world).byId)) {
    if (civilization.status === CIVILIZATION_STATUS.COLLAPSED) continue;
    updateCivilizationMembership(world, civilization.id);
    updateCivilizationMetrics(world, civilization.id);
    const previousLevel = civilization.level;
    civilization.score = calculateCivilizationScore(civilization);
    civilization.level = inferCivilizationLevel(civilization.score);
    civilization.values = inferCivilizationValues(world, civilization.id);

    if (previousLevel !== civilization.level) {
      recordCivilizationMemory(world, civilization, 'civilization.level_changed', { from: previousLevel, to: civilization.level });
    }

    if (civilization.score < config.collapseScore && civilization.metrics.population <= 0) {
      civilization.status = CIVILIZATION_STATUS.COLLAPSED;
      civilization.collapsedTick = world.tick;
      ensureCivilizationState(world).stats.collapsed += 1;
      collapsed.push(civilization.id);
      recordCivilizationMemory(world, civilization, 'civilization.collapsed', {});
    } else if (civilization.score < 100) {
      civilization.status = CIVILIZATION_STATUS.DECLINING;
    } else {
      civilization.status = CIVILIZATION_STATUS.ACTIVE;
    }

    updated.push(civilization.id);
  }

  ensureCivilizationState(world).stats.updated += updated.length;
  rebuildCivilizationIndexes(world);
  return { created, updated, collapsed, stats: getCivilizationStats(world) };
}

function ensureDefaultCivilizations(world, options = {}) {
  const state = ensureCivilizationState(world);
  const created = [];
  const alive = Object.values(world.entities || {}).filter(entity => entity.status === 'alive');
  if (!alive.length) return created;

  const bySpecies = groupBy(alive, entity => entity.species || 'human');
  for (const [species, entities] of Object.entries(bySpecies)) {
    if (entities.length < (options.minPopulation || DEFAULT_CIVILIZATION_OPTIONS.minPopulation)) continue;
    const existing = Object.values(state.byId).find(civ => civ.dominantSpecies === species && civ.status !== CIVILIZATION_STATUS.COLLAPSED);
    if (existing) continue;
    created.push(createCivilization(world, {
      name: `${capitalize(species)} Civilization`,
      dominantSpecies: species,
      locationIds: unique(entities.map(entity => entity.locationId).filter(Boolean)),
    }));
  }
  return created;
}

function updateCivilizationMembership(world, civilizationId) {
  const civ = getCivilization(world, civilizationId);
  if (!civ) return null;
  const species = civ.dominantSpecies;
  const entities = Object.values(world.entities || {}).filter(entity => entity.status === 'alive' && (entity.species || 'human') === species);
  const locationIds = unique(entities.map(entity => entity.locationId).filter(Boolean));

  civ.locationIds = locationIds;
  civ.cityIds = Object.values(world.cities?.byId || {})
    .filter(city => locationIds.includes(city.locationId))
    .map(city => city.id);
  civ.organizationIds = Object.values(world.organizations?.byId || {})
    .filter(org => org.status !== 'dissolved' && (!org.homeLocationId || locationIds.includes(org.homeLocationId)))
    .map(org => org.id);
  civ.familyIds = Object.values(world.families?.byId || {})
    .filter(family => family.status !== 'extinct')
    .filter(family => family.members?.some(entityId => {
      const entity = world.entities[entityId];
      return entity && (entity.species || 'human') === species;
    }))
    .map(family => family.id);
  civ.religionIds = Object.values(world.religions?.byId || {})
    .filter(religion => religion.status !== 'extinct')
    .filter(religion => religion.believers?.some(entityId => {
      const entity = world.entities[entityId];
      return entity && (entity.species || 'human') === species;
    }))
    .map(religion => religion.id);
  civ.cultureIds = Object.values(world.cultures?.byId || {})
    .filter(culture => {
      if (culture.ownerType === 'species') return culture.ownerId === species;
      if (culture.ownerType === 'city') return civ.cityIds.includes(culture.ownerId);
      if (culture.ownerType === 'organization') return civ.organizationIds.includes(culture.ownerId);
      if (culture.ownerType === 'family') return civ.familyIds.includes(culture.ownerId);
      return false;
    })
    .map(culture => culture.id);
  return civ;
}

function updateCivilizationMetrics(world, civilizationId) {
  const civ = getCivilization(world, civilizationId);
  if (!civ) return null;
  const species = civ.dominantSpecies;
  const entities = Object.values(world.entities || {}).filter(entity => entity.status === 'alive' && (entity.species || 'human') === species);
  const cities = civ.cityIds.map(id => world.cities?.byId?.[id]).filter(Boolean);
  const orgs = civ.organizationIds.map(id => world.organizations?.byId?.[id]).filter(Boolean);
  const families = civ.familyIds.map(id => world.families?.byId?.[id]).filter(Boolean);
  const religions = civ.religionIds.map(id => world.religions?.byId?.[id]).filter(Boolean);
  const cultures = civ.cultureIds.map(id => world.cultures?.byId?.[id]).filter(Boolean);

  civ.metrics.population = entities.length;
  civ.metrics.wealth = Math.round(
    entities.reduce((sum, entity) => sum + Object.values(entity.resources || {}).reduce((a, b) => a + Number(b || 0), 0), 0)
    + cities.reduce((sum, city) => sum + Number(city.wealth || 0), 0)
    + orgs.reduce((sum, org) => sum + Number(org.assets?.currency || 0), 0)
  );
  civ.metrics.cities = cities.length;
  civ.metrics.organizations = orgs.length;
  civ.metrics.families = families.length;
  civ.metrics.religions = religions.length;
  civ.metrics.culture = Math.round(cultures.reduce((sum, culture) => sum + average(Object.values(culture.traits || {})), 0));
  civ.metrics.stability = Math.round(average([
    average(cities.map(city => city.security || 0)),
    average(orgs.map(org => org.cohesion || 0)),
    average(families.map(family => family.reputation || 0)),
  ]));
  civ.metrics.knowledge = Math.round(sumCultureTrait(cultures, 'knowledge') + Number(world.economy?.markets?.global?.resources?.knowledge?.supply || 0) * 0.01);
  civ.metrics.military = Math.round(sumCultureTrait(cultures, 'martial') + orgs.reduce((sum, org) => sum + Number(org.authority || 0), 0) * 0.1);
  civ.metrics.trade = Math.round(sumCultureTrait(cultures, 'trade') + Number(world.economy?.stats?.transactionVolume || 0) * 0.001);
  return civ.metrics;
}

function calculateCivilizationScore(civ) {
  const m = civ.metrics;
  return Math.round(
    m.population * 2
    + m.wealth * 0.02
    + m.cities * 80
    + m.organizations * 60
    + m.families * 40
    + m.religions * 30
    + m.culture * 1.5
    + m.stability * 3
    + m.knowledge * 4
    + m.military * 3
    + m.trade * 3
  );
}

function inferCivilizationLevel(score) {
  let level = CIVILIZATION_LEVELS[0].level;
  for (const item of CIVILIZATION_LEVELS) {
    if (score >= item.minScore) level = item.level;
  }
  return level;
}

function inferCivilizationValues(world, civilizationId) {
  const civ = getCivilization(world, civilizationId);
  if (!civ) return [];
  const cultures = civ.cultureIds.map(id => world.cultures?.byId?.[id]).filter(Boolean);
  const totals = {};
  for (const culture of cultures) {
    for (const [trait, value] of Object.entries(culture.traits || {})) {
      totals[trait] = (totals[trait] || 0) + Number(value || 0);
    }
  }
  return Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([trait]) => trait);
}

function getCivilization(world, civilizationId) {
  return ensureCivilizationState(world).byId[civilizationId] || null;
}

function getCivilizationChronicle(world, civilizationId) {
  const civ = getCivilization(world, civilizationId);
  if (!civ) return null;
  return {
    civilizationId,
    name: civ.name,
    status: civ.status,
    level: civ.level,
    score: civ.score,
    dominantSpecies: civ.dominantSpecies,
    foundedTick: civ.foundedTick,
    collapsedTick: civ.collapsedTick,
    metrics: { ...civ.metrics },
    values: [...civ.values],
    cityIds: [...civ.cityIds],
    organizationIds: [...civ.organizationIds],
    familyIds: [...civ.familyIds],
    religionIds: [...civ.religionIds],
    cultureIds: [...civ.cultureIds],
    memory: [...civ.memory],
  };
}

function getCivilizationStats(world) {
  const state = ensureCivilizationState(world);
  return {
    total: Object.keys(state.byId).length,
    active: Object.values(state.byId).filter(civ => civ.status === CIVILIZATION_STATUS.ACTIVE).length,
    byLevel: countIndex(state.indexes.byLevel),
    byStatus: countIndex(state.indexes.byStatus),
    byDominantSpecies: countIndex(state.indexes.byDominantSpecies),
  };
}

function recordCivilizationMemory(world, civ, type, payload = {}) {
  const memory = {
    id: `civilization_memory_${world.tick}_${civ.memory.length + 1}`,
    tick: world.tick,
    type,
    payload: { civilizationId: civ.id, ...payload },
  };
  civ.memory.push(memory);
  if (civ.memory.length > DEFAULT_CIVILIZATION_OPTIONS.memoryLimit) civ.memory.shift();
  return memory;
}

function rebuildCivilizationIndexes(world) {
  const state = ensureCivilizationState(world);
  state.indexes = { byStatus: {}, byLevel: {}, byDominantSpecies: {} };
  for (const civ of Object.values(state.byId)) {
    addIndex(state.indexes.byStatus, civ.status, civ.id);
    addIndex(state.indexes.byLevel, civ.level, civ.id);
    addIndex(state.indexes.byDominantSpecies, civ.dominantSpecies, civ.id);
  }
}

function inferDominantSpecies(world) {
  const alive = Object.values(world.entities || {}).filter(entity => entity.status === 'alive');
  const counts = {};
  for (const entity of alive) counts[entity.species || 'human'] = (counts[entity.species || 'human'] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'human';
}

function inferCivilizationName(world, input = {}) {
  const species = input.dominantSpecies || inferDominantSpecies(world);
  return `${capitalize(species)} Civilization`;
}

function groupBy(items, getter) {
  const out = {};
  for (const item of items) {
    const key = getter(item);
    if (!out[key]) out[key] = [];
    out[key].push(item);
  }
  return out;
}

function unique(items) {
  return Array.from(new Set(items));
}

function average(items) {
  const values = (Array.isArray(items) ? items : []).map(Number).filter(Number.isFinite);
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sumCultureTrait(cultures, trait) {
  return cultures.reduce((sum, culture) => sum + Number(culture.traits?.[trait] || 0), 0);
}

function countIndex(index) {
  const out = {};
  for (const [key, value] of Object.entries(index || {})) out[key] = value.length;
  return out;
}

function addIndex(index, key, value) {
  if (!index[key]) index[key] = [];
  if (!index[key].includes(value)) index[key].push(value);
}

function capitalize(value) {
  const text = String(value || 'unknown');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

module.exports = {
  CIVILIZATION_STATUS,
  CIVILIZATION_LEVELS,
  DEFAULT_CIVILIZATION_OPTIONS,
  ensureCivilizationState,
  createCivilization,
  processCivilizationTick,
  ensureDefaultCivilizations,
  updateCivilizationMembership,
  updateCivilizationMetrics,
  calculateCivilizationScore,
  inferCivilizationLevel,
  getCivilization,
  getCivilizationChronicle,
  getCivilizationStats,
  rebuildCivilizationIndexes,
};
