'use strict';

const { createInformation, INFORMATION_TYPES } = require('./information-engine');
const { createMemory } = require('./memory-engine');
const { createProcess, PROCESS_TYPES } = require('./process-engine');

const EMERGENCE_TYPES = {
  CITY_RISE: 'city_rise',
  CITY_DECLINE: 'city_decline',
  ORGANIZATION_HEGEMONY: 'organization_hegemony',
  ECONOMIC_SHORTAGE: 'economic_shortage',
  CULTURAL_DOMINANCE: 'cultural_dominance',
  RELIGIOUS_EXPANSION: 'religious_expansion',
  CIVILIZATION_ASCENT: 'civilization_ascent',
  POWER_CONCENTRATION: 'power_concentration',
  LEGEND_CLUSTER: 'legend_cluster',
};

const EMERGENCE_STATUS = {
  ACTIVE: 'active',
  RESOLVED: 'resolved',
};

const DEFAULT_EMERGENCE_OPTIONS = {
  minCityPopulation: 50,
  shortagePressure: 2,
  cultureDominanceThreshold: 70,
  religionBelieverThreshold: 5,
  civilizationScoreThreshold: 800,
  memoryLimit: 1000,
};

function ensureEmergenceState(world) {
  if (!world.emergence) {
    world.emergence = {
      byId: {},
      indexes: { byType: {}, byStatus: {}, byTarget: {} },
      stats: { detected: 0, resolved: 0 },
    };
  }
  return world.emergence;
}

function createEmergence(world, input = {}) {
  const state = ensureEmergenceState(world);
  const id = input.id || `emergence_${world.tick}_${Math.random().toString(16).slice(2)}`;
  const emergence = {
    id,
    type: input.type,
    status: input.status || EMERGENCE_STATUS.ACTIVE,
    title: input.title || input.type,
    detectedAt: input.detectedAt ?? world.tick,
    updatedAt: world.tick,
    resolvedAt: null,
    targetType: input.targetType || null,
    targetId: input.targetId || null,
    score: Number(input.score || 0),
    severity: Number(input.severity || 0),
    participants: Array.isArray(input.participants) ? [...input.participants] : [],
    sourceIds: Array.isArray(input.sourceIds) ? [...input.sourceIds] : [],
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    payload: { ...(input.payload || {}) },
  };
  state.byId[id] = emergence;
  state.stats.detected += 1;
  indexEmergence(world, emergence);
  announceEmergence(world, emergence);
  return emergence;
}

function processEmergenceTick(world, options = {}) {
  const config = { ...DEFAULT_EMERGENCE_OPTIONS, ...(options || {}) };
  const detected = [];
  detected.push(...detectCityEmergence(world, config));
  detected.push(...detectOrganizationEmergence(world, config));
  detected.push(...detectEconomicEmergence(world, config));
  detected.push(...detectCultureEmergence(world, config));
  detected.push(...detectReligionEmergence(world, config));
  detected.push(...detectCivilizationEmergence(world, config));
  const resolved = resolveStaleEmergences(world, config);
  rebuildEmergenceIndexes(world);
  return { detected, resolved, stats: getEmergenceStats(world) };
}

function detectCityEmergence(world, options = {}) {
  const out = [];
  for (const city of Object.values(world.cities?.byId || {})) {
    if (city.population >= options.minCityPopulation && !hasActiveEmergence(world, EMERGENCE_TYPES.CITY_RISE, 'city', city.id)) {
      out.push(createEmergence(world, {
        type: EMERGENCE_TYPES.CITY_RISE,
        title: `city rising: ${city.name}`,
        targetType: 'city',
        targetId: city.id,
        score: city.population + city.wealth * 0.01,
        severity: Math.min(100, city.population / 10),
        participants: city.organizationIds || [],
        tags: ['city', city.type],
        payload: { population: city.population, wealth: city.wealth, cityType: city.type },
      }));
    }
    if (city.security < 25 && !hasActiveEmergence(world, EMERGENCE_TYPES.CITY_DECLINE, 'city', city.id)) {
      out.push(createEmergence(world, {
        type: EMERGENCE_TYPES.CITY_DECLINE,
        title: `city declining: ${city.name}`,
        targetType: 'city',
        targetId: city.id,
        score: 100 - city.security,
        severity: 100 - city.security,
        tags: ['city', 'decline'],
        payload: { security: city.security, population: city.population },
      }));
    }
  }
  return out;
}

