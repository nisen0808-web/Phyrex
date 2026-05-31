'use strict';

const DEFAULT_SPECIES = {
  human: {
    id: 'human',
    name: 'Human',
    category: 'mortal',
    adultAge: 18,
    elderAge: 60,
    lifeExpectancy: 78,
    maxNaturalAge: 115,
    fertility: 1,
    birthChanceMultiplier: 1,
    mortalityMultiplier: 1,
    traits: { ambition: 50, social: 55, adaptability: 70 },
    cultureBias: ['family', 'trade', 'organization'],
    compatibleSpecies: ['human'],
    domestication: { canDomesticate: true, canBeDomesticated: false },
  },
  spirit_beast: {
    id: 'spirit_beast',
    name: 'Spirit Beast',
    category: 'beast',
    adultAge: 20,
    elderAge: 180,
    lifeExpectancy: 260,
    maxNaturalAge: 500,
    fertility: 0.35,
    birthChanceMultiplier: 0.35,
    mortalityMultiplier: 0.7,
    traits: { instinct: 80, loyalty: 45, aggression: 45 },
    cultureBias: ['territory', 'bond'],
    compatibleSpecies: ['spirit_beast'],
    domestication: { canDomesticate: false, canBeDomesticated: true },
  },
  demon: {
    id: 'demon',
    name: 'Demon',
    category: 'supernatural',
    adultAge: 30,
    elderAge: 400,
    lifeExpectancy: 800,
    maxNaturalAge: 1500,
    fertility: 0.12,
    birthChanceMultiplier: 0.12,
    mortalityMultiplier: 0.5,
    traits: { ambition: 85, aggression: 75, deception: 70 },
    cultureBias: ['power', 'domination'],
    compatibleSpecies: ['demon'],
    domestication: { canDomesticate: true, canBeDomesticated: false },
  },
  dragon: {
    id: 'dragon',
    name: 'Dragon',
    category: 'ancient',
    adultAge: 300,
    elderAge: 2500,
    lifeExpectancy: 5000,
    maxNaturalAge: 10000,
    fertility: 0.015,
    birthChanceMultiplier: 0.015,
    mortalityMultiplier: 0.15,
    traits: { pride: 95, power: 95, isolation: 75 },
    cultureBias: ['territory', 'legacy', 'domination'],
    compatibleSpecies: ['dragon'],
    domestication: { canDomesticate: true, canBeDomesticated: false },
  },
};

function ensureSpeciesState(world) {
  if (!world.species) {
    world.species = {
      byId: { ...cloneSpeciesMap(DEFAULT_SPECIES) },
      relations: {},
      indexes: { byCategory: {} },
    };
    rebuildSpeciesIndexes(world);
    seedDefaultSpeciesRelations(world);
  }
  return world.species;
}

function registerSpecies(world, input) {
  if (!input || !input.id) throw new Error('Species requires id');
  const state = ensureSpeciesState(world);
  state.byId[input.id] = {
    id: input.id,
    name: input.name || input.id,
    category: input.category || 'unknown',
    adultAge: Number(input.adultAge ?? 18),
    elderAge: Number(input.elderAge ?? 60),
    lifeExpectancy: Number(input.lifeExpectancy ?? 80),
    maxNaturalAge: Number(input.maxNaturalAge ?? 120),
    fertility: Number(input.fertility ?? 1),
    birthChanceMultiplier: Number(input.birthChanceMultiplier ?? input.fertility ?? 1),
    mortalityMultiplier: Number(input.mortalityMultiplier ?? 1),
    traits: { ...(input.traits || {}) },
    cultureBias: Array.isArray(input.cultureBias) ? [...input.cultureBias] : [],
    compatibleSpecies: Array.isArray(input.compatibleSpecies) ? [...input.compatibleSpecies] : [input.id],
    domestication: { canDomesticate: false, canBeDomesticated: false, ...(input.domestication || {}) },
    meta: { ...(input.meta || {}) },
  };
  rebuildSpeciesIndexes(world);
  return state.byId[input.id];
}

function getSpecies(world, speciesId = 'human') {
  const state = ensureSpeciesState(world);
  return state.byId[speciesId] || state.byId.human;
}

function assignSpecies(world, entityId, speciesId = 'human', options = {}) {
  const entity = world.entities[entityId];
  if (!entity) throw new Error(`Missing entity ${entityId}`);
  const species = getSpecies(world, speciesId);
  entity.species = species.id;
  entity.meta = { ...(entity.meta || {}), species: species.id };
  entity.traits = { ...(species.traits || {}), ...(entity.traits || {}) };

  if (entity.demographics) {
    entity.demographics.lifeExpectancy = options.lifeExpectancy || species.lifeExpectancy;
    entity.demographics.fertility = options.fertility ?? species.fertility;
  }
  return entity;
}

function applySpeciesDefaultsToEntity(world, entity) {
  const species = getSpecies(world, entity.species || entity.meta?.species || 'human');
  entity.species = species.id;
  entity.meta = { ...(entity.meta || {}), species: species.id };
  entity.traits = { ...(species.traits || {}), ...(entity.traits || {}) };
  if (entity.demographics) {
    entity.demographics.lifeExpectancy = entity.demographics.lifeExpectancy || species.lifeExpectancy;
    entity.demographics.fertility = entity.demographics.fertility ?? species.fertility;
  }
  return entity;
}

