'use strict';

const { createInformation, revealInformation, INFORMATION_TYPES } = require('./information-engine');
const { createMemory } = require('./memory-engine');

const OPPORTUNITY_STATUS = {
  ACTIVE: 'active',
  CLAIMED: 'claimed',
  EXPIRED: 'expired',
  FAILED: 'failed',
};

const OPPORTUNITY_TYPES = {
  RESOURCE_DISCOVERY: 'resource_discovery',
  TRADE: 'trade',
  ALLIANCE: 'alliance',
  LEARNING: 'learning',
  FAITH: 'faith',
  POWER_VACUUM: 'power_vacuum',
  MIGRATION: 'migration',
  CRISIS: 'crisis',
  RUMOR_LEAD: 'rumor_lead',
};

const DEFAULT_OPPORTUNITY_OPTIONS = {
  discoveryChance: 0.04,
  crisisChance: 0.02,
  claimChance: 0.2,
  defaultDuration: 120,
  maxActive: 200,
};

function ensureOpportunityState(world) {
  if (!world.opportunities) {
    world.opportunities = {
      byId: {},
      indexes: { byType: {}, byStatus: {}, byLocation: {}, byEntity: {} },
      stats: { created: 0, claimed: 0, expired: 0, failed: 0 },
    };
  }
  return world.opportunities;
}

function createOpportunity(world, input = {}) {
  const state = ensureOpportunityState(world);
  const id = input.id || `opp_${world.tick}_${Math.random().toString(16).slice(2)}`;
  const opportunity = {
    id,
    type: input.type || OPPORTUNITY_TYPES.RESOURCE_DISCOVERY,
    status: input.status || OPPORTUNITY_STATUS.ACTIVE,
    createdAt: world.tick,
    expiresAt: input.expiresAt ?? world.tick + (input.durationTicks || DEFAULT_OPPORTUNITY_OPTIONS.defaultDuration),
    discoveredByEntityId: input.discoveredByEntityId || null,
    claimedByEntityId: null,
    locationId: input.locationId || null,
    targetId: input.targetId || null,
    title: input.title || input.type || 'opportunity',
    difficulty: clamp(input.difficulty ?? 40, 0, 100),
    reward: { ...(input.reward || {}) },
    risk: { ...(input.risk || {}) },
    visibility: clamp(input.visibility ?? 40, 0, 100),
    importance: clamp(input.importance ?? 40, 0, 500),
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    payload: { ...(input.payload || {}) },
    memory: [],
  };

  state.byId[id] = opportunity;
  state.stats.created += 1;
  indexOpportunity(world, opportunity);
  announceOpportunity(world, opportunity);
  return opportunity;
}

function processOpportunityTick(world, options = {}) {
  const config = { ...DEFAULT_OPPORTUNITY_OPTIONS, ...(options || {}) };
  const generated = generateOpportunities(world, config);
  const claimed = claimOpportunities(world, config);
  const expired = expireOpportunities(world, config);
  rebuildOpportunityIndexes(world);
  return { generated, claimed, expired, stats: getOpportunityStats(world) };
}

function generateOpportunities(world, options = {}) {
  const active = Object.values(ensureOpportunityState(world).byId).filter(opp => opp.status === OPPORTUNITY_STATUS.ACTIVE);
  if (active.length >= (options.maxActive || DEFAULT_OPPORTUNITY_OPTIONS.maxActive)) return [];
  const generated = [];

  generated.push(...generateResourceDiscoveries(world, options));
  generated.push(...generateTradeOpportunities(world, options));
  generated.push(...generatePowerVacuumOpportunities(world, options));
  generated.push(...generateCrisisOpportunities(world, options));
  generated.push(...generateRumorLeads(world, options));

  return generated;
}

function generateResourceDiscoveries(world, options = {}) {
  const out = [];
  for (const location of Object.values(world.locations || {})) {
    if (Math.random() > (options.discoveryChance || DEFAULT_OPPORTUNITY_OPTIONS.discoveryChance)) continue;
    const resource = pickResource(location);
    out.push(createOpportunity(world, {
      type: OPPORTUNITY_TYPES.RESOURCE_DISCOVERY,
      title: `resource discovery: ${resource}`,
      locationId: location.id,
      reward: { resource, amount: 50 },
      difficulty: 30,
      importance: 60,
      tags: ['resource', resource],
      payload: { resource },
    }));
  }
  return out;
}

function generateTradeOpportunities(world, options = {}) {
  const out = [];
  const market = world.economy?.markets?.global;
  if (!market) return out;
  for (const [resource, item] of Object.entries(market.resources || {})) {
    const pressure = Number(item.demand || 0) / Math.max(1, Number(item.supply || 0));
    if (pressure < 1.5) continue;
    out.push(createOpportunity(world, {
      type: OPPORTUNITY_TYPES.TRADE,
      title: `shortage trade: ${resource}`,
      reward: { currency: Math.round(Number(item.price || 1) * 20) },
      difficulty: 45,
      importance: 50,
      tags: ['trade', resource],
      payload: { resource, pressure },
    }));
  }
  return out.slice(0, 3);
}