function detectOrganizationEmergence(world) {
  const out = [];
  for (const org of Object.values(world.organizations?.byId || {})) {
    if (org.status === 'dissolved') continue;
    const score = Number(org.reputation || 0) + Number(org.assets?.currency || 0) * 0.01 + Number(org.members?.length || 0) * 5;
    if (score > 300 && !hasActiveEmergence(world, EMERGENCE_TYPES.ORGANIZATION_HEGEMONY, 'organization', org.id)) {
      out.push(createEmergence(world, {
        type: EMERGENCE_TYPES.ORGANIZATION_HEGEMONY,
        title: `organization hegemony: ${org.name}`,
        targetType: 'organization',
        targetId: org.id,
        score,
        severity: Math.min(100, score / 10),
        participants: org.members || [],
        tags: ['organization', org.type],
        payload: { reputation: org.reputation, assets: org.assets, members: org.members?.length || 0 },
      }));
    }
  }
  return out;
}

function detectEconomicEmergence(world, options = {}) {
  const out = [];
  const market = world.economy?.markets?.global;
  if (!market) return out;
  for (const [resource, item] of Object.entries(market.resources || {})) {
    const pressure = Number(item.demand || 0) / Math.max(1, Number(item.supply || 0));
    if (pressure >= options.shortagePressure && !hasActiveEmergence(world, EMERGENCE_TYPES.ECONOMIC_SHORTAGE, 'resource', resource)) {
      out.push(createEmergence(world, {
        type: EMERGENCE_TYPES.ECONOMIC_SHORTAGE,
        title: `shortage: ${resource}`,
        targetType: 'resource',
        targetId: resource,
        score: pressure * 100,
        severity: Math.min(100, pressure * 20),
        tags: ['economy', 'shortage', resource],
        payload: { resource, pressure, supply: item.supply, demand: item.demand, price: item.price },
      }));
    }
  }
  return out;
}

function detectCultureEmergence(world, options = {}) {
  const out = [];
  for (const culture of Object.values(world.cultures?.byId || {})) {
    const dominant = Object.entries(culture.traits || {}).sort((a, b) => b[1] - a[1])[0];
    if (!dominant) continue;
    const [trait, value] = dominant;
    const targetId = `${culture.ownerType}:${culture.ownerId}:${trait}`;
    if (value >= options.cultureDominanceThreshold && !hasActiveEmergence(world, EMERGENCE_TYPES.CULTURAL_DOMINANCE, 'culture_trait', targetId)) {
      out.push(createEmergence(world, {
        type: EMERGENCE_TYPES.CULTURAL_DOMINANCE,
        title: `cultural dominance: ${trait}`,
        targetType: 'culture_trait',
        targetId,
        score: value,
        severity: value,
        tags: ['culture', trait, culture.ownerType],
        payload: { cultureId: culture.id, ownerType: culture.ownerType, ownerId: culture.ownerId, trait, value },
      }));
    }
  }
  return out;
}

function detectReligionEmergence(world, options = {}) {
  const out = [];
  for (const religion of Object.values(world.religions?.byId || {})) {
    if (religion.status === 'extinct') continue;
    if ((religion.believers?.length || 0) >= options.religionBelieverThreshold && !hasActiveEmergence(world, EMERGENCE_TYPES.RELIGIOUS_EXPANSION, 'religion', religion.id)) {
      out.push(createEmergence(world, {
        type: EMERGENCE_TYPES.RELIGIOUS_EXPANSION,
        title: `religion expanding: ${religion.name}`,
        targetType: 'religion',
        targetId: religion.id,
        score: religion.influence + religion.believers.length * 10,
        severity: Math.min(100, religion.believers.length * 10),
        participants: religion.believers || [],
        tags: ['religion', religion.type],
        payload: { believers: religion.believers.length, influence: religion.influence },
      }));
    }
  }
  return out;
}

function detectCivilizationEmergence(world, options = {}) {
  const out = [];
  for (const civ of Object.values(world.civilizations?.byId || {})) {
    if (civ.status === 'collapsed') continue;
    if (civ.score >= options.civilizationScoreThreshold && !hasActiveEmergence(world, EMERGENCE_TYPES.CIVILIZATION_ASCENT, 'civilization', civ.id)) {
      out.push(createEmergence(world, {
        type: EMERGENCE_TYPES.CIVILIZATION_ASCENT,
        title: `civilization ascent: ${civ.name}`,
        targetType: 'civilization',
        targetId: civ.id,
        score: civ.score,
        severity: Math.min(100, civ.score / 100),
        tags: ['civilization', civ.level, civ.dominantSpecies],
        payload: { level: civ.level, score: civ.score, metrics: civ.metrics },
      }));
    }
  }
  return out;
}

function resolveStaleEmergences(world) {
  const resolved = [];
  for (const emergence of Object.values(ensureEmergenceState(world).byId)) {
    if (emergence.status !== EMERGENCE_STATUS.ACTIVE) continue;
    if (!targetStillExists(world, emergence)) {
      emergence.status = EMERGENCE_STATUS.RESOLVED;
      emergence.resolvedAt = world.tick;
      ensureEmergenceState(world).stats.resolved += 1;
      resolved.push(emergence.id);
    }
  }
  return resolved;
}

