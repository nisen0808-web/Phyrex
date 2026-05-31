'use strict';

const CULTURE_SCOPE = {
  FAMILY: 'family',
  ORGANIZATION: 'organization',
  CITY: 'city',
  SPECIES: 'species',
  WORLD: 'world',
};

const CULTURE_TRAITS = {
  MARTIAL: 'martial',
  TRADE: 'trade',
  FAITH: 'faith',
  KNOWLEDGE: 'knowledge',
  LEGACY: 'legacy',
  ORDER: 'order',
  FREEDOM: 'freedom',
  EXPANSION: 'expansion',
  SECRECY: 'secrecy',
  HEDONISM: 'hedonism',
  CRAFT: 'craft',
  SURVIVAL: 'survival',
};

const DEFAULT_CULTURE_OPTIONS = {
  driftRate: 0.02,
  reinforcementRate: 0.25,
  memoryInfluence: 0.05,
  economyInfluence: 0.04,
  identityInfluence: 0.03,
};

function ensureCultureState(world) {
  if (!world.cultures) {
    world.cultures = {
      byId: {},
      indexes: { byScope: {}, byOwner: {}, byTrait: {} },
      stats: { created: 0, updated: 0 },
    };
  }
  return world.cultures;
}

function createCulture(world, input = {}) {
  if (!input.ownerType || !input.ownerId) throw new Error('Culture requires ownerType and ownerId');
  const id = input.id || `culture_${input.ownerType}_${input.ownerId}`;
  const culture = {
    id,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    scope: input.scope || input.ownerType,
    createdAt: world.tick,
    updatedAt: world.tick,
    traits: normalizeTraits(input.traits || {}),
    traditions: Array.isArray(input.traditions) ? [...input.traditions] : [],
    taboos: Array.isArray(input.taboos) ? [...input.taboos] : [],
    values: Array.isArray(input.values) ? [...input.values] : [],
    memory: [],
    meta: { ...(input.meta || {}) },
  };
  const state = ensureCultureState(world);
  state.byId[id] = culture;
  state.stats.created += 1;
  indexCulture(world, culture);
  return culture;
}

function upsertCulture(world, input = {}) {
  const existing = getCultureByOwner(world, input.ownerType, input.ownerId);
  if (existing) {
    existing.traits = normalizeTraits({ ...existing.traits, ...(input.traits || {}) });
    existing.traditions = mergeUnique(existing.traditions, input.traditions || []);
    existing.taboos = mergeUnique(existing.taboos, input.taboos || []);
    existing.values = mergeUnique(existing.values, input.values || []);
    existing.updatedAt = world.tick;
    ensureCultureState(world).stats.updated += 1;
    rebuildCultureIndexes(world);
    return existing;
  }
  return createCulture(world, input);
}

function processCultureTick(world, options = {}) {
  const config = { ...DEFAULT_CULTURE_OPTIONS, ...(options || {}) };
  const synced = [];
  synced.push(...syncFamilyCultures(world));
  synced.push(...syncOrganizationCultures(world));
  synced.push(...syncCityCultures(world));
  synced.push(...syncSpeciesCultures(world));
  const drifted = updateCultureDrift(world, config);
  rebuildCultureIndexes(world);
  return { synced, drifted, stats: getCultureStats(world) };
}

function syncFamilyCultures(world) {
  const synced = [];
  for (const family of Object.values(world.families?.byId || {})) {
    const traits = {};
    for (const tradition of family.traditions || []) traits[normalizeCultureTrait(tradition)] = 40;
    traits[CULTURE_TRAITS.LEGACY] = Math.min(100, Number(family.generation || 1) * 8 + Number(family.reputation || 0) * 0.1);
    if (Number(family.wealth || 0) > 1000) traits[CULTURE_TRAITS.TRADE] = 35;
    synced.push(upsertCulture(world, {
      ownerType: CULTURE_SCOPE.FAMILY,
      ownerId: family.id,
      scope: CULTURE_SCOPE.FAMILY,
      traits,
      traditions: family.traditions || [],
      values: ['bloodline', 'inheritance'],
    }));
  }
  return synced;
}

