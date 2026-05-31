'use strict';

const RELIGION_STATUS = {
  ACTIVE: 'active',
  DECLINING: 'declining',
  EXTINCT: 'extinct',
};

const RELIGION_TYPES = {
  ANCESTOR: 'ancestor_worship',
  HERO: 'hero_worship',
  DEITY: 'deity_worship',
  DOCTRINE: 'doctrine',
  CIVIC: 'civic_cult',
};

const DEFAULT_RELIGION_OPTIONS = {
  spreadChance: 0.08,
  conversionThreshold: 20,
  memoryFaithInfluence: 0.03,
  cultureFaithInfluence: 0.05,
  organizationFaithInfluence: 0.08,
  decayRate: 0.01,
};

function ensureReligionState(world) {
  if (!world.religions) {
    world.religions = {
      byId: {},
      indexes: {
        byType: {},
        byStatus: {},
        byFounder: {},
        byBeliever: {},
        byOrganization: {},
      },
      stats: {
        created: 0,
        conversions: 0,
        spread: 0,
        extinct: 0,
      },
    };
  }
  return world.religions;
}

function createReligion(world, input = {}) {
  const state = ensureReligionState(world);
  const id = input.id || `religion_${world.tick}_${Math.random().toString(16).slice(2)}`;
  const religion = {
    id,
    name: input.name || inferReligionName(input),
    type: input.type || RELIGION_TYPES.DOCTRINE,
    status: RELIGION_STATUS.ACTIVE,
    founderEntityId: input.founderEntityId || null,
    founderFamilyId: input.founderFamilyId || null,
    originLocationId: input.originLocationId || null,
    createdAt: input.createdAt ?? world.tick,
    extinctAt: null,
    doctrines: Array.isArray(input.doctrines) ? [...input.doctrines] : [],
    taboos: Array.isArray(input.taboos) ? [...input.taboos] : [],
    virtues: Array.isArray(input.virtues) ? [...input.virtues] : [],
    believers: [],
    organizationIds: Array.isArray(input.organizationIds) ? [...input.organizationIds] : [],
    influence: Number(input.influence || 10),
    zeal: Number(input.zeal || 40),
    tolerance: Number(input.tolerance || 50),
    memory: [],
    meta: { ...(input.meta || {}) },
  };

  state.byId[id] = religion;
  state.stats.created += 1;
  for (const believerId of input.believers || []) addBeliever(world, id, believerId, { record: false });
  recordReligionMemory(world, religion, 'religion.created', {});
  rebuildReligionIndexes(world);
  return religion;
}

function processReligionTick(world, options = {}) {
  const config = { ...DEFAULT_RELIGION_OPTIONS, ...(options || {}) };
  const created = syncReligionsFromWorld(world, config);
  const spread = spreadReligions(world, config);
  const updated = updateReligionInfluence(world, config);
  rebuildReligionIndexes(world);
  return { created, spread, updated, stats: getReligionStats(world) };
}

function syncReligionsFromWorld(world, options = {}) {
  ensureReligionState(world);
  const created = [];
  created.push(...createAncestorReligions(world, options));
  created.push(...createHeroReligions(world, options));
  created.push(...createFaithOrganizationsReligions(world, options));
  return created;
}

function createAncestorReligions(world, options = {}) {
  const created = [];
  for (const family of Object.values(world.families?.byId || {})) {
    if ((family.generation || 1) < 3) continue;
    if (findReligionByFounderFamily(world, family.id)) continue;
    const founder = family.founderId ? world.entities[family.founderId] : null;
    created.push(createReligion(world, {
      type: RELIGION_TYPES.ANCESTOR,
      name: `${family.name} Ancestor Rite`,
      founderFamilyId: family.id,
      founderEntityId: family.founderId,
      originLocationId: founder?.locationId || family.homeLocationId || null,
      doctrines: ['honor_ancestors', 'preserve_bloodline'],
      virtues: ['legacy', 'loyalty'],
      believers: family.members || [],
      influence: Math.min(80, Number(family.reputation || 0) * 0.1 + family.generation * 2),
    }));
  }
  return created;
}

