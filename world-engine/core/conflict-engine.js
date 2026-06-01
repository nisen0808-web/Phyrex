'use strict';

const { createOpportunity, OPPORTUNITY_TYPES } = require('./opportunity-engine');
const { createProcess, PROCESS_TYPES } = require('./process-engine');
const { createInformation, INFORMATION_TYPES } = require('./information-engine');
const { changeRelationship } = require('./relationship-engine');

const CONFLICT_STATUS = {
  TENSION: 'tension',
  ACTIVE: 'active',
  CEASEFIRE: 'ceasefire',
  RESOLVED: 'resolved',
};

const CONFLICT_TYPES = {
  PERSONAL: 'personal',
  FAMILY_FEUD: 'family_feud',
  ORGANIZATION_RIVALRY: 'organization_rivalry',
  CIVIL_WAR: 'civil_war',
  WAR: 'war',
  REVOLT: 'revolt',
  RELIGIOUS_CONFLICT: 'religious_conflict',
  RESOURCE_CONFLICT: 'resource_conflict',
};

const DEFAULT_CONFLICT_OPTIONS = {
  tensionThreshold: 60,
  activeThreshold: 100,
  resolveThreshold: 10,
  decayRate: 0.1,
  battleChance: 0.12,
  maxActiveConflicts: 200,
};

function ensureConflictState(world) {
  if (!world.conflicts) {
    world.conflicts = {
      byId: {},
      indexes: { byStatus: {}, byType: {}, byParticipant: {} },
      stats: { created: 0, escalated: 0, resolved: 0, battles: 0 },
    };
  }
  return world.conflicts;
}

function createConflict(world, input = {}) {
  const state = ensureConflictState(world);
  const id = input.id || `conflict_${world.tick}_${Math.random().toString(16).slice(2)}`;
  const conflict = {
    id,
    type: input.type || CONFLICT_TYPES.PERSONAL,
    status: input.status || CONFLICT_STATUS.TENSION,
    title: input.title || input.type || 'conflict',
    startedAt: world.tick,
    resolvedAt: null,
    sideA: normalizeSide(input.sideA || {}),
    sideB: normalizeSide(input.sideB || {}),
    locationIds: Array.isArray(input.locationIds) ? [...input.locationIds] : [],
    intensity: clamp(input.intensity ?? 20, 0, 200),
    casualties: 0,
    winner: null,
    causes: Array.isArray(input.causes) ? [...input.causes] : [],
    memory: [],
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    payload: { ...(input.payload || {}) },
  };
  state.byId[id] = conflict;
  state.stats.created += 1;
  indexConflict(world, conflict);
  announceConflict(world, conflict, 'conflict.created');
  createProcess(world, {
    type: PROCESS_TYPES.CONFLICT,
    title: conflict.title,
    ownerType: 'conflict',
    ownerId: conflict.id,
    participants: [...conflict.sideA.entityIds, ...conflict.sideB.entityIds],
    tags: ['conflict', conflict.type],
    payload: { conflictId: conflict.id },
  });
  return conflict;
}

function processConflictTick(world, options = {}) {
  const config = { ...DEFAULT_CONFLICT_OPTIONS, ...(options || {}) };
  const created = detectConflicts(world, config);
  const escalated = [];
  const battles = [];
  const resolved = [];

  for (const conflict of Object.values(ensureConflictState(world).byId)) {
    if (conflict.status === CONFLICT_STATUS.RESOLVED) continue;
    updateConflictIntensity(world, conflict.id, config);
    if (conflict.status === CONFLICT_STATUS.TENSION && conflict.intensity >= config.activeThreshold) {
      conflict.status = CONFLICT_STATUS.ACTIVE;
      ensureConflictState(world).stats.escalated += 1;
      escalated.push(conflict.id);
      announceConflict(world, conflict, 'conflict.escalated');
    }
    if (conflict.status === CONFLICT_STATUS.ACTIVE && Math.random() < config.battleChance) {
      battles.push(resolveBattle(world, conflict.id, config));
    }
    if (conflict.intensity <= config.resolveThreshold || sidePower(world, conflict.sideA) <= 0 || sidePower(world, conflict.sideB) <= 0) {
      resolveConflict(world, conflict.id, inferWinner(world, conflict));
      resolved.push(conflict.id);
    }
  }

  rebuildConflictIndexes(world);
  return { created, escalated, battles: battles.filter(Boolean), resolved, stats: getConflictStats(world) };
}