function syncOrganizationCultures(world) {
  const synced = [];
  for (const org of Object.values(world.organizations?.byId || {})) {
    const traits = {};
    for (const item of org.culture || []) traits[normalizeCultureTrait(item)] = 45;
    if (org.type === 'sect' || org.type === 'school') traits[CULTURE_TRAITS.KNOWLEDGE] = 50;
    if (org.type === 'guild' || org.type === 'company') traits[CULTURE_TRAITS.TRADE] = 55;
    if (org.type === 'state') traits[CULTURE_TRAITS.ORDER] = 60;
    if (org.type === 'church') traits[CULTURE_TRAITS.FAITH] = 65;
    if (org.type === 'gang') traits[CULTURE_TRAITS.SECRECY] = 35;
    synced.push(upsertCulture(world, {
      ownerType: CULTURE_SCOPE.ORGANIZATION,
      ownerId: org.id,
      scope: CULTURE_SCOPE.ORGANIZATION,
      traits,
      traditions: org.culture || [],
      values: org.goals?.map(goal => goal.type) || [],
    }));
  }
  return synced;
}

function syncCityCultures(world) {
  const synced = [];
  for (const city of Object.values(world.cities?.byId || {})) {
    const traits = {};
    if (city.security >= 70) traits[CULTURE_TRAITS.ORDER] = 45;
    if (city.security < 35) traits[CULTURE_TRAITS.SURVIVAL] = 50;
    if (city.wealth > 1000) traits[CULTURE_TRAITS.TRADE] = 45;
    if (city.culture > 50) traits[CULTURE_TRAITS.KNOWLEDGE] = 35;
    if ((city.industryIds || []).length > 3) traits[CULTURE_TRAITS.CRAFT] = 35;
    synced.push(upsertCulture(world, {
      ownerType: CULTURE_SCOPE.CITY,
      ownerId: city.id,
      scope: CULTURE_SCOPE.CITY,
      traits,
      values: ['settlement', city.type],
    }));
  }
  return synced;
}

function syncSpeciesCultures(world) {
  const synced = [];
  for (const species of Object.values(world.species?.byId || {})) {
    const traits = {};
    for (const bias of species.cultureBias || []) traits[normalizeCultureTrait(bias)] = 50;
    synced.push(upsertCulture(world, {
      ownerType: CULTURE_SCOPE.SPECIES,
      ownerId: species.id,
      scope: CULTURE_SCOPE.SPECIES,
      traits,
      values: species.cultureBias || [],
    }));
  }
  return synced;
}

function updateCultureDrift(world, options = {}) {
  const drifted = [];
  for (const culture of Object.values(ensureCultureState(world).byId)) {
    const influences = [
      calculateMemoryCultureInfluence(world, culture, options),
      calculateEconomyCultureInfluence(world, culture, options),
      calculateIdentityCultureInfluence(world, culture, options),
    ];
    for (const influence of influences) {
      for (const [trait, amount] of Object.entries(influence)) {
        culture.traits[trait] = clamp(Number(culture.traits[trait] || 0) + amount, 0, 100);
      }
    }
    for (const trait of Object.keys(culture.traits)) {
      culture.traits[trait] = clamp(culture.traits[trait] - (options.driftRate || DEFAULT_CULTURE_OPTIONS.driftRate), 0, 100);
    }
    culture.updatedAt = world.tick;
    drifted.push(culture.id);
  }
  return drifted;
}

function calculateMemoryCultureInfluence(world, culture, options = {}) {
  const out = {};
  const key = `${culture.ownerType}:${culture.ownerId}`;
  const memoryIds = world.memories?.byOwner?.[key] || [];
  for (const memoryId of memoryIds.slice(-20)) {
    const memory = world.memories.byId[memoryId];
    if (!memory) continue;
    if (memory.type === 'trauma') out[CULTURE_TRAITS.SURVIVAL] = (out[CULTURE_TRAITS.SURVIVAL] || 0) + options.memoryInfluence;
    if (memory.type === 'achievement') out[CULTURE_TRAITS.LEGACY] = (out[CULTURE_TRAITS.LEGACY] || 0) + options.memoryInfluence;
    if (memory.type === 'obligation') out[CULTURE_TRAITS.ORDER] = (out[CULTURE_TRAITS.ORDER] || 0) + options.memoryInfluence;
    if (memory.type === 'rumor') out[CULTURE_TRAITS.SECRECY] = (out[CULTURE_TRAITS.SECRECY] || 0) + options.memoryInfluence;
  }
  return normalizeTraits(out);
}

function calculateEconomyCultureInfluence(world, culture, options = {}) {
  const out = {};
  if (culture.ownerType === CULTURE_SCOPE.CITY) {
    const city = world.cities?.byId?.[culture.ownerId];
    if (city && city.wealth > 1000) out[CULTURE_TRAITS.TRADE] = options.economyInfluence;
  }
  if (culture.ownerType === CULTURE_SCOPE.ORGANIZATION) {
    const org = world.organizations?.byId?.[culture.ownerId];
    if (org && Number(org.assets?.currency || 0) > 1000) out[CULTURE_TRAITS.TRADE] = options.economyInfluence;
  }
  return normalizeTraits(out);
}

