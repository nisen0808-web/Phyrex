'use strict';

const { recordLifeEvent, LIFE_EVENT_TYPES } = require('./history-engine');
const { createContract, CONTRACT_TYPES } = require('./contract-engine');

const ORGANIZATION_STATUS = {
  ACTIVE: 'active',
  DECLINING: 'declining',
  DISSOLVED: 'dissolved',
};

const ORGANIZATION_TYPES = {
  GUILD: 'guild',
  SECT: 'sect',
  GANG: 'gang',
  STATE: 'state',
  CHURCH: 'church',
  COMPANY: 'company',
  SCHOOL: 'school',
  HOUSE: 'house',
};

const DEFAULT_ORG_TEMPLATES = {
  guild: { culture: ['trade', 'mutual_aid'], wealthBias: 1.2, authority: 30, goalBias: ['profit', 'network'] },
  sect: { culture: ['discipline', 'training'], wealthBias: 0.8, authority: 55, goalBias: ['power', 'legacy'] },
  gang: { culture: ['loyalty', 'territory'], wealthBias: 1.0, authority: 65, goalBias: ['control', 'survival'] },
  state: { culture: ['law', 'taxation'], wealthBias: 1.5, authority: 80, goalBias: ['order', 'expansion'] },
  church: { culture: ['faith', 'ritual'], wealthBias: 0.9, authority: 60, goalBias: ['belief', 'influence'] },
  company: { culture: ['profit', 'efficiency'], wealthBias: 1.4, authority: 35, goalBias: ['profit', 'expansion'] },
  school: { culture: ['knowledge', 'teaching'], wealthBias: 0.7, authority: 40, goalBias: ['knowledge', 'students'] },
  house: { culture: ['bloodline', 'legacy'], wealthBias: 1.0, authority: 50, goalBias: ['legacy', 'status'] },
};

function ensureOrganizationState(world) {
  if (!world.organizations) {
    world.organizations = {
      byId: {},
      indexes: {
        byType: {},
        byStatus: {},
        byMember: {},
        byLocation: {},
      },
      stats: { created: 0, dissolved: 0 },
    };
  }
  return world.organizations;
}

function createOrganization(world, input = {}) {
  if (!input.type) throw new Error('Organization requires type');
  const template = DEFAULT_ORG_TEMPLATES[input.type] || {};
  const id = input.id || `org_${world.tick}_${Math.random().toString(16).slice(2)}`;
  const leaderId = input.leaderId || null;
  const leader = leaderId ? world.entities[leaderId] : null;

  const org = {
    id,
    type: input.type,
    name: input.name || inferOrganizationName(input.type, id),
    status: ORGANIZATION_STATUS.ACTIVE,
    foundedTick: world.tick,
    dissolvedTick: null,
    leaderId,
    homeLocationId: input.homeLocationId || leader?.locationId || null,
    members: [],
    roles: {},
    assets: { currency: Number(input.currency || 0), ...(input.assets || {}) },
    reputation: Number(input.reputation || 10),
    authority: Number(input.authority ?? template.authority ?? 30),
    cohesion: Number(input.cohesion || 60),
    culture: Array.isArray(input.culture) ? [...input.culture] : [...(template.culture || [])],
    goals: Array.isArray(input.goals) ? [...input.goals] : createDefaultOrganizationGoals(input.type, template),
    allies: {},
    rivals: {},
    memory: [],
    meta: { ...(input.meta || {}) },
  };

  ensureOrganizationState(world).byId[id] = org;
  ensureOrganizationState(world).stats.created += 1;
  if (leaderId) addOrganizationMember(world, id, leaderId, { role: 'leader', createContract: false });
  recordOrganizationMemory(world, org, 'organization.created', { leaderId });
  rebuildOrganizationIndexes(world);
  return org;
}

function addOrganizationMember(world, organizationId, entityId, options = {}) {
  const org = getOrganization(world, organizationId);
  const entity = world.entities[entityId];
  if (!org) throw new Error(`Missing organization ${organizationId}`);
  if (!entity) throw new Error(`Missing entity ${entityId}`);

  if (!org.members.includes(entityId)) org.members.push(entityId);
  const role = options.role || 'member';
  org.roles[entityId] = role;
  entity.organizationIds = Array.isArray(entity.organizationIds) ? entity.organizationIds : [];
  if (!entity.organizationIds.includes(organizationId)) entity.organizationIds.push(organizationId);
  if (!entity.factionId) entity.factionId = organizationId;

  if (options.createContract !== false && role !== 'leader') {
    createContract(world, {
      type: role === 'student' ? CONTRACT_TYPES.APPRENTICESHIP : CONTRACT_TYPES.SERVICE,
      controllerId: org.leaderId || entityId,
      subjectId: entityId,
      authority: org.authority,
      protection: Math.round(org.cohesion / 3),
      tags: ['organization', organizationId, role],
      meta: { organizationId, role },
    });
  }

  recordOrganizationMemory(world, org, 'organization.member_added', { entityId, role });
  recordLifeEvent(world, {
    entityId,
    type: LIFE_EVENT_TYPES.WORLD_EVENT,
    title: `joined organization: ${org.name}`,
    summary: `${entity.name || entityId} joined ${org.name} as ${role}.`,
    importance: role === 'leader' ? 100 : 35,
    participants: [entityId, org.leaderId].filter(Boolean),
    locationId: entity.locationId,
    tags: ['organization', org.type, role],
    payload: { organizationId, role },
  });

  rebuildOrganizationIndexes(world);
  return org;
}

