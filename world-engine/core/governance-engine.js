'use strict';

const { createInformation, INFORMATION_TYPES } = require('./information-engine');
const { createMemory } = require('./memory-engine');
const { createOpportunity, OPPORTUNITY_TYPES } = require('./opportunity-engine');

const GOVERNMENT_STATUS = {
  ACTIVE: 'active',
  UNSTABLE: 'unstable',
  COLLAPSED: 'collapsed',
};

const POLICY_KEYS = {
  TAX_RATE: 'taxRate',
  LAW_LEVEL: 'lawLevel',
  WELFARE: 'welfare',
  MILITARY: 'military',
  OPENNESS: 'openness',
};

const DEFAULT_GOVERNANCE_OPTIONS = {
  unrestThreshold: 70,
  collapseLegitimacy: 5,
  taxEfficiency: 0.08,
  defaultPolicies: {
    taxRate: 12,
    lawLevel: 50,
    welfare: 20,
    military: 30,
    openness: 40,
  },
};

function ensureGovernanceState(world) {
  if (!world.governance) {
    world.governance = {
      governments: {},
      indexes: { byStatus: {}, byOrganization: {}, byCity: {} },
      stats: { created: 0, updated: 0, collapsed: 0, unrestEvents: 0, taxCollected: 0 },
    };
  }
  return world.governance;
}

function createGovernment(world, input = {}) {
  if (!input.organizationId) throw new Error('Government requires organizationId');
  const org = world.organizations?.byId?.[input.organizationId];
  if (!org) throw new Error(`Missing organization ${input.organizationId}`);
  const state = ensureGovernanceState(world);
  const id = input.id || `government_${input.organizationId}`;
  const government = {
    id,
    organizationId: input.organizationId,
    name: input.name || `${org.name} Government`,
    status: input.status || GOVERNMENT_STATUS.ACTIVE,
    foundedTick: input.foundedTick ?? world.tick,
    collapsedTick: null,
    cityIds: Array.isArray(input.cityIds) ? [...input.cityIds] : [],
    subjectEntityIds: [],
    policies: { ...DEFAULT_GOVERNANCE_OPTIONS.defaultPolicies, ...(input.policies || {}) },
    treasury: Number(input.treasury ?? org.assets?.currency ?? 0),
    legitimacy: Number(input.legitimacy ?? Math.min(100, Number(org.reputation || 0) * 0.1 + Number(org.authority || 0) * 0.5)),
    unrest: Number(input.unrest || 10),
    enforcement: Number(input.enforcement || 30),
    services: Number(input.services || 20),
    memory: [],
    meta: { ...(input.meta || {}) },
  };
  state.governments[id] = government;
  state.stats.created += 1;
  recordGovernmentMemory(world, government, 'government.created', {});
  rebuildGovernanceIndexes(world);
  return government;
}

function processGovernanceTick(world, options = {}) {
  const config = { ...DEFAULT_GOVERNANCE_OPTIONS, ...(options || {}) };
  const created = syncGovernmentsFromOrganizations(world, config);
  const updated = [];
  const unrest = [];
  const collapsed = [];
  let taxCollected = 0;

  for (const government of Object.values(ensureGovernanceState(world).governments)) {
    if (government.status === GOVERNMENT_STATUS.COLLAPSED) continue;
    updateGovernmentSubjects(world, government.id);
    const tax = collectTaxes(world, government.id, config);
    taxCollected += tax;
    updateGovernmentMetrics(world, government.id, config);
    if (government.unrest >= config.unrestThreshold) {
      const event = createUnrestOpportunity(world, government);
      if (event) unrest.push(event);
    }
    if (government.legitimacy <= config.collapseLegitimacy && government.unrest >= 90) {
      government.status = GOVERNMENT_STATUS.COLLAPSED;
      government.collapsedTick = world.tick;
      collapsed.push(government.id);
      ensureGovernanceState(world).stats.collapsed += 1;
      recordGovernmentMemory(world, government, 'government.collapsed', {});
    } else if (government.unrest >= 50 || government.legitimacy < 25) {
      government.status = GOVERNMENT_STATUS.UNSTABLE;
    } else {
      government.status = GOVERNMENT_STATUS.ACTIVE;
    }
    updated.push(government.id);
  }

  const state = ensureGovernanceState(world);
  state.stats.updated += updated.length;
  state.stats.unrestEvents += unrest.length;
  state.stats.taxCollected += taxCollected;
  rebuildGovernanceIndexes(world);
  return { created, updated, unrest, collapsed, taxCollected, stats: getGovernanceStats(world) };
}

