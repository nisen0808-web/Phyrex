'use strict';

const { recordLifeEvent, LIFE_EVENT_TYPES } = require('./history-engine');

const DEFAULT_FAMILY_OPTIONS = {
  foundingReputation: 10,
  foundingWealth: 0,
  maxFamilyNameLength: 32,
};

const FAMILY_STATUS = {
  ACTIVE: 'active',
  EXTINCT: 'extinct',
  DORMANT: 'dormant',
};

function ensureFamilyState(world) {
  if (!world.families) {
    world.families = {
      byId: {},
      indexes: {
        byFounder: {},
        byGeneration: {},
        byLocation: {},
        byStatus: {},
      },
      stats: {
        founded: 0,
        extinct: 0,
      },
    };
  }
  return world.families;
}

function createFamily(world, input = {}) {
  ensureFamilyState(world);
  const founder = input.founderId ? world.entities[input.founderId] : null;
  const id = input.id || `family_${world.tick}_${Math.random().toString(16).slice(2)}`;
  const family = {
    id,
    name: normalizeFamilyName(input.name || inferFamilyName(founder, id)),
    status: FAMILY_STATUS.ACTIVE,
    founderId: input.founderId || null,
    foundedTick: input.foundedTick ?? world.tick,
    homeLocationId: input.homeLocationId || founder?.locationId || null,
    wealth: Number(input.wealth ?? DEFAULT_FAMILY_OPTIONS.foundingWealth),
    reputation: Number(input.reputation ?? DEFAULT_FAMILY_OPTIONS.foundingReputation),
    generation: Number(input.generation || 1),
    members: [],
    elders: [],
    heirs: [],
    traditions: Array.isArray(input.traditions) ? [...input.traditions] : [],
    rivals: {},
    allies: {},
    memory: [],
    meta: { ...(input.meta || {}) },
  };
  world.families.byId[id] = family;
  world.families.stats.founded += 1;

  if (founder) addMemberToFamily(world, id, founder.id, { role: 'founder', record: true });
  rebuildFamilyIndexes(world);
  return family;
}

function assignEntityToFamily(world, entityId, familyId, options = {}) {
  const entity = world.entities[entityId];
  const family = getFamily(world, familyId);
  if (!entity) throw new Error(`Missing entity ${entityId}`);
  if (!family) throw new Error(`Missing family ${familyId}`);
  return addMemberToFamily(world, familyId, entityId, options);
}

function addMemberToFamily(world, familyId, entityId, options = {}) {
  const entity = world.entities[entityId];
  const family = getFamily(world, familyId);
  if (!entity || !family) return null;

  removeEntityFromCurrentFamily(world, entityId);

  if (!family.members.includes(entityId)) family.members.push(entityId);
  entity.familyId = familyId;
  if (entity.demographics) entity.demographics.familyId = familyId;

  const role = options.role || entity.meta?.familyRole || 'member';
  entity.meta = { ...(entity.meta || {}), familyRole: role };
  if (role === 'founder' || role === 'elder') pushUnique(family.elders, entityId);
  if (role === 'heir') pushUnique(family.heirs, entityId);

  family.generation = Math.max(family.generation, entity.demographics?.generation || 1);
  if (options.record !== false) recordFamilyMemory(world, family, 'family.member_added', { entityId, role });

  if (options.record !== false) {
    recordLifeEvent(world, {
      entityId,
      type: LIFE_EVENT_TYPES.WORLD_EVENT,
      title: 'joined family',
      summary: `${entity.name || entityId} joined ${family.name}.`,
      importance: role === 'founder' ? 100 : 25,
      participants: [entityId, family.founderId].filter(Boolean),
      locationId: entity.locationId,
      tags: ['family'],
      payload: { familyId, role },
    });
  }

  rebuildFamilyIndexes(world);
  return family;
}

function removeEntityFromCurrentFamily(world, entityId) {
  const entity = world.entities[entityId];
  if (!entity) return;
  const familyId = entity.familyId || entity.demographics?.familyId;
  if (!familyId) return;
  const family = getFamily(world, familyId);
  if (!family) return;
  family.members = family.members.filter(id => id !== entityId);
  family.elders = family.elders.filter(id => id !== entityId);
  family.heirs = family.heirs.filter(id => id !== entityId);
}