function targetStillExists(world, emergence) {
  if (!emergence.targetType || !emergence.targetId) return true;
  if (emergence.targetType === 'city') return Boolean(world.cities?.byId?.[emergence.targetId]);
  if (emergence.targetType === 'organization') return Boolean(world.organizations?.byId?.[emergence.targetId]);
  if (emergence.targetType === 'religion') return Boolean(world.religions?.byId?.[emergence.targetId]);
  if (emergence.targetType === 'civilization') return Boolean(world.civilizations?.byId?.[emergence.targetId]);
  return true;
}

function announceEmergence(world, emergence) {
  try {
    createInformation(world, {
      type: INFORMATION_TYPES.REPORT,
      summary: emergence.title,
      content: `Emergence detected: ${emergence.title}`,
      confidence: 80,
      spreadability: 70,
      secrecy: 0,
      tags: ['emergence', emergence.type],
      payload: { emergenceId: emergence.id, targetType: emergence.targetType, targetId: emergence.targetId },
    });
    createProcess(world, {
      type: mapEmergenceToProcess(emergence.type),
      title: emergence.title,
      ownerType: emergence.targetType || 'world',
      ownerId: emergence.targetId || 'world',
      participants: emergence.participants || [],
      sourceIds: [emergence.id],
      tags: ['emergence', emergence.type],
      payload: { emergenceId: emergence.id },
      progress: Math.min(95, emergence.severity),
      strength: Math.max(1, emergence.score * 0.01),
    });
    if (emergence.participants?.[0]) {
      createMemory(world, {
        ownerType: 'entity',
        ownerId: emergence.participants[0],
        type: 'personal',
        summary: emergence.title,
        importance: emergence.severity,
        emotionalWeight: emergence.type.includes('decline') || emergence.type.includes('shortage') ? -40 : 35,
        tags: ['emergence', emergence.type],
        payload: { emergenceId: emergence.id },
      });
    }
  } catch (_) {}
}

function mapEmergenceToProcess(type) {
  if (type === EMERGENCE_TYPES.CITY_DECLINE || type === EMERGENCE_TYPES.ECONOMIC_SHORTAGE) return PROCESS_TYPES.DECLINE;
  if (type === EMERGENCE_TYPES.CIVILIZATION_ASCENT) return PROCESS_TYPES.CIVILIZATION_GROWTH;
  if (type === EMERGENCE_TYPES.RELIGIOUS_EXPANSION) return PROCESS_TYPES.RELIGIOUS_SPREAD;
  if (type === EMERGENCE_TYPES.CULTURAL_DOMINANCE) return PROCESS_TYPES.CULTURAL_SHIFT;
  if (type === EMERGENCE_TYPES.ORGANIZATION_HEGEMONY || type === EMERGENCE_TYPES.CITY_RISE) return PROCESS_TYPES.RISE;
  return PROCESS_TYPES.LIFE_ARC;
}

function hasActiveEmergence(world, type, targetType, targetId) {
  return Object.values(ensureEmergenceState(world).byId).some(emergence =>
    emergence.status === EMERGENCE_STATUS.ACTIVE && emergence.type === type && emergence.targetType === targetType && emergence.targetId === targetId
  );
}

function getEmergence(world, emergenceId) {
  return ensureEmergenceState(world).byId[emergenceId] || null;
}

function getEmergenceStats(world) {
  const state = ensureEmergenceState(world);
  return {
    total: Object.keys(state.byId).length,
    active: Object.values(state.byId).filter(item => item.status === EMERGENCE_STATUS.ACTIVE).length,
    byType: countIndex(state.indexes.byType),
    byStatus: countIndex(state.indexes.byStatus),
  };
}

function rebuildEmergenceIndexes(world) {
  const state = ensureEmergenceState(world);
  state.indexes = { byType: {}, byStatus: {}, byTarget: {} };
  for (const emergence of Object.values(state.byId)) indexEmergence(world, emergence);
}

function indexEmergence(world, emergence) {
  const state = ensureEmergenceState(world);
  addIndex(state.indexes.byType, emergence.type, emergence.id);
  addIndex(state.indexes.byStatus, emergence.status, emergence.id);
  if (emergence.targetType && emergence.targetId) addIndex(state.indexes.byTarget, `${emergence.targetType}:${emergence.targetId}`, emergence.id);
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

module.exports = {
  EMERGENCE_TYPES,
  EMERGENCE_STATUS,
  DEFAULT_EMERGENCE_OPTIONS,
  ensureEmergenceState,
  createEmergence,
  processEmergenceTick,
  getEmergence,
  getEmergenceStats,
  rebuildEmergenceIndexes,
};