function calculateIdentityCultureInfluence(world, culture, options = {}) {
  const out = {};
  if (culture.ownerType === CULTURE_SCOPE.CITY) {
    const city = world.cities?.byId?.[culture.ownerId];
    if (!city) return out;
    const entities = Object.values(world.entities || {}).filter(entity => entity.locationId === city.locationId);
    const nobleCount = entities.filter(entity => entity.meta?.identityScore?.prestige >= 80 || entity.meta?.identityScore?.authority >= 80).length;
    if (nobleCount > 0) out[CULTURE_TRAITS.ORDER] = nobleCount * options.identityInfluence;
  }
  return normalizeTraits(out);
}

function getCultureByOwner(world, ownerType, ownerId) {
  return Object.values(ensureCultureState(world).byId).find(culture => culture.ownerType === ownerType && culture.ownerId === ownerId) || null;
}

function getCultureSummary(world, ownerType, ownerId) {
  const culture = getCultureByOwner(world, ownerType, ownerId);
  if (!culture) return null;
  return {
    id: culture.id,
    ownerType,
    ownerId,
    dominantTraits: Object.entries(culture.traits).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([trait, value]) => ({ trait, value })),
    traditions: [...culture.traditions],
    taboos: [...culture.taboos],
    values: [...culture.values],
  };
}

function getCultureStats(world) {
  const state = ensureCultureState(world);
  return {
    total: Object.keys(state.byId).length,
    byScope: countIndex(state.indexes.byScope),
    byTrait: countIndex(state.indexes.byTrait),
  };
}

function rebuildCultureIndexes(world) {
  const state = ensureCultureState(world);
  state.indexes = { byScope: {}, byOwner: {}, byTrait: {} };
  for (const culture of Object.values(state.byId)) indexCulture(world, culture);
}

function indexCulture(world, culture) {
  const state = ensureCultureState(world);
  addIndex(state.indexes.byScope, culture.scope, culture.id);
  addIndex(state.indexes.byOwner, `${culture.ownerType}:${culture.ownerId}`, culture.id);
  for (const trait of Object.keys(culture.traits || {})) addIndex(state.indexes.byTrait, trait, culture.id);
}

function normalizeCultureTrait(value) {
  const normalized = String(value || '').toLowerCase();
  const aliases = {
    trade: CULTURE_TRAITS.TRADE,
    profit: CULTURE_TRAITS.TRADE,
    efficiency: CULTURE_TRAITS.CRAFT,
    discipline: CULTURE_TRAITS.ORDER,
    training: CULTURE_TRAITS.MARTIAL,
    law: CULTURE_TRAITS.ORDER,
    taxation: CULTURE_TRAITS.ORDER,
    faith: CULTURE_TRAITS.FAITH,
    ritual: CULTURE_TRAITS.FAITH,
    loyalty: CULTURE_TRAITS.LEGACY,
    territory: CULTURE_TRAITS.EXPANSION,
    power: CULTURE_TRAITS.MARTIAL,
    domination: CULTURE_TRAITS.EXPANSION,
    knowledge: CULTURE_TRAITS.KNOWLEDGE,
    teaching: CULTURE_TRAITS.KNOWLEDGE,
    secrecy: CULTURE_TRAITS.SECRECY,
    bond: CULTURE_TRAITS.LEGACY,
    family: CULTURE_TRAITS.LEGACY,
    organization: CULTURE_TRAITS.ORDER,
    survival: CULTURE_TRAITS.SURVIVAL,
  };
  return aliases[normalized] || normalized || CULTURE_TRAITS.LEGACY;
}

function normalizeTraits(input) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    out[normalizeCultureTrait(key)] = clamp(Number(value || 0), 0, 100);
  }
  return out;
}

function mergeUnique(a = [], b = []) {
  return Array.from(new Set([...(a || []), ...(b || [])]));
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

module.exports = {
  CULTURE_SCOPE,
  CULTURE_TRAITS,
  DEFAULT_CULTURE_OPTIONS,
  ensureCultureState,
  createCulture,
  upsertCulture,
  processCultureTick,
  getCultureByOwner,
  getCultureSummary,
  getCultureStats,
  rebuildCultureIndexes,
};