function syncFamiliesFromPopulation(world, options = {}) {
  const families = ensureFamilyState(world);
  const created = [];
  const updated = [];

  for (const entity of Object.values(world.entities)) {
    if (!entity.demographics) continue;
    if (entity.demographics.familyId && families.byId[entity.demographics.familyId]) {
      const family = addMemberToFamily(world, entity.demographics.familyId, entity.id, { record: false });
      if (family) updated.push(family);
      continue;
    }

    const parentFamilyId = findParentFamily(world, entity);
    if (parentFamilyId) {
      const family = addMemberToFamily(world, parentFamilyId, entity.id, { record: false });
      if (family) updated.push(family);
      continue;
    }

    if (options.createForUnassigned !== false && entity.status === 'alive' && (entity.demographics.generation || 1) === 1) {
      const family = createFamily(world, { founderId: entity.id, name: options.nameFactory ? options.nameFactory(entity) : undefined });
      created.push(family);
    }
  }

  updateFamilyStatuses(world);
  rebuildFamilyIndexes(world);
  return { created, updated };
}

function findParentFamily(world, entity) {
  const father = entity.demographics?.fatherId ? world.entities[entity.demographics.fatherId] : null;
  const mother = entity.demographics?.motherId ? world.entities[entity.demographics.motherId] : null;
  return father?.familyId || father?.demographics?.familyId || mother?.familyId || mother?.demographics?.familyId || null;
}

function updateFamilyStatuses(world) {
  ensureFamilyState(world);
  for (const family of Object.values(world.families.byId)) {
    const aliveMembers = family.members.map(id => world.entities[id]).filter(entity => entity && entity.status === 'alive');
    if (!aliveMembers.length && family.status !== FAMILY_STATUS.EXTINCT) {
      family.status = FAMILY_STATUS.EXTINCT;
      world.families.stats.extinct += 1;
      recordFamilyMemory(world, family, 'family.extinct', {});
    } else if (aliveMembers.length && family.status !== FAMILY_STATUS.ACTIVE) {
      family.status = FAMILY_STATUS.ACTIVE;
      recordFamilyMemory(world, family, 'family.reactivated', {});
    }
    family.generation = Math.max(1, ...family.members.map(id => world.entities[id]?.demographics?.generation || 1));
    family.wealth = calculateFamilyWealth(world, family.id);
    family.reputation = calculateFamilyReputation(world, family.id);
    family.heirs = chooseFamilyHeirs(world, family.id);
    family.elders = chooseFamilyElders(world, family.id);
  }
}

function calculateFamilyWealth(world, familyId) {
  const family = getFamily(world, familyId);
  if (!family) return 0;
  return family.members.reduce((sum, id) => {
    const entity = world.entities[id];
    if (!entity) return sum;
    return sum + Object.values(entity.resources || {}).reduce((a, b) => a + Number(b || 0), 0);
  }, 0);
}

function calculateFamilyReputation(world, familyId) {
  const family = getFamily(world, familyId);
  if (!family) return 0;
  const base = family.members.length * 2 + family.generation * 8;
  const elderBonus = family.elders.length * 5;
  const historyBonus = family.memory.length * 0.5;
  return Math.round(base + elderBonus + historyBonus);
}

function chooseFamilyHeirs(world, familyId) {
  const family = getFamily(world, familyId);
  if (!family) return [];
  return family.members
    .map(id => world.entities[id])
    .filter(entity => entity && entity.status === 'alive')
    .sort((a, b) => scoreHeir(b) - scoreHeir(a))
    .slice(0, 3)
    .map(entity => entity.id);
}

function chooseFamilyElders(world, familyId) {
  const family = getFamily(world, familyId);
  if (!family) return [];
  return family.members
    .map(id => world.entities[id])
    .filter(entity => entity && entity.status === 'alive')
    .sort((a, b) => (b.demographics?.age || 0) - (a.demographics?.age || 0))
    .slice(0, 5)
    .map(entity => entity.id);
}

