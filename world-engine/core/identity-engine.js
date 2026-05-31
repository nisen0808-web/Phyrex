'use strict';

const IDENTITY_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  REVOKED: 'revoked',
};

const IDENTITY_SCOPE = {
  PERSONAL: 'personal',
  FAMILY: 'family',
  ORGANIZATION: 'organization',
  CONTRACT: 'contract',
  CITY: 'city',
  SPECIES: 'species',
  SOCIAL_CLASS: 'social_class',
};

const IDENTITY_TYPES = {
  CHILD: 'child',
  PARENT: 'parent',
  ELDER: 'elder',
  HEIR: 'heir',
  FOUNDER: 'founder',
  LEADER: 'leader',
  MEMBER: 'member',
  WORKER: 'worker',
  STUDENT: 'student',
  OFFICIAL: 'official',
  BELIEVER: 'believer',
  RESIDENT: 'resident',
  RULER: 'ruler',
  CONTROLLER: 'controller',
  SUBJECT: 'subject',
  FREE: 'free',
  BOUND: 'bound',
  NOBLE: 'noble',
  COMMONER: 'commoner',
};

const DEFAULT_IDENTITY_WEIGHTS = {
  leader: { authority: 80, obligation: 60, prestige: 80 },
  founder: { authority: 70, obligation: 50, prestige: 90 },
  heir: { authority: 45, obligation: 45, prestige: 55 },
  elder: { authority: 35, obligation: 35, prestige: 60 },
  member: { authority: 10, obligation: 25, prestige: 10 },
  worker: { authority: 5, obligation: 35, prestige: 8 },
  student: { authority: 3, obligation: 30, prestige: 12 },
  official: { authority: 45, obligation: 55, prestige: 45 },
  resident: { authority: 0, obligation: 10, prestige: 0 },
  controller: { authority: 55, obligation: 35, prestige: 35 },
  subject: { authority: -20, obligation: 70, prestige: -5 },
  bound: { authority: -45, obligation: 90, prestige: -20 },
  noble: { authority: 40, obligation: 20, prestige: 70 },
  commoner: { authority: 0, obligation: 10, prestige: 0 },
};

function ensureIdentityState(world) {
  if (!world.identities) {
    world.identities = {
      byId: {},
      byEntity: {},
      indexes: { byType: {}, byScope: {}, byStatus: {}, bySource: {} },
      stats: { created: 0, revoked: 0, synced: 0 },
    };
  }
  return world.identities;
}

function createIdentity(world, input = {}) {
  if (!input.entityId) throw new Error('Identity requires entityId');
  if (!world.entities[input.entityId]) throw new Error(`Missing entity ${input.entityId}`);
  const type = input.type || IDENTITY_TYPES.MEMBER;
  const defaults = DEFAULT_IDENTITY_WEIGHTS[type] || {};
  const id = input.id || `identity_${world.tick}_${input.entityId}_${Math.random().toString(16).slice(2)}`;
  const identity = {
    id,
    entityId: input.entityId,
    type,
    scope: input.scope || IDENTITY_SCOPE.PERSONAL,
    status: input.status || IDENTITY_STATUS.ACTIVE,
    sourceType: input.sourceType || null,
    sourceId: input.sourceId || null,
    title: input.title || type,
    authority: Number(input.authority ?? defaults.authority ?? 0),
    obligation: Number(input.obligation ?? defaults.obligation ?? 0),
    prestige: Number(input.prestige ?? defaults.prestige ?? 0),
    rank: Number(input.rank ?? 0),
    createdAt: input.createdAt ?? world.tick,
    updatedAt: input.updatedAt ?? world.tick,
    revokedAt: null,
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    payload: { ...(input.payload || {}) },
  };

  const state = ensureIdentityState(world);
  state.byId[id] = identity;
  if (!state.byEntity[input.entityId]) state.byEntity[input.entityId] = [];
  state.byEntity[input.entityId].push(id);
  state.stats.created += 1;
  indexIdentity(world, identity);
  applyIdentityMeta(world, input.entityId);
  return identity;
}

function upsertIdentity(world, input = {}) {
  const existing = findIdentity(world, input.entityId, input.scope, input.type, input.sourceType, input.sourceId);
  if (existing) {
    existing.status = input.status || IDENTITY_STATUS.ACTIVE;
    existing.title = input.title || existing.title;
    existing.authority = Number(input.authority ?? existing.authority);
    existing.obligation = Number(input.obligation ?? existing.obligation);
    existing.prestige = Number(input.prestige ?? existing.prestige);
    existing.rank = Number(input.rank ?? existing.rank);
    existing.updatedAt = world.tick;
    existing.payload = { ...existing.payload, ...(input.payload || {}) };
    applyIdentityMeta(world, input.entityId);
    return existing;
  }
  return createIdentity(world, input);
}

function revokeIdentity(world, identityId, reason = 'revoked') {
  const state = ensureIdentityState(world);
  const identity = state.byId[identityId];
  if (!identity) return null;
  identity.status = IDENTITY_STATUS.REVOKED;
  identity.revokedAt = world.tick;
  identity.payload.revocationReason = reason;
  state.stats.revoked += 1;
  applyIdentityMeta(world, identity.entityId);
  rebuildIdentityIndexes(world);
  return identity;
}