function generatePowerVacuumOpportunities(world, options = {}) {
  const out = [];
  for (const org of Object.values(world.organizations?.byId || {})) {
    if (org.status === 'dissolved') continue;
    if (org.leaderId && world.entities[org.leaderId]?.status === 'alive') continue;
    out.push(createOpportunity(world, {
      type: OPPORTUNITY_TYPES.POWER_VACUUM,
      title: `power vacuum: ${org.name}`,
      locationId: org.homeLocationId,
      targetId: org.id,
      reward: { authority: org.authority || 30 },
      difficulty: Math.min(90, Number(org.authority || 30)),
      importance: 100,
      tags: ['organization', 'power'],
      payload: { organizationId: org.id },
    }));
  }
  return out;
}

function generateCrisisOpportunities(world, options = {}) {
  const out = [];
  for (const city of Object.values(world.cities?.byId || {})) {
    if (Math.random() > (options.crisisChance || DEFAULT_OPPORTUNITY_OPTIONS.crisisChance)) continue;
    const lowFood = Number(world.economy?.markets?.global?.resources?.food?.supply || 0) < Math.max(100, city.population * 2);
    const lowSecurity = Number(city.security || 0) < 35;
    if (!lowFood && !lowSecurity) continue;
    out.push(createOpportunity(world, {
      type: OPPORTUNITY_TYPES.CRISIS,
      title: lowFood ? `food crisis: ${city.name}` : `security crisis: ${city.name}`,
      locationId: city.locationId,
      targetId: city.id,
      difficulty: lowFood ? 60 : 50,
      importance: 120,
      risk: { unrest: 30 },
      reward: { reputation: 80 },
      tags: ['crisis', lowFood ? 'food' : 'security'],
      payload: { cityId: city.id, lowFood, lowSecurity },
    }));
  }
  return out;
}

function generateRumorLeads(world, options = {}) {
  const out = [];
  for (const item of Object.values(world.information?.items || {})) {
    if (item.type !== 'rumor' || item.payload?.opportunityCreated) continue;
    item.payload.opportunityCreated = true;
    out.push(createOpportunity(world, {
      type: OPPORTUNITY_TYPES.RUMOR_LEAD,
      title: `rumor lead: ${item.summary}`,
      locationId: item.originLocationId,
      difficulty: 55,
      importance: 35,
      reward: { knowledge: 10 },
      tags: ['rumor'],
      payload: { informationId: item.id },
    }));
  }
  return out;
}

function claimOpportunities(world, options = {}) {
  const claimed = [];
  const active = Object.values(ensureOpportunityState(world).byId).filter(opp => opp.status === OPPORTUNITY_STATUS.ACTIVE);
  for (const opportunity of active) {
    const candidates = findOpportunityCandidates(world, opportunity);
    for (const entity of candidates) {
      const chance = calculateClaimChance(world, opportunity, entity, options);
      if (Math.random() > chance) continue;
      claimOpportunity(world, opportunity.id, entity.id);
      claimed.push({ opportunityId: opportunity.id, entityId: entity.id });
      break;
    }
  }
  return claimed;
}

function findOpportunityCandidates(world, opportunity) {
  return Object.values(world.entities || {})
    .filter(entity => entity.status === 'alive')
    .filter(entity => !opportunity.locationId || entity.locationId === opportunity.locationId)
    .sort((a, b) => scoreCandidate(world, opportunity, b) - scoreCandidate(world, opportunity, a))
    .slice(0, 10);
}

function scoreCandidate(world, opportunity, entity) {
  const intelligence = Number(entity.stats?.intelligence || 0);
  const social = Number(entity.stats?.social || 0);
  const power = Number(entity.stats?.power || 0);
  const wealth = Number(entity.resources?.currency || 0);
  const desire = entity.meta?.dominantDesire || '';
  let score = intelligence + social * 0.5 + power * 0.5 + Math.log10(Math.max(1, wealth)) * 5;
  if (opportunity.type === OPPORTUNITY_TYPES.TRADE && desire === 'wealth') score += 20;
  if (opportunity.type === OPPORTUNITY_TYPES.POWER_VACUUM && desire === 'power') score += 25;
  if (opportunity.type === OPPORTUNITY_TYPES.CRISIS && desire === 'recognition') score += 20;
  return score;
}

function calculateClaimChance(world, opportunity, entity, options = {}) {
  const base = options.claimChance || DEFAULT_OPPORTUNITY_OPTIONS.claimChance;
  const score = scoreCandidate(world, opportunity, entity);
  return clamp(base + (score - opportunity.difficulty) * 0.005, 0.01, 0.85);
}

