'use strict';

const { nextWorldId } = require('./world-id-engine');
const {
  CULTURE_SCOPE,
  CULTURE_TRAITS,
  ensureCultureState,
  getCultureByOwner,
  upsertCulture,
} = require('./culture-engine');
const {
  RELIGION_STATUS,
  RELIGION_TYPES,
  ensureReligionState,
} = require('./religion-engine');

const CULTURE_BELIEF_FLOW_VERSION = 1;
const DEFAULT_CULTURE_BELIEF_FLOW_OPTIONS = {
  maxLinksPerTick: 160,
  traitTransferRatio: 0.22,
  faithInfluenceRatio: 0.35,
  organizationFaithThreshold: 20,
  eventLimit: 600,
};

function ensureCultureBeliefFlowState(world) {
  if (!world.cultureBeliefFlow || typeof world.cultureBeliefFlow !== 'object') {
    world.cultureBeliefFlow = {
      version: CULTURE_BELIEF_FLOW_VERSION,
      links: [],
      events: [],
      stats: {
        linksCreated: 0,
        cultureTransfers: 0,
        beliefCultureInfluences: 0,
        organizationLinks: 0,
      },
    };
  }
  const state = world.cultureBeliefFlow;
  if (!Array.isArray(state.links)) state.links = [];
  if (!Array.isArray(state.events)) state.events = [];
  if (!state.stats || typeof state.stats !== 'object') state.stats = {};
  for (const key of ['linksCreated', 'cultureTransfers', 'beliefCultureInfluences', 'organizationLinks']) {
    if (state.stats[key] === undefined) state.stats[key] = 0;
  }
  return state;
}

function processCultureBeliefFlowTick(world, options = {}) {
  ensureCultureState(world);
  ensureReligionState(world);
  const config = { ...DEFAULT_CULTURE_BELIEF_FLOW_OPTIONS, ...(options || {}) };
  const links = buildCultureBeliefLinks(world, config);
  const transfers = applyCultureTraitTransfers(world, links, config);
  const beliefCulture = applyBeliefCultureInfluence(world, config);
  const organizationLinks = linkBeliefOrganizations(world, config);
  const state = ensureCultureBeliefFlowState(world);
  state.links = links;
  trimEvents(world, config.eventLimit);
  return {
    links: links.length,
    transfers,
    beliefCulture,
    organizationLinks,
    stats: { ...state.stats },
  };
}

function buildCultureBeliefLinks(world, options = {}) {
  const state = ensureCultureBeliefFlowState(world);
  const links = [];
  const seen = new Set();
  for (const city of Object.values(world.cities?.byId || {})) {
    const cityCulture = getCultureByOwner(world, CULTURE_SCOPE.CITY, city.id);
    if (!cityCulture) continue;
    for (const org of Object.values(world.organizations?.byId || {})) {
      if (org.homeLocationId !== city.locationId) continue;
      const orgCulture = getCultureByOwner(world, CULTURE_SCOPE.ORGANIZATION, org.id);
      if (!orgCulture) continue;
      pushLink(world, links, seen, 'culture', cityCulture.id, 'culture', orgCulture.id, 'city_to_organization', scoreCityOrganizationLink(city, org));
      pushLink(world, links, seen, 'culture', orgCulture.id, 'culture', cityCulture.id, 'organization_to_city', scoreCityOrganizationLink(city, org) * 0.85);
    }
    for (const religion of Object.values(world.religions?.byId || {})) {
      if (religion.status !== RELIGION_STATUS.ACTIVE) continue;
      if (!religionMatchesCity(world, religion, city)) continue;
      pushLink(world, links, seen, 'religion', religion.id, 'culture', cityCulture.id, 'belief_to_city', scoreReligionCityLink(world, religion, city));
      if (Number(cityCulture.traits?.faith || 0) > 20) pushLink(world, links, seen, 'culture', cityCulture.id, 'religion', religion.id, 'city_to_belief', Number(cityCulture.traits.faith || 0));
    }
  }
  for (const religion of Object.values(world.religions?.byId || {})) {
    if (religion.status !== RELIGION_STATUS.ACTIVE) continue;
    for (const orgId of religion.organizationIds || []) {
      const orgCulture = getCultureByOwner(world, CULTURE_SCOPE.ORGANIZATION, orgId);
      if (orgCulture) pushLink(world, links, seen, 'religion', religion.id, 'culture', orgCulture.id, 'belief_to_organization', Math.min(100, Number(religion.influence || 0) + Number(religion.zeal || 0) * 0.5));
    }
  }
  const sorted = links.sort((left, right) => right.weight - left.weight || linkKey(left).localeCompare(linkKey(right))).slice(0, Number(options.maxLinksPerTick || DEFAULT_CULTURE_BELIEF_FLOW_OPTIONS.maxLinksPerTick));
  state.stats.linksCreated += sorted.length;
  return sorted;
}