function processIdentityTick(world, options = {}) {
  ensureIdentityState(world);
  const synced = [];
  synced.push(...syncFamilyIdentities(world));
  synced.push(...syncOrganizationIdentities(world));
  synced.push(...syncContractIdentities(world));
  synced.push(...syncCityIdentities(world));
  synced.push(...syncSpeciesIdentities(world));
  syncSocialClassIdentities(world);
  rebuildIdentityIndexes(world);
  ensureIdentityState(world).stats.synced += synced.length;
  return { synced, stats: getIdentityStats(world) };
}

function syncFamilyIdentities(world) {
  const synced = [];
  for (const family of Object.values(world.families?.byId || {})) {
    for (const entityId of family.members || []) {
      if (!world.entities[entityId]) continue;
      synced.push(upsertIdentity(world, {
        entityId,
        type: IDENTITY_TYPES.MEMBER,
        scope: IDENTITY_SCOPE.FAMILY,
        sourceType: 'family',
        sourceId: family.id,
        title: `${family.name} member`,
        prestige: Math.min(80, Number(family.reputation || 0) * 0.1),
      }));
    }
    for (const entityId of family.elders || []) {
      if (!world.entities[entityId]) continue;
      synced.push(upsertIdentity(world, {
        entityId,
        type: IDENTITY_TYPES.ELDER,
        scope: IDENTITY_SCOPE.FAMILY,
        sourceType: 'family',
        sourceId: family.id,
        title: `${family.name} elder`,
        rank: 80,
      }));
    }
    for (const entityId of family.heirs || []) {
      if (!world.entities[entityId]) continue;
      synced.push(upsertIdentity(world, {
        entityId,
        type: IDENTITY_TYPES.HEIR,
        scope: IDENTITY_SCOPE.FAMILY,
        sourceType: 'family',
        sourceId: family.id,
        title: `${family.name} heir`,
        rank: 70,
      }));
    }
    if (family.founderId && world.entities[family.founderId]) {
      synced.push(upsertIdentity(world, {
        entityId: family.founderId,
        type: IDENTITY_TYPES.FOUNDER,
        scope: IDENTITY_SCOPE.FAMILY,
        sourceType: 'family',
        sourceId: family.id,
        title: `${family.name} founder`,
        rank: 100,
      }));
    }
  }
  return synced;
}

function syncOrganizationIdentities(world) {
  const synced = [];
  for (const org of Object.values(world.organizations?.byId || {})) {
    if (org.status === 'dissolved') continue;
    for (const entityId of org.members || []) {
      if (!world.entities[entityId]) continue;
      const role = org.roles?.[entityId] || 'member';
      synced.push(upsertIdentity(world, {
        entityId,
        type: roleToIdentityType(role),
        scope: IDENTITY_SCOPE.ORGANIZATION,
        sourceType: 'organization',
        sourceId: org.id,
        title: `${org.name} ${role}`,
        rank: role === 'leader' ? 100 : 20,
        authority: role === 'leader' ? org.authority : Math.round(org.authority * 0.2),
        obligation: role === 'leader' ? 60 : 35,
        prestige: Math.round(Number(org.reputation || 0) * (role === 'leader' ? 0.2 : 0.05)),
      }));
    }
  }
  return synced;
}

function syncContractIdentities(world) {
  const synced = [];
  for (const contract of Object.values(world.contracts?.byId || {})) {
    if (contract.status !== 'active') continue;
    if (world.entities[contract.controllerId]) {
      synced.push(upsertIdentity(world, {
        entityId: contract.controllerId,
        type: IDENTITY_TYPES.CONTROLLER,
        scope: IDENTITY_SCOPE.CONTRACT,
        sourceType: 'contract',
        sourceId: contract.id,
        title: contract.controllerRole,
        authority: contract.authority,
        obligation: contract.protection,
        prestige: contract.authority * 0.2,
      }));
    }
    if (world.entities[contract.subjectId]) {
      synced.push(upsertIdentity(world, {
        entityId: contract.subjectId,
        type: contract.type === 'bond' ? IDENTITY_TYPES.BOUND : IDENTITY_TYPES.SUBJECT,
        scope: IDENTITY_SCOPE.CONTRACT,
        sourceType: 'contract',
        sourceId: contract.id,
        title: contract.subjectRole,
        authority: -contract.authority * 0.4,
        obligation: contract.authority,
        prestige: -contract.authority * 0.05,
      }));
    }
  }
  return synced;
}

function syncCityIdentities(world) {
  const synced = [];
  for (const city of Object.values(world.cities?.byId || {})) {
    for (const entity of Object.values(world.entities || {})) {
      if (entity.status !== 'alive' || entity.locationId !== city.locationId) continue;
      synced.push(upsertIdentity(world, {
        entityId: entity.id,
        type: IDENTITY_TYPES.RESIDENT,
        scope: IDENTITY_SCOPE.CITY,
        sourceType: 'city',
        sourceId: city.id,
        title: `${city.name} resident`,
        prestige: Math.min(30, city.wealth * 0.001),
      }));
    }
  }
  return synced;
}