function claimOpportunity(world, opportunityId, entityId) {
  const opportunity = getOpportunity(world, opportunityId);
  const entity = world.entities[entityId];
  if (!opportunity || !entity || opportunity.status !== OPPORTUNITY_STATUS.ACTIVE) return null;
  opportunity.status = OPPORTUNITY_STATUS.CLAIMED;
  opportunity.claimedByEntityId = entityId;
  opportunity.claimedAt = world.tick;
  applyOpportunityReward(world, opportunity, entity);
  ensureOpportunityState(world).stats.claimed += 1;
  recordOpportunityMemory(world, opportunity, 'opportunity.claimed', { entityId });
  createMemory(world, {
    ownerType: 'entity',
    ownerId: entityId,
    type: 'achievement',
    summary: `claimed opportunity: ${opportunity.title}`,
    importance: opportunity.importance,
    emotionalWeight: 30,
    tags: ['opportunity', opportunity.type],
    payload: { opportunityId },
  });
  return opportunity;
}

function applyOpportunityReward(world, opportunity, entity) {
  for (const [key, value] of Object.entries(opportunity.reward || {})) {
    if (['currency', 'food', 'wood', 'stone', 'metal', 'fuel', 'luxury', 'knowledge', 'service'].includes(key)) {
      entity.resources[key] = Number(entity.resources[key] || 0) + Number(value || 0);
    } else if (key === 'reputation') {
      entity.meta = { ...(entity.meta || {}) };
      entity.meta.reputation = Number(entity.meta.reputation || 0) + Number(value || 0);
    } else if (key === 'authority') {
      entity.meta = { ...(entity.meta || {}) };
      entity.meta.authority = Number(entity.meta.authority || 0) + Number(value || 0);
    }
  }
}

function expireOpportunities(world) {
  const expired = [];
  for (const opportunity of Object.values(ensureOpportunityState(world).byId)) {
    if (opportunity.status !== OPPORTUNITY_STATUS.ACTIVE) continue;
    if (world.tick < opportunity.expiresAt) continue;
    opportunity.status = OPPORTUNITY_STATUS.EXPIRED;
    expired.push(opportunity.id);
    ensureOpportunityState(world).stats.expired += 1;
  }
  return expired;
}

function announceOpportunity(world, opportunity) {
  try {
    const info = createInformation(world, {
      type: INFORMATION_TYPES.DISCOVERY,
      summary: opportunity.title,
      content: `Opportunity appeared: ${opportunity.title}`,
      confidence: 65,
      spreadability: opportunity.visibility,
      secrecy: Math.max(0, 100 - opportunity.visibility),
      originLocationId: opportunity.locationId,
      tags: ['opportunity', opportunity.type],
      payload: { opportunityId: opportunity.id },
    });
    if (opportunity.discoveredByEntityId) revealInformation(world, info.id, 'entity', opportunity.discoveredByEntityId, { confidence: 90 });
  } catch (_) {}
}

function getOpportunity(world, opportunityId) {
  return ensureOpportunityState(world).byId[opportunityId] || null;
}

function getOpportunityStats(world) {
  const state = ensureOpportunityState(world);
  return {
    total: Object.keys(state.byId).length,
    active: Object.values(state.byId).filter(opp => opp.status === OPPORTUNITY_STATUS.ACTIVE).length,
    claimed: Object.values(state.byId).filter(opp => opp.status === OPPORTUNITY_STATUS.CLAIMED).length,
    byType: countIndex(state.indexes.byType),
    byStatus: countIndex(state.indexes.byStatus),
  };
}

function rebuildOpportunityIndexes(world) {
  const state = ensureOpportunityState(world);
  state.indexes = { byType: {}, byStatus: {}, byLocation: {}, byEntity: {} };
  for (const opportunity of Object.values(state.byId)) indexOpportunity(world, opportunity);
}

function indexOpportunity(world, opportunity) {
  const state = ensureOpportunityState(world);
  addIndex(state.indexes.byType, opportunity.type, opportunity.id);
  addIndex(state.indexes.byStatus, opportunity.status, opportunity.id);
  if (opportunity.locationId) addIndex(state.indexes.byLocation, opportunity.locationId, opportunity.id);
  if (opportunity.discoveredByEntityId) addIndex(state.indexes.byEntity, opportunity.discoveredByEntityId, opportunity.id);
  if (opportunity.claimedByEntityId) addIndex(state.indexes.byEntity, opportunity.claimedByEntityId, opportunity.id);
}

function recordOpportunityMemory(world, opportunity, type, payload = {}) {
  const memory = { id: `opportunity_memory_${world.tick}_${opportunity.memory.length + 1}`, tick: world.tick, type, payload };
  opportunity.memory.push(memory);
  if (opportunity.memory.length > 100) opportunity.memory.shift();
  return memory;
}

function pickResource(location) {
  const keys = Object.keys(location.resources || {});
  if (keys.length) return keys[Math.floor(Math.random() * keys.length)];
  return ['food', 'wood', 'stone', 'metal'][Math.floor(Math.random() * 4)];
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
  OPPORTUNITY_STATUS,
  OPPORTUNITY_TYPES,
  DEFAULT_OPPORTUNITY_OPTIONS,
  ensureOpportunityState,
  createOpportunity,
  processOpportunityTick,
  generateOpportunities,
  claimOpportunity,
  getOpportunity,
  getOpportunityStats,
  rebuildOpportunityIndexes,
};