function syncGovernmentsFromOrganizations(world, options = {}) {
  const created = [];
  const existingOrgIds = new Set(Object.values(ensureGovernanceState(world).governments).map(g => g.organizationId));
  for (const org of Object.values(world.organizations?.byId || {})) {
    if (org.status === 'dissolved') continue;
    if (!['state', 'gang'].includes(org.type)) continue;
    if (existingOrgIds.has(org.id)) continue;
    created.push(createGovernment(world, {
      organizationId: org.id,
      cityIds: Object.values(world.cities?.byId || {}).filter(city => city.rulerOrganizationId === org.id || city.organizationIds?.includes(org.id)).map(city => city.id),
      policies: org.type === 'gang'
        ? { taxRate: 20, lawLevel: 20, welfare: 5, military: 45, openness: 20 }
        : options.defaultPolicies,
    }));
  }
  return created;
}

function updateGovernmentSubjects(world, governmentId) {
  const government = getGovernment(world, governmentId);
  if (!government) return null;
  const org = world.organizations?.byId?.[government.organizationId];
  const locationIds = new Set();
  if (org?.homeLocationId) locationIds.add(org.homeLocationId);
  for (const cityId of government.cityIds || []) {
    const city = world.cities?.byId?.[cityId];
    if (city?.locationId) locationIds.add(city.locationId);
  }
  const cities = Object.values(world.cities?.byId || {}).filter(city => city.organizationIds?.includes(government.organizationId));
  for (const city of cities) {
    government.cityIds = unique([...government.cityIds, city.id]);
    if (city.locationId) locationIds.add(city.locationId);
  }
  government.subjectEntityIds = Object.values(world.entities || {})
    .filter(entity => entity.status === 'alive' && locationIds.has(entity.locationId))
    .map(entity => entity.id);
  return government;
}

function collectTaxes(world, governmentId, options = {}) {
  const government = getGovernment(world, governmentId);
  if (!government) return 0;
  const taxRate = clamp(government.policies.taxRate, 0, 80) / 100;
  let collected = 0;
  for (const entityId of government.subjectEntityIds || []) {
    const entity = world.entities[entityId];
    if (!entity) continue;
    const wealth = Number(entity.resources?.currency || 0);
    const tax = Math.floor(wealth * taxRate * (options.taxEfficiency || DEFAULT_GOVERNANCE_OPTIONS.taxEfficiency));
    if (tax <= 0) continue;
    entity.resources.currency = wealth - tax;
    collected += tax;
  }
  government.treasury += collected;
  const org = world.organizations?.byId?.[government.organizationId];
  if (org) org.assets.currency = Number(org.assets?.currency || 0) + collected;
  if (collected > 0) recordGovernmentMemory(world, government, 'government.tax_collected', { amount: collected });
  return collected;
}

function updateGovernmentMetrics(world, governmentId) {
  const government = getGovernment(world, governmentId);
  if (!government) return null;
  const org = world.organizations?.byId?.[government.organizationId];
  const policies = government.policies;
  const citySecurity = average((government.cityIds || []).map(id => world.cities?.byId?.[id]?.security || 0));
  const subjectHappiness = average((government.subjectEntityIds || []).map(id => Number(world.entities[id]?.meta?.happiness ?? 50)));
  const cohesion = Number(org?.cohesion || 50);
  const reputation = Number(org?.reputation || 0);

  government.enforcement = clamp((policies.lawLevel || 0) * 0.5 + (policies.military || 0) * 0.4 + citySecurity * 0.1, 0, 100);
  government.services = clamp((policies.welfare || 0) * 0.6 + (government.treasury > 1000 ? 10 : 0), 0, 100);
  government.legitimacy = clamp(
    government.legitimacy
    + subjectHappiness * 0.02
    + cohesion * 0.02
    + reputation * 0.002
    + government.services * 0.03
    - policies.taxRate * 0.05
    - government.unrest * 0.03,
    0,
    100,
  );
  government.unrest = clamp(
    government.unrest
    + policies.taxRate * 0.04
    - government.enforcement * 0.02
    - government.services * 0.02
    - subjectHappiness * 0.015
    + (government.legitimacy < 25 ? 0.8 : -0.1),
    0,
    100,
  );
  return government;
}