function applyCultureTraitTransfers(world, links, options = {}) {
  const state = ensureCultureBeliefFlowState(world);
  const changed = [];
  for (const link of links) {
    if (link.sourceType !== 'culture' || link.targetType !== 'culture') continue;
    const source = world.cultures?.byId?.[link.sourceId];
    const target = world.cultures?.byId?.[link.targetId];
    if (!source || !target) continue;
    const traits = {};
    const ratio = Number(options.traitTransferRatio || DEFAULT_CULTURE_BELIEF_FLOW_OPTIONS.traitTransferRatio) * (Number(link.weight || 0) / 100);
    for (const [trait, value] of Object.entries(source.traits || {})) {
      if (Number(value || 0) <= 0) continue;
      traits[trait] = Math.min(100, Math.max(Number(target.traits?.[trait] || 0), Number(value || 0) * ratio));
    }
    if (!Object.keys(traits).length) continue;
    const culture = upsertCulture(world, {
      ownerType: target.ownerType,
      ownerId: target.ownerId,
      scope: target.scope,
      traits: { ...target.traits, ...traits },
      values: ['culture_flow'],
    });
    changed.push(culture.id);
    recordEvent(world, 'culture.transfer', { from: source.id, to: target.id, traits });
    state.stats.cultureTransfers += 1;
  }
  return changed;
}

function applyBeliefCultureInfluence(world, options = {}) {
  const state = ensureCultureBeliefFlowState(world);
  const changed = [];
  for (const city of Object.values(world.cities?.byId || {})) {
    const culture = getCultureByOwner(world, CULTURE_SCOPE.CITY, city.id);
    if (!culture) continue;
    const religions = Object.values(world.religions?.byId || {}).filter(religion => religion.status === RELIGION_STATUS.ACTIVE && religionMatchesCity(world, religion, city));
    const traits = {};
    for (const religion of religions) {
      const localBelievers = religion.believers.filter(entityId => world.entities?.[entityId]?.locationId === city.locationId).length;
      const pressure = Math.min(100, (localBelievers * 12) + Number(religion.influence || 0) * Number(options.faithInfluenceRatio || DEFAULT_CULTURE_BELIEF_FLOW_OPTIONS.faithInfluenceRatio));
      if (pressure <= 0) continue;
      traits[CULTURE_TRAITS.FAITH] = Math.max(Number(traits[CULTURE_TRAITS.FAITH] || 0), pressure);
      if (religion.type === RELIGION_TYPES.ANCESTOR || religion.type === RELIGION_TYPES.HERO) traits[CULTURE_TRAITS.LEGACY] = Math.max(Number(traits[CULTURE_TRAITS.LEGACY] || 0), pressure * 0.65);
      if (religion.type === RELIGION_TYPES.CIVIC || religion.type === RELIGION_TYPES.DOCTRINE) traits[CULTURE_TRAITS.ORDER] = Math.max(Number(traits[CULTURE_TRAITS.ORDER] || 0), pressure * 0.55);
    }
    if (!Object.keys(traits).length) continue;
    const merged = { ...culture.traits };
    for (const [trait, value] of Object.entries(traits)) merged[trait] = Math.max(Number(merged[trait] || 0), Number(value || 0));
    upsertCulture(world, { ownerType: culture.ownerType, ownerId: culture.ownerId, scope: culture.scope, traits: merged, values: ['belief_flow'] });
    changed.push(culture.id);
    recordEvent(world, 'belief.culture', { cultureId: culture.id, traits });
    state.stats.beliefCultureInfluences += 1;
  }
  return changed;
}