function removeOrganizationMember(world, organizationId, entityId, reason = 'removed') {
  const org = getOrganization(world, organizationId);
  const entity = world.entities[entityId];
  if (!org) return null;
  org.members = org.members.filter(id => id !== entityId);
  delete org.roles[entityId];
  if (entity?.organizationIds) entity.organizationIds = entity.organizationIds.filter(id => id !== organizationId);
  recordOrganizationMemory(world, org, 'organization.member_removed', { entityId, reason });
  rebuildOrganizationIndexes(world);
  return org;
}

function processOrganizationsTick(world, options = {}) {
  const changed = [];
  for (const org of Object.values(ensureOrganizationState(world).byId)) {
    if (org.status !== ORGANIZATION_STATUS.ACTIVE && org.status !== ORGANIZATION_STATUS.DECLINING) continue;
    updateOrganizationStats(world, org.id);
    processOrganizationGoals(world, org.id, options);
    if (org.members.length === 0 || org.cohesion <= 0) dissolveOrganization(world, org.id, org.members.length === 0 ? 'no_members' : 'lost_cohesion');
    else if (org.cohesion < 25) org.status = ORGANIZATION_STATUS.DECLINING;
    else org.status = ORGANIZATION_STATUS.ACTIVE;
    changed.push(org);
  }
  rebuildOrganizationIndexes(world);
  return changed;
}

function updateOrganizationStats(world, organizationId) {
  const org = getOrganization(world, organizationId);
  if (!org) return null;
  const members = org.members.map(id => world.entities[id]).filter(Boolean);
  const aliveMembers = members.filter(entity => entity.status === 'alive');
  const wealth = aliveMembers.reduce((sum, entity) => sum + Object.values(entity.resources || {}).reduce((a, b) => a + Number(b || 0), 0), 0);
  org.assets.currency = Math.round((Number(org.assets.currency || 0) * 0.98) + wealth * 0.02);
  org.reputation = Math.round(org.reputation + aliveMembers.length * 0.05 + org.assets.currency * 0.0005);
  org.cohesion = clamp(org.cohesion + aliveMembers.length * 0.01 - Math.max(0, org.members.length - aliveMembers.length) * 0.05, 0, 100);
  return org;
}

function processOrganizationGoals(world, organizationId, options = {}) {
  const org = getOrganization(world, organizationId);
  if (!org) return [];
  const actions = [];
  for (const goal of org.goals || []) {
    if (goal.status && goal.status !== 'active') continue;
    if (goal.type === 'recruit' && org.members.length < Number(goal.target || 10)) {
      const recruited = recruitOrganizationMember(world, org.id, options);
      if (recruited) actions.push({ type: 'recruit', entityId: recruited.id });
    }
    if (goal.type === 'accumulate_wealth' && Number(org.assets.currency || 0) < Number(goal.target || 1000)) {
      org.assets.currency = Number(org.assets.currency || 0) + Math.max(1, Math.round(org.members.length * 2));
      actions.push({ type: 'earn', amount: Math.max(1, Math.round(org.members.length * 2)) });
    }
    if (goal.type === 'expand_influence' && org.reputation < Number(goal.target || 500)) {
      org.reputation += Math.max(1, Math.round(org.members.length * 0.5));
      actions.push({ type: 'influence', amount: Math.max(1, Math.round(org.members.length * 0.5)) });
    }
  }
  if (actions.length) recordOrganizationMemory(world, org, 'organization.goal_progress', { actions });
  return actions;
}

function recruitOrganizationMember(world, organizationId, options = {}) {
  const org = getOrganization(world, organizationId);
  if (!org) return null;
  const candidates = Object.values(world.entities).filter(entity => entity.status === 'alive' && !org.members.includes(entity.id));
  candidates.sort((a, b) => scoreRecruitCandidate(world, org, b) - scoreRecruitCandidate(world, org, a));
  const candidate = candidates[0];
  if (!candidate || scoreRecruitCandidate(world, org, candidate) < (options.minRecruitScore || 20)) return null;
  addOrganizationMember(world, org.id, candidate.id, { role: inferRoleForOrganization(org), createContract: true });
  return candidate;
}

function scoreRecruitCandidate(world, org, entity) {
  const social = Number(entity.stats?.social || 0);
  const intelligence = Number(entity.stats?.intelligence || 0);
  const power = Number(entity.stats?.power || 0);
  const sameLocation = entity.locationId === org.homeLocationId ? 20 : 0;
  const cultureBonus = (org.culture || []).reduce((sum, culture) => sum + Number(entity.traits?.[culture] || 0) * 0.1, 0);
  return sameLocation + social + intelligence * 0.5 + power * 0.5 + cultureBonus;
}