function syncSpeciesIdentities(world) {
  const synced = [];
  for (const entity of Object.values(world.entities || {})) {
    if (!entity.species) continue;
    synced.push(upsertIdentity(world, {
      entityId: entity.id,
      type: entity.species,
      scope: IDENTITY_SCOPE.SPECIES,
      sourceType: 'species',
      sourceId: entity.species,
      title: entity.species,
      prestige: 0,
    }));
  }
  return synced;
}

function syncSocialClassIdentities(world) {
  for (const entity of Object.values(world.entities || {})) {
    const score = calculateIdentityScore(world, entity.id);
    const type = score.prestige >= 80 || score.authority >= 80 ? IDENTITY_TYPES.NOBLE : IDENTITY_TYPES.COMMONER;
    upsertIdentity(world, {
      entityId: entity.id,
      type,
      scope: IDENTITY_SCOPE.SOCIAL_CLASS,
      sourceType: 'identity_score',
      sourceId: 'global',
      title: type,
      rank: type === IDENTITY_TYPES.NOBLE ? 70 : 10,
    });
  }
}

function roleToIdentityType(role) {
  if (role === 'leader') return IDENTITY_TYPES.LEADER;
  if (role === 'worker') return IDENTITY_TYPES.WORKER;
  if (role === 'student') return IDENTITY_TYPES.STUDENT;
  if (role === 'official') return IDENTITY_TYPES.OFFICIAL;
  if (role === 'believer') return IDENTITY_TYPES.BELIEVER;
  return IDENTITY_TYPES.MEMBER;
}

function findIdentity(world, entityId, scope, type, sourceType, sourceId) {
  const state = ensureIdentityState(world);
  const ids = state.byEntity[entityId] || [];
  return ids.map(id => state.byId[id]).find(identity => identity && identity.scope === scope && identity.type === type && identity.sourceType === sourceType && identity.sourceId === sourceId) || null;
}

function getEntityIdentities(world, entityId, filters = {}) {
  const state = ensureIdentityState(world);
  return (state.byEntity[entityId] || [])
    .map(id => state.byId[id])
    .filter(Boolean)
    .filter(identity => identity.status === (filters.status || IDENTITY_STATUS.ACTIVE))
    .filter(identity => !filters.scope || identity.scope === filters.scope)
    .filter(identity => !filters.type || identity.type === filters.type)
    .sort((a, b) => (b.rank + b.prestige + b.authority) - (a.rank + a.prestige + a.authority));
}

function calculateIdentityScore(world, entityId) {
  const identities = getEntityIdentities(world, entityId);
  return identities.reduce((score, identity) => {
    score.authority += Number(identity.authority || 0);
    score.obligation += Number(identity.obligation || 0);
    score.prestige += Number(identity.prestige || 0);
    score.rank += Number(identity.rank || 0);
    return score;
  }, { entityId, authority: 0, obligation: 0, prestige: 0, rank: 0 });
}

function applyIdentityMeta(world, entityId) {
  const entity = world.entities[entityId];
  if (!entity) return null;
  const score = calculateIdentityScore(world, entityId);
  entity.meta = { ...(entity.meta || {}) };
  entity.meta.identityScore = score;
  return score;
}

function getIdentityStats(world) {
  const state = ensureIdentityState(world);
  return {
    total: Object.keys(state.byId).length,
    byType: countIndex(state.indexes.byType),
    byScope: countIndex(state.indexes.byScope),
    byStatus: countIndex(state.indexes.byStatus),
  };
}

function rebuildIdentityIndexes(world) {
  const state = ensureIdentityState(world);
  state.indexes = { byType: {}, byScope: {}, byStatus: {}, bySource: {} };
  state.byEntity = {};
  for (const identity of Object.values(state.byId)) {
    if (!state.byEntity[identity.entityId]) state.byEntity[identity.entityId] = [];
    state.byEntity[identity.entityId].push(identity.id);
    indexIdentity(world, identity);
  }
}

function indexIdentity(world, identity) {
  const state = ensureIdentityState(world);
  addIndex(state.indexes.byType, identity.type, identity.id);
  addIndex(state.indexes.byScope, identity.scope, identity.id);
  addIndex(state.indexes.byStatus, identity.status, identity.id);
  if (identity.sourceId) addIndex(state.indexes.bySource, `${identity.sourceType}:${identity.sourceId}`, identity.id);
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
  IDENTITY_STATUS,
  IDENTITY_SCOPE,
  IDENTITY_TYPES,
  DEFAULT_IDENTITY_WEIGHTS,
  ensureIdentityState,
  createIdentity,
  upsertIdentity,
  revokeIdentity,
  processIdentityTick,
  getEntityIdentities,
  calculateIdentityScore,
  getIdentityStats,
  rebuildIdentityIndexes,
};