function linkBeliefOrganizations(world, options = {}) {
  const state = ensureCultureBeliefFlowState(world);
  const linked = [];
  for (const religion of Object.values(world.religions?.byId || {})) {
    if (religion.status !== RELIGION_STATUS.ACTIVE) continue;
    for (const org of Object.values(world.organizations?.byId || {})) {
      if ((religion.organizationIds || []).includes(org.id)) continue;
      if (!organizationMatchesReligion(world, org, religion, options)) continue;
      religion.organizationIds.push(org.id);
      linked.push({ religionId: religion.id, organizationId: org.id });
      recordEvent(world, 'belief.organization', { religionId: religion.id, organizationId: org.id });
      state.stats.organizationLinks += 1;
    }
  }
  return linked;
}

function organizationMatchesReligion(world, org, religion, options = {}) {
  if (!org || org.status === 'inactive') return false;
  if (religion.originLocationId && org.homeLocationId !== religion.originLocationId) return false;
  if (org.type === 'church') return true;
  const culture = getCultureByOwner(world, CULTURE_SCOPE.ORGANIZATION, org.id);
  const faith = Number(culture?.traits?.faith || 0);
  return faith >= Number(options.organizationFaithThreshold || DEFAULT_CULTURE_BELIEF_FLOW_OPTIONS.organizationFaithThreshold);
}

function religionMatchesCity(world, religion, city) {
  if (!religion || !city) return false;
  if (!religion.originLocationId) return true;
  if (religion.originLocationId === city.locationId) return true;
  return (religion.organizationIds || []).some(orgId => world.organizations?.byId?.[orgId]?.homeLocationId === city.locationId);
}

function scoreCityOrganizationLink(city, org) {
  return Math.min(100, 30 + Number(city.culture || 0) * 0.35 + Number(org.reputation || 0) * 0.08 + (org.members || []).length * 2);
}

function scoreReligionCityLink(world, religion, city) {
  const localBelievers = (religion.believers || []).filter(entityId => world.entities?.[entityId]?.locationId === city.locationId).length;
  return Math.min(100, Number(religion.influence || 0) * 0.4 + Number(religion.zeal || 0) * 0.25 + localBelievers * 8);
}

function pushLink(world, links, seen, sourceType, sourceId, targetType, targetId, reason, weight) {
  if (!sourceId || !targetId || Number(weight || 0) <= 0) return;
  const link = { sourceType, sourceId, targetType, targetId, reason, weight: Math.round(Number(weight || 0) * 100) / 100 };
  const key = linkKey(link);
  if (seen.has(key)) return;
  seen.add(key);
  links.push(link);
}

function recordEvent(world, type, payload = {}) {
  const state = ensureCultureBeliefFlowState(world);
  const event = { id: nextWorldId(world, 'culture_belief_flow', `culture_belief_flow.${type}`), tick: Number(world.tick || 0), type, payload: { ...payload } };
  state.events.push(event);
  return event;
}

function trimEvents(world, limit = DEFAULT_CULTURE_BELIEF_FLOW_OPTIONS.eventLimit) {
  const state = ensureCultureBeliefFlowState(world);
  if (state.events.length > limit) state.events = state.events.slice(-limit);
}

function linkKey(link) {
  return `${link.sourceType}:${link.sourceId}->${link.targetType}:${link.targetId}:${link.reason}`;
}

module.exports = {
  CULTURE_BELIEF_FLOW_VERSION,
  DEFAULT_CULTURE_BELIEF_FLOW_OPTIONS,
  ensureCultureBeliefFlowState,
  processCultureBeliefFlowTick,
  buildCultureBeliefLinks,
  applyCultureTraitTransfers,
  applyBeliefCultureInfluence,
  linkBeliefOrganizations,
};