function inferRoleForOrganization(org) {
  if (org.type === ORGANIZATION_TYPES.SECT || org.type === ORGANIZATION_TYPES.SCHOOL) return 'student';
  if (org.type === ORGANIZATION_TYPES.STATE) return 'official';
  if (org.type === ORGANIZATION_TYPES.GANG) return 'member';
  if (org.type === ORGANIZATION_TYPES.COMPANY || org.type === ORGANIZATION_TYPES.GUILD) return 'worker';
  if (org.type === ORGANIZATION_TYPES.CHURCH) return 'believer';
  return 'member';
}

function dissolveOrganization(world, organizationId, reason = 'dissolved') {
  const org = getOrganization(world, organizationId);
  if (!org || org.status === ORGANIZATION_STATUS.DISSOLVED) return org;
  org.status = ORGANIZATION_STATUS.DISSOLVED;
  org.dissolvedTick = world.tick;
  ensureOrganizationState(world).stats.dissolved += 1;
  recordOrganizationMemory(world, org, 'organization.dissolved', { reason });
  for (const entityId of [...org.members]) removeOrganizationMember(world, organizationId, entityId, reason);
  rebuildOrganizationIndexes(world);
  return org;
}

function setOrganizationRelation(world, sourceId, targetId, type, amount = 1) {
  const source = getOrganization(world, sourceId);
  const target = getOrganization(world, targetId);
  if (!source || !target) throw new Error('Missing organization relation participant');
  const bucket = type === 'ally' ? source.allies : source.rivals;
  bucket[targetId] = Number(bucket[targetId] || 0) + Number(amount || 0);
  recordOrganizationMemory(world, source, `organization.${type}`, { targetId, amount });
  return bucket[targetId];
}

function createDefaultOrganizationGoals(type, template = {}) {
  const goals = [{ type: 'recruit', target: type === 'state' ? 100 : 20, status: 'active' }];
  for (const bias of template.goalBias || []) {
    if (bias === 'profit') goals.push({ type: 'accumulate_wealth', target: 5000, status: 'active' });
    if (bias === 'expansion' || bias === 'influence' || bias === 'belief') goals.push({ type: 'expand_influence', target: 800, status: 'active' });
    if (bias === 'power') goals.push({ type: 'expand_influence', target: 1200, status: 'active' });
  }
  return goals;
}

function getOrganization(world, organizationId) {
  return ensureOrganizationState(world).byId[organizationId] || null;
}

function getOrganizationChronicle(world, organizationId) {
  const org = getOrganization(world, organizationId);
  if (!org) return null;
  return {
    organizationId,
    name: org.name,
    type: org.type,
    status: org.status,
    foundedTick: org.foundedTick,
    dissolvedTick: org.dissolvedTick,
    leaderId: org.leaderId,
    memberCount: org.members.length,
    assets: { ...org.assets },
    reputation: org.reputation,
    authority: org.authority,
    cohesion: org.cohesion,
    culture: [...org.culture],
    goals: [...org.goals],
    allies: { ...org.allies },
    rivals: { ...org.rivals },
    memory: [...org.memory],
  };
}

function recordOrganizationMemory(world, org, type, payload = {}) {
  const memory = {
    id: `org_memory_${world.tick}_${org.memory.length + 1}`,
    tick: world.tick,
    type,
    payload: { organizationId: org.id, ...payload },
  };
  org.memory.push(memory);
  if (org.memory.length > 1000) org.memory.shift();
  return memory;
}

function rebuildOrganizationIndexes(world) {
  const state = ensureOrganizationState(world);
  state.indexes = { byType: {}, byStatus: {}, byMember: {}, byLocation: {} };
  for (const org of Object.values(state.byId)) {
    addIndex(state.indexes.byType, org.type, org.id);
    addIndex(state.indexes.byStatus, org.status, org.id);
    if (org.homeLocationId) addIndex(state.indexes.byLocation, org.homeLocationId, org.id);
    for (const memberId of org.members) addIndex(state.indexes.byMember, memberId, org.id);
  }
}

function inferOrganizationName(type, id) {
  const prefix = {
    guild: 'Guild',
    sect: 'Sect',
    gang: 'Gang',
    state: 'State',
    church: 'Church',
    company: 'Company',
    school: 'School',
    house: 'House',
  }[type] || 'Organization';
  return `${prefix} ${id.slice(-6)}`;
}

function addIndex(index, key, value) {
  if (!index[key]) index[key] = [];
  if (!index[key].includes(value)) index[key].push(value);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

module.exports = {
  ORGANIZATION_STATUS,
  ORGANIZATION_TYPES,
  DEFAULT_ORG_TEMPLATES,
  ensureOrganizationState,
  createOrganization,
  addOrganizationMember,
  removeOrganizationMember,
  processOrganizationsTick,
  updateOrganizationStats,
  processOrganizationGoals,
  recruitOrganizationMember,
  dissolveOrganization,
  setOrganizationRelation,
  getOrganization,
  getOrganizationChronicle,
  rebuildOrganizationIndexes,
};