function getSpeciesPopulationOptions(world, speciesId) {
  const species = getSpecies(world, speciesId);
  return {
    minAdultAge: species.adultAge,
    elderAge: species.elderAge,
    defaultLifeExpectancy: species.lifeExpectancy,
    maxNaturalAge: species.maxNaturalAge,
    birthChanceMultiplier: species.birthChanceMultiplier,
    mortalityMultiplier: species.mortalityMultiplier,
    fertility: species.fertility,
  };
}

function areSpeciesCompatible(world, a, b) {
  const speciesA = getSpecies(world, a);
  const speciesB = getSpecies(world, b);
  return speciesA.compatibleSpecies.includes(speciesB.id) || speciesB.compatibleSpecies.includes(speciesA.id);
}

function setSpeciesRelation(world, fromSpeciesId, toSpeciesId, input = {}) {
  const state = ensureSpeciesState(world);
  const key = speciesRelationKey(fromSpeciesId, toSpeciesId);
  state.relations[key] = {
    fromSpeciesId,
    toSpeciesId,
    trust: Number(input.trust || 0),
    fear: Number(input.fear || 0),
    hostility: Number(input.hostility || 0),
    dominance: Number(input.dominance || 0),
    affinity: Number(input.affinity || 0),
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
  };
  return state.relations[key];
}

function getSpeciesRelation(world, fromSpeciesId, toSpeciesId) {
  const state = ensureSpeciesState(world);
  return state.relations[speciesRelationKey(fromSpeciesId, toSpeciesId)] || {
    fromSpeciesId,
    toSpeciesId,
    trust: 0,
    fear: 0,
    hostility: 0,
    dominance: 0,
    affinity: 0,
    tags: [],
  };
}

function applySpeciesRelationshipBias(world, entityAId, entityBId) {
  const a = world.entities[entityAId];
  const b = world.entities[entityBId];
  if (!a || !b) return null;
  const relation = getSpeciesRelation(world, a.species || 'human', b.species || 'human');
  const key = `${entityAId}->${entityBId}`;
  if (!world.relationships[key]) {
    world.relationships[key] = { affection: 0, trust: 0, fear: 0, hatred: 0, debt: 0, loyalty: 0 };
  }
  world.relationships[key].trust += relation.trust + relation.affinity * 0.25;
  world.relationships[key].fear += relation.fear;
  world.relationships[key].hatred += relation.hostility;
  return world.relationships[key];
}

function seedDefaultSpeciesRelations(world) {
  setSpeciesRelation(world, 'human', 'spirit_beast', { trust: 5, fear: 10, affinity: 12, tags: ['domestication_possible'] });
  setSpeciesRelation(world, 'spirit_beast', 'human', { trust: 3, fear: 8, affinity: 10, tags: ['bond_possible'] });
  setSpeciesRelation(world, 'human', 'demon', { trust: -20, fear: 25, hostility: 18, tags: ['danger'] });
  setSpeciesRelation(world, 'demon', 'human', { trust: -10, fear: 0, hostility: 20, dominance: 25, tags: ['domination'] });
  setSpeciesRelation(world, 'human', 'dragon', { trust: -5, fear: 45, hostility: 0, tags: ['awe'] });
  setSpeciesRelation(world, 'dragon', 'human', { trust: -5, fear: 0, hostility: 0, dominance: 45, tags: ['superiority'] });
}

function rebuildSpeciesIndexes(world) {
  const state = ensureSpeciesState(world);
  state.indexes.byCategory = {};
  for (const species of Object.values(state.byId)) {
    if (!state.indexes.byCategory[species.category]) state.indexes.byCategory[species.category] = [];
    state.indexes.byCategory[species.category].push(species.id);
  }
}

function getSpeciesStats(world) {
  ensureSpeciesState(world);
  const stats = {};
  for (const entity of Object.values(world.entities || {})) {
    const id = entity.species || entity.meta?.species || 'human';
    if (!stats[id]) stats[id] = { total: 0, alive: 0, dead: 0 };
    stats[id].total += 1;
    if (entity.status === 'alive') stats[id].alive += 1;
    if (entity.status === 'dead') stats[id].dead += 1;
  }
  return stats;
}

function speciesRelationKey(a, b) {
  return `${a}->${b}`;
}

function cloneSpeciesMap(map) {
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    out[key] = {
      ...value,
      traits: { ...(value.traits || {}) },
      cultureBias: [...(value.cultureBias || [])],
      compatibleSpecies: [...(value.compatibleSpecies || [])],
      domestication: { ...(value.domestication || {}) },
    };
  }
  return out;
}

module.exports = {
  DEFAULT_SPECIES,
  ensureSpeciesState,
  registerSpecies,
  getSpecies,
  assignSpecies,
  applySpeciesDefaultsToEntity,
  getSpeciesPopulationOptions,
  areSpeciesCompatible,
  setSpeciesRelation,
  getSpeciesRelation,
  applySpeciesRelationshipBias,
  getSpeciesStats,
  rebuildSpeciesIndexes,
};