function detectConflicts(world, options = {}) {
  const active = Object.values(ensureConflictState(world).byId).filter(conflict => conflict.status !== CONFLICT_STATUS.RESOLVED);
  if (active.length >= options.maxActiveConflicts) return [];
  const created = [];
  created.push(...detectOrganizationRivalries(world, options));
  created.push(...detectFamilyFeuds(world, options));
  created.push(...detectGovernanceRevolts(world, options));
  created.push(...detectResourceConflicts(world, options));
  return created;
}

function detectOrganizationRivalries(world, options = {}) {
  const out = [];
  const orgs = Object.values(world.organizations?.byId || {}).filter(org => org.status !== 'dissolved');
  for (const org of orgs) {
    for (const [rivalId, value] of Object.entries(org.rivals || {})) {
      if (Number(value || 0) < options.tensionThreshold) continue;
      const rival = world.organizations?.byId?.[rivalId];
      if (!rival || hasConflictBetween(world, 'organization', org.id, 'organization', rivalId)) continue;
      out.push(createConflict(world, {
        type: CONFLICT_TYPES.ORGANIZATION_RIVALRY,
        title: `${org.name} vs ${rival.name}`,
        sideA: { type: 'organization', id: org.id, entityIds: org.members || [] },
        sideB: { type: 'organization', id: rival.id, entityIds: rival.members || [] },
        locationIds: unique([org.homeLocationId, rival.homeLocationId].filter(Boolean)),
        intensity: Number(value || 0),
        causes: ['rivalry'],
        tags: ['organization'],
      }));
    }
  }
  return out;
}

function detectFamilyFeuds(world, options = {}) {
  const out = [];
  const families = Object.values(world.families?.byId || {}).filter(family => family.status !== 'extinct');
  for (const family of families) {
    for (const enemyId of family.rivals || family.enemies || []) {
      const enemy = world.families?.byId?.[enemyId];
      if (!enemy || hasConflictBetween(world, 'family', family.id, 'family', enemy.id)) continue;
      out.push(createConflict(world, {
        type: CONFLICT_TYPES.FAMILY_FEUD,
        title: `${family.name} feud with ${enemy.name}`,
        sideA: { type: 'family', id: family.id, entityIds: family.members || [] },
        sideB: { type: 'family', id: enemy.id, entityIds: enemy.members || [] },
        intensity: 70,
        causes: ['family_rivalry'],
        tags: ['family'],
      }));
    }
  }
  return out;
}

function detectGovernanceRevolts(world, options = {}) {
  const out = [];
  for (const government of Object.values(world.governance?.governments || {})) {
    if (government.status === 'collapsed') continue;
    if (government.unrest < options.tensionThreshold) continue;
    if (hasConflictBetween(world, 'government', government.id, 'subjects', government.id)) continue;
    const org = world.organizations?.byId?.[government.organizationId];
    out.push(createConflict(world, {
      type: CONFLICT_TYPES.REVOLT,
      title: `revolt against ${government.name}`,
      sideA: { type: 'government', id: government.id, entityIds: org?.members || [] },
      sideB: { type: 'subjects', id: government.id, entityIds: government.subjectEntityIds || [] },
      locationIds: (government.cityIds || []).map(id => world.cities?.byId?.[id]?.locationId).filter(Boolean),
      intensity: government.unrest,
      causes: ['unrest', 'legitimacy_crisis'],
      tags: ['governance', 'revolt'],
    }));
  }
  return out;
}

function detectResourceConflicts(world, options = {}) {
  const out = [];
  for (const emergence of Object.values(world.emergence?.byId || {})) {
    if (emergence.type !== 'economic_shortage' || emergence.status !== 'active') continue;
    if (hasConflictBetween(world, 'resource', emergence.targetId, 'world', 'world')) continue;
    const participants = Object.values(world.entities || {}).filter(entity => entity.status === 'alive').slice(0, 20).map(entity => entity.id);
    out.push(createConflict(world, {
      type: CONFLICT_TYPES.RESOURCE_CONFLICT,
      title: `resource conflict: ${emergence.targetId}`,
      sideA: { type: 'resource_claimants', id: `${emergence.targetId}_a`, entityIds: participants.slice(0, 10) },
      sideB: { type: 'resource_claimants', id: `${emergence.targetId}_b`, entityIds: participants.slice(10) },
      intensity: emergence.severity,
      causes: ['shortage'],
      tags: ['resource', emergence.targetId],
    }));
  }
  return out;
}