function createHeroReligions(world, options = {}) {
  const created = [];
  const candidates = Object.values(world.narrativeScores?.byEntity || {})
    .filter(score => score.totalScore >= 500)
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 5);

  for (const score of candidates) {
    if (findReligionByFounderEntity(world, score.entityId)) continue;
    const hero = world.entities[score.entityId];
    created.push(createReligion(world, {
      type: RELIGION_TYPES.HERO,
      name: `${hero?.name || score.entityId} Cult`,
      founderEntityId: score.entityId,
      originLocationId: hero?.locationId || null,
      doctrines: ['imitate_hero', 'remember_legend'],
      virtues: ['legacy', 'courage'],
      influence: Math.min(100, score.totalScore * 0.02),
    }));
  }
  return created;
}

function createFaithOrganizationsReligions(world, options = {}) {
  const created = [];
  for (const org of Object.values(world.organizations?.byId || {})) {
    if (org.type !== 'church') continue;
    if (findReligionByOrganization(world, org.id)) continue;
    created.push(createReligion(world, {
      type: RELIGION_TYPES.DEITY,
      name: `${org.name} Faith`,
      originLocationId: org.homeLocationId || null,
      organizationIds: [org.id],
      doctrines: ['faith', 'ritual', 'community'],
      virtues: ['faith', 'order'],
      believers: org.members || [],
      influence: Math.max(20, Number(org.reputation || 0) * 0.1),
      zeal: Math.min(100, Number(org.authority || 0)),
    }));
  }
  return created;
}

function spreadReligions(world, options = {}) {
  const spread = [];
  const groups = groupAliveEntitiesByLocation(world);
  for (const religion of Object.values(ensureReligionState(world).byId)) {
    if (religion.status !== RELIGION_STATUS.ACTIVE) continue;
    for (const entityIds of Object.values(groups)) {
      const localBelievers = entityIds.filter(id => religion.believers.includes(id));
      if (!localBelievers.length) continue;
      for (const candidateId of entityIds) {
        if (religion.believers.includes(candidateId)) continue;
        const chance = calculateConversionChance(world, religion, candidateId, localBelievers.length, options);
        if (Math.random() < chance) {
          addBeliever(world, religion.id, candidateId, { source: 'local_spread' });
          ensureReligionState(world).stats.spread += 1;
          spread.push({ religionId: religion.id, entityId: candidateId });
        }
      }
    }
  }
  return spread;
}

function calculateConversionChance(world, religion, entityId, localBelieverCount, options = {}) {
  const entity = world.entities[entityId];
  if (!entity) return 0;
  const base = options.spreadChance ?? DEFAULT_RELIGION_OPTIONS.spreadChance;
  const social = Number(entity.stats?.social || 0) / 100;
  const influence = clamp(religion.influence, 0, 100) / 100;
  const localPressure = Math.min(1, localBelieverCount / 10);
  const cultureFaith = getFaithCulturePressure(world, entity);
  return base * (0.5 + social) * (0.5 + influence) * (0.5 + localPressure) * (0.7 + cultureFaith);
}

function getFaithCulturePressure(world, entity) {
  let pressure = 0;
  for (const culture of Object.values(world.cultures?.byId || {})) {
    if (culture.ownerType === 'species' && culture.ownerId === entity.species) pressure += Number(culture.traits?.faith || 0) / 100;
    if (culture.ownerType === 'city') {
      const city = world.cities?.byId?.[culture.ownerId];
      if (city && city.locationId === entity.locationId) pressure += Number(culture.traits?.faith || 0) / 100;
    }
  }
  return Math.min(2, pressure);
}

function addBeliever(world, religionId, entityId, options = {}) {
  const religion = getReligion(world, religionId);
  if (!religion || !world.entities[entityId]) return null;
  if (!religion.believers.includes(entityId)) {
    religion.believers.push(entityId);
    religion.influence += 0.1;
    ensureReligionState(world).stats.conversions += 1;
    if (options.record !== false) recordReligionMemory(world, religion, 'religion.converted', { entityId, source: options.source || null });
  }
  return religion;
}

function updateReligionInfluence(world, options = {}) {
  const updated = [];
  for (const religion of Object.values(ensureReligionState(world).byId)) {
    const aliveBelievers = religion.believers.filter(id => world.entities[id]?.status === 'alive');
    const orgInfluence = religion.organizationIds.reduce((sum, id) => sum + Number(world.organizations?.byId?.[id]?.reputation || 0) * 0.01, 0);
    religion.believers = aliveBelievers;
    religion.influence = clamp(religion.influence + aliveBelievers.length * 0.02 + orgInfluence - (options.decayRate || DEFAULT_RELIGION_OPTIONS.decayRate), 0, 1000);
    if (!aliveBelievers.length && !religion.organizationIds.length && religion.influence <= 1 && religion.status !== RELIGION_STATUS.EXTINCT) {
      religion.status = RELIGION_STATUS.EXTINCT;
      religion.extinctAt = world.tick;
      ensureReligionState(world).stats.extinct += 1;
      recordReligionMemory(world, religion, 'religion.extinct', {});
    } else if (religion.influence < 5) {
      religion.status = RELIGION_STATUS.DECLINING;
    } else if (religion.status !== RELIGION_STATUS.EXTINCT) {
      religion.status = RELIGION_STATUS.ACTIVE;
    }
    updated.push(religion.id);
  }
  return updated;
}