function createUnrestOpportunity(world, government) {
  const existing = Object.values(world.opportunities?.byId || {}).find(opp => opp.status === 'active' && opp.type === 'crisis' && opp.payload?.governmentId === government.id);
  if (existing) return null;
  return createOpportunity(world, {
    type: OPPORTUNITY_TYPES.CRISIS,
    title: `unrest crisis: ${government.name}`,
    locationId: world.organizations?.byId?.[government.organizationId]?.homeLocationId || null,
    targetId: government.id,
    difficulty: Math.round(government.unrest),
    importance: 120,
    risk: { revolt: government.unrest },
    reward: { reputation: 100 },
    tags: ['governance', 'unrest'],
    payload: { governmentId: government.id, unrest: government.unrest, legitimacy: government.legitimacy },
  });
}

function setPolicy(world, governmentId, key, value) {
  const government = getGovernment(world, governmentId);
  if (!government) throw new Error(`Missing government ${governmentId}`);
  government.policies[key] = Number(value);
  recordGovernmentMemory(world, government, 'government.policy_changed', { key, value });
  return government;
}

function getGovernment(world, governmentId) {
  return ensureGovernanceState(world).governments[governmentId] || null;
}

function getGovernanceStats(world) {
  const state = ensureGovernanceState(world);
  return {
    total: Object.keys(state.governments).length,
    active: Object.values(state.governments).filter(g => g.status === GOVERNMENT_STATUS.ACTIVE).length,
    unstable: Object.values(state.governments).filter(g => g.status === GOVERNMENT_STATUS.UNSTABLE).length,
    collapsed: Object.values(state.governments).filter(g => g.status === GOVERNMENT_STATUS.COLLAPSED).length,
    byStatus: countIndex(state.indexes.byStatus),
  };
}

function getGovernmentChronicle(world, governmentId) {
  const government = getGovernment(world, governmentId);
  if (!government) return null;
  return {
    governmentId,
    name: government.name,
    status: government.status,
    organizationId: government.organizationId,
    foundedTick: government.foundedTick,
    collapsedTick: government.collapsedTick,
    policies: { ...government.policies },
    treasury: government.treasury,
    legitimacy: government.legitimacy,
    unrest: government.unrest,
    enforcement: government.enforcement,
    services: government.services,
    cityIds: [...government.cityIds],
    subjectCount: government.subjectEntityIds.length,
    memory: [...government.memory],
  };
}

function recordGovernmentMemory(world, government, type, payload = {}) {
  const memory = { id: `government_memory_${world.tick}_${government.memory.length + 1}`, tick: world.tick, type, payload: { governmentId: government.id, ...payload } };
  government.memory.push(memory);
  if (government.memory.length > 500) government.memory.shift();
  try {
    createInformation(world, {
      type: INFORMATION_TYPES.REPORT,
      summary: type,
      content: `${type} for ${government.name}`,
      confidence: 75,
      spreadability: 50,
      tags: ['governance', type],
      payload: memory.payload,
    });
  } catch (_) {}
  return memory;
}

function rebuildGovernanceIndexes(world) {
  const state = ensureGovernanceState(world);
  state.indexes = { byStatus: {}, byOrganization: {}, byCity: {} };
  for (const government of Object.values(state.governments)) {
    addIndex(state.indexes.byStatus, government.status, government.id);
    addIndex(state.indexes.byOrganization, government.organizationId, government.id);
    for (const cityId of government.cityIds || []) addIndex(state.indexes.byCity, cityId, government.id);
  }
}

function unique(items) { return Array.from(new Set(items)); }
function average(items) {
  const values = (Array.isArray(items) ? items : []).map(Number).filter(Number.isFinite);
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
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
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value || 0))); }

module.exports = {
  GOVERNMENT_STATUS,
  POLICY_KEYS,
  DEFAULT_GOVERNANCE_OPTIONS,
  ensureGovernanceState,
  createGovernment,
  processGovernanceTick,
  syncGovernmentsFromOrganizations,
  updateGovernmentSubjects,
  updateGovernmentMetrics,
  collectTaxes,
  setPolicy,
  getGovernment,
  getGovernmentChronicle,
  getGovernanceStats,
  rebuildGovernanceIndexes,
};