function updateConflictIntensity(world, conflictId, options = {}) {
  const conflict = getConflict(world, conflictId);
  if (!conflict) return null;
  const hatred = sideRelationshipHatred(world, conflict.sideA, conflict.sideB);
  const powerDiff = Math.abs(sidePower(world, conflict.sideA) - sidePower(world, conflict.sideB));
  conflict.intensity = clamp(conflict.intensity + hatred * 0.01 + powerDiff * 0.001 - options.decayRate, 0, 200);
  return conflict;
}

function resolveBattle(world, conflictId) {
  const conflict = getConflict(world, conflictId);
  if (!conflict) return null;
  const powerA = sidePower(world, conflict.sideA);
  const powerB = sidePower(world, conflict.sideB);
  const total = Math.max(1, powerA + powerB);
  const sideAWins = Math.random() < powerA / total;
  const winner = sideAWins ? 'A' : 'B';
  const loserSide = sideAWins ? conflict.sideB : conflict.sideA;
  const casualties = applyBattleCasualties(world, loserSide, Math.max(1, Math.round(conflict.intensity / 50)));
  conflict.casualties += casualties.length;
  conflict.intensity = clamp(conflict.intensity + 5 - casualties.length, 0, 200);
  ensureConflictState(world).stats.battles += 1;
  recordConflictMemory(world, conflict, 'conflict.battle', { winner, casualties });
  for (const entityId of casualties) {
    const entity = world.entities[entityId];
    if (!entity) continue;
    entity.status = 'dead';
    entity.stats.health = 0;
  }
  return { conflictId, winner, casualties };
}

function applyBattleCasualties(world, side, count) {
  const alive = (side.entityIds || []).map(id => world.entities[id]).filter(entity => entity?.status === 'alive');
  alive.sort((a, b) => Number(a.stats?.power || 0) - Number(b.stats?.power || 0));
  return alive.slice(0, count).map(entity => entity.id);
}

function resolveConflict(world, conflictId, winner = null) {
  const conflict = getConflict(world, conflictId);
  if (!conflict || conflict.status === CONFLICT_STATUS.RESOLVED) return conflict;
  conflict.status = CONFLICT_STATUS.RESOLVED;
  conflict.resolvedAt = world.tick;
  conflict.winner = winner;
  ensureConflictState(world).stats.resolved += 1;
  recordConflictMemory(world, conflict, 'conflict.resolved', { winner });
  announceConflict(world, conflict, 'conflict.resolved');
  return conflict;
}

function inferWinner(world, conflict) {
  const powerA = sidePower(world, conflict.sideA);
  const powerB = sidePower(world, conflict.sideB);
  if (Math.abs(powerA - powerB) < 5) return 'draw';
  return powerA > powerB ? 'A' : 'B';
}

function sidePower(world, side) {
  let power = 0;
  for (const id of side.entityIds || []) {
    const entity = world.entities[id];
    if (entity?.status === 'alive') power += Number(entity.stats?.power || 1) + Number(entity.meta?.authority || 0) * 0.2;
  }
  if (side.type === 'organization') power += Number(world.organizations?.byId?.[side.id]?.authority || 0);
  if (side.type === 'government') power += Number(world.governance?.governments?.[side.id]?.enforcement || 0);
  return power;
}

function sideRelationshipHatred(world, sideA, sideB) {
  let hatred = 0;
  for (const a of sideA.entityIds || []) {
    for (const b of sideB.entityIds || []) {
      hatred += Number(world.relationships?.[`${a}->${b}`]?.hatred || 0);
      hatred += Number(world.relationships?.[`${b}->${a}`]?.hatred || 0);
    }
  }
  return hatred;
}