function findReligionByFounderFamily(world, familyId) {
  return Object.values(ensureReligionState(world).byId).find(religion => religion.founderFamilyId === familyId) || null;
}

function findReligionByFounderEntity(world, entityId) {
  return Object.values(ensureReligionState(world).byId).find(religion => religion.founderEntityId === entityId && religion.type === RELIGION_TYPES.HERO) || null;
}

function findReligionByOrganization(world, organizationId) {
  return Object.values(ensureReligionState(world).byId).find(religion => religion.organizationIds.includes(organizationId)) || null;
}

function getReligion(world, religionId) {
  return ensureReligionState(world).byId[religionId] || null;
}

function getReligionChronicle(world, religionId) {
  const religion = getReligion(world, religionId);
  if (!religion) return null;
  return {
    religionId,
    name: religion.name,
    type: religion.type,
    status: religion.status,
    founderEntityId: religion.founderEntityId,
    founderFamilyId: religion.founderFamilyId,
    originLocationId: religion.originLocationId,
    believers: religion.believers.length,
    influence: religion.influence,
    zeal: religion.zeal,
    doctrines: [...religion.doctrines],
    virtues: [...religion.virtues],
    taboos: [...religion.taboos],
    memory: [...religion.memory],
  };
}

function getReligionStats(world) {
  const state = ensureReligionState(world);
  return {
    total: Object.keys(state.byId).length,
    active: Object.values(state.byId).filter(religion => religion.status === RELIGION_STATUS.ACTIVE).length,
    believers: Object.values(state.byId).reduce((sum, religion) => sum + religion.believers.length, 0),
    byType: countIndex(state.indexes.byType),
    byStatus: countIndex(state.indexes.byStatus),
  };
}

function recordReligionMemory(world, religion, type, payload = {}) {
  const memory = {
    id: `religion_memory_${world.tick}_${religion.memory.length + 1}`,
    tick: world.tick,
    type,
    payload: { religionId: religion.id, ...payload },
  };
  religion.memory.push(memory);
  if (religion.memory.length > 500) religion.memory.shift();
  return memory;
}

function rebuildReligionIndexes(world) {
  const state = ensureReligionState(world);
  state.indexes = { byType: {}, byStatus: {}, byFounder: {}, byBeliever: {}, byOrganization: {} };
  for (const religion of Object.values(state.byId)) {
    addIndex(state.indexes.byType, religion.type, religion.id);
    addIndex(state.indexes.byStatus, religion.status, religion.id);
    if (religion.founderEntityId) addIndex(state.indexes.byFounder, religion.founderEntityId, religion.id);
    for (const believerId of religion.believers || []) addIndex(state.indexes.byBeliever, believerId, religion.id);
    for (const orgId of religion.organizationIds || []) addIndex(state.indexes.byOrganization, orgId, religion.id);
  }
}

function groupAliveEntitiesByLocation(world) {
  const groups = {};
  for (const entity of Object.values(world.entities || {})) {
    if (entity.status !== 'alive') continue;
    const locationId = entity.locationId || 'unknown';
    if (!groups[locationId]) groups[locationId] = [];
    groups[locationId].push(entity.id);
  }
  return groups;
}

function inferReligionName(input = {}) {
  if (input.type === RELIGION_TYPES.ANCESTOR) return 'Ancestor Rite';
  if (input.type === RELIGION_TYPES.HERO) return 'Hero Cult';
  if (input.type === RELIGION_TYPES.DEITY) return 'Temple Faith';
  return 'Doctrine';
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
  RELIGION_STATUS,
  RELIGION_TYPES,
  DEFAULT_RELIGION_OPTIONS,
  ensureReligionState,
  createReligion,
  processReligionTick,
  syncReligionsFromWorld,
  spreadReligions,
  addBeliever,
  getReligion,
  getReligionChronicle,
  getReligionStats,
  rebuildReligionIndexes,
};