function scoreHeir(entity) {
  const age = entity.demographics?.age || 0;
  const power = Number(entity.stats?.power || 0);
  const social = Number(entity.stats?.social || 0);
  const intelligence = Number(entity.stats?.intelligence || 0);
  const adultBonus = age >= 18 ? 30 : 0;
  return adultBonus + power + social + intelligence + Math.max(0, 60 - Math.abs(age - 35));
}

function addFamilyTradition(world, familyId, tradition) {
  const family = getFamily(world, familyId);
  if (!family) throw new Error(`Missing family ${familyId}`);
  if (!family.traditions.includes(tradition)) family.traditions.push(tradition);
  recordFamilyMemory(world, family, 'family.tradition_added', { tradition });
  return family;
}

function setFamilyRelation(world, sourceFamilyId, targetFamilyId, type, amount = 1) {
  const source = getFamily(world, sourceFamilyId);
  const target = getFamily(world, targetFamilyId);
  if (!source || !target) throw new Error('Missing family relation participant');
  const bucket = type === 'ally' ? source.allies : source.rivals;
  bucket[targetFamilyId] = Number(bucket[targetFamilyId] || 0) + Number(amount || 0);
  recordFamilyMemory(world, source, `family.${type}`, { targetFamilyId, amount });
  return bucket[targetFamilyId];
}

function recordFamilyMemory(world, family, type, payload = {}) {
  const memory = {
    id: `family_memory_${world.tick}_${family.memory.length + 1}`,
    tick: world.tick,
    type,
    payload: { familyId: family.id, ...payload },
  };
  family.memory.push(memory);
  if (family.memory.length > 500) family.memory.shift();
  return memory;
}

function getFamily(world, familyId) {
  ensureFamilyState(world);
  return world.families.byId[familyId] || null;
}

function getFamilyChronicle(world, familyId) {
  const family = getFamily(world, familyId);
  if (!family) return null;
  const members = family.members.map(id => world.entities[id]).filter(Boolean);
  return {
    familyId,
    name: family.name,
    status: family.status,
    foundedTick: family.foundedTick,
    generation: family.generation,
    wealth: family.wealth,
    reputation: family.reputation,
    memberCount: members.length,
    aliveCount: members.filter(entity => entity.status === 'alive').length,
    elderIds: [...family.elders],
    heirIds: [...family.heirs],
    traditions: [...family.traditions],
    rivals: { ...family.rivals },
    allies: { ...family.allies },
    memory: [...family.memory],
  };
}

function rebuildFamilyIndexes(world) {
  const families = ensureFamilyState(world);
  families.indexes = { byFounder: {}, byGeneration: {}, byLocation: {}, byStatus: {} };
  for (const family of Object.values(families.byId)) {
    if (family.founderId) families.indexes.byFounder[family.founderId] = family.id;
    addIndex(families.indexes.byGeneration, String(family.generation), family.id);
    if (family.homeLocationId) addIndex(families.indexes.byLocation, family.homeLocationId, family.id);
    addIndex(families.indexes.byStatus, family.status, family.id);
  }
}

function inferFamilyName(founder, fallbackId) {
  if (!founder?.name) return fallbackId.replace(/^family_/, 'Family ');
  const token = String(founder.name).trim().split(/\s+/)[0];
  return `${token} Family`;
}

function normalizeFamilyName(name) {
  return String(name || 'Unnamed Family').slice(0, DEFAULT_FAMILY_OPTIONS.maxFamilyNameLength);
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function addIndex(index, key, value) {
  if (!index[key]) index[key] = [];
  if (!index[key].includes(value)) index[key].push(value);
}

module.exports = {
  DEFAULT_FAMILY_OPTIONS,
  FAMILY_STATUS,
  ensureFamilyState,
  createFamily,
  assignEntityToFamily,
  addMemberToFamily,
  syncFamiliesFromPopulation,
  updateFamilyStatuses,
  calculateFamilyWealth,
  calculateFamilyReputation,
  chooseFamilyHeirs,
  chooseFamilyElders,
  addFamilyTradition,
  setFamilyRelation,
  getFamily,
  getFamilyChronicle,
  rebuildFamilyIndexes,
};