function hasConflictBetween(world, typeA, idA, typeB, idB) {
  return Object.values(ensureConflictState(world).byId).some(conflict => {
    if (conflict.status === CONFLICT_STATUS.RESOLVED) return false;
    const a = `${conflict.sideA.type}:${conflict.sideA.id}`;
    const b = `${conflict.sideB.type}:${conflict.sideB.id}`;
    return (a === `${typeA}:${idA}` && b === `${typeB}:${idB}`) || (a === `${typeB}:${idB}` && b === `${typeA}:${idA}`);
  });
}

function announceConflict(world, conflict, type) {
  try {
    createInformation(world, {
      type: INFORMATION_TYPES.REPORT,
      summary: `${type}: ${conflict.title}`,
      content: `${type}: ${conflict.title}`,
      confidence: 80,
      spreadability: 80,
      tags: ['conflict', conflict.type, type],
      payload: { conflictId: conflict.id, status: conflict.status, intensity: conflict.intensity },
    });
  } catch (_) {}
}

function recordConflictMemory(world, conflict, type, payload = {}) {
  const memory = { id: `conflict_memory_${world.tick}_${conflict.memory.length + 1}`, tick: world.tick, type, payload: { conflictId: conflict.id, ...payload } };
  conflict.memory.push(memory);
  if (conflict.memory.length > 500) conflict.memory.shift();
  return memory;
}

function getConflict(world, conflictId) {
  return ensureConflictState(world).byId[conflictId] || null;
}

function getConflictStats(world) {
  const state = ensureConflictState(world);
  return {
    total: Object.keys(state.byId).length,
    active: Object.values(state.byId).filter(c => c.status === CONFLICT_STATUS.ACTIVE).length,
    tension: Object.values(state.byId).filter(c => c.status === CONFLICT_STATUS.TENSION).length,
    resolved: Object.values(state.byId).filter(c => c.status === CONFLICT_STATUS.RESOLVED).length,
    byType: countIndex(state.indexes.byType),
    byStatus: countIndex(state.indexes.byStatus),
  };
}

function getConflictChronicle(world, conflictId) {
  const conflict = getConflict(world, conflictId);
  if (!conflict) return null;
  return {
    conflictId,
    type: conflict.type,
    status: conflict.status,
    title: conflict.title,
    startedAt: conflict.startedAt,
    resolvedAt: conflict.resolvedAt,
    sideA: { ...conflict.sideA },
    sideB: { ...conflict.sideB },
    intensity: conflict.intensity,
    casualties: conflict.casualties,
    winner: conflict.winner,
    causes: [...conflict.causes],
    memory: [...conflict.memory],
  };
}

function rebuildConflictIndexes(world) {
  const state = ensureConflictState(world);
  state.indexes = { byStatus: {}, byType: {}, byParticipant: {} };
  for (const conflict of Object.values(state.byId)) indexConflict(world, conflict);
}

function indexConflict(world, conflict) {
  const state = ensureConflictState(world);
  addIndex(state.indexes.byStatus, conflict.status, conflict.id);
  addIndex(state.indexes.byType, conflict.type, conflict.id);
  for (const id of [...(conflict.sideA.entityIds || []), ...(conflict.sideB.entityIds || [])]) addIndex(state.indexes.byParticipant, id, conflict.id);
}

function normalizeSide(side) {
  return {
    type: side.type || 'unknown',
    id: side.id || 'unknown',
    entityIds: Array.isArray(side.entityIds) ? [...side.entityIds] : [],
  };
}

function unique(items) { return Array.from(new Set(items)); }
function countIndex(index) {
  const out = {};
  for (const [key, value] of Object.entries(index || {})) out[key] = value.length;
  return out;
}
function addIndex(index, key, value) {
  if (!index[key]) index[key] = [];
  if (!index[key].includes(value)) index[key].push(value);
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value || 0))); }

module.exports = {
  CONFLICT_STATUS,
  CONFLICT_TYPES,
  DEFAULT_CONFLICT_OPTIONS,
  ensureConflictState,
  createConflict,
  processConflictTick,
  detectConflicts,
  resolveBattle,
  resolveConflict,
  getConflict,
  getConflictStats,
  getConflictChronicle,
  rebuildConflictIndexes,
};
