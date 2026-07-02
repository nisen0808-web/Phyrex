'use strict';

const { nextWorldId } = require('./world-id-engine');
const {
  INFORMATION_STATUS,
  getKnownInformation,
  revealInformation,
  ensureInformationState,
} = require('./information-engine');
const {
  MEMORY_SCOPE,
  MEMORY_TYPES,
  createMemory,
  getMemories,
  ensureMemoryState,
} = require('./memory-engine');
const {
  CULTURE_SCOPE,
  CULTURE_TRAITS,
  getCultureByOwner,
  upsertCulture,
} = require('./culture-engine');
const {
  RELIGION_STATUS,
  ensureReligionState,
  addBeliever,
} = require('./religion-engine');

const INFO_FLOW_VERSION = 1;
const DEFAULT_INFO_FLOW_OPTIONS = {
  maxLinksPerTick: 120,
  maxInformationPerLink: 4,
  minShareScore: 18,
  memoryConfidenceThreshold: 65,
  cultureConfidenceThreshold: 70,
  religionConfidenceThreshold: 70,
  eventLimit: 600,
};

function ensureInfoFlowState(world) {
  if (!world.infoFlow || typeof world.infoFlow !== 'object') {
    world.infoFlow = {
      version: INFO_FLOW_VERSION,
      links: [],
      events: [],
      stats: {
        linksCreated: 0,
        informationShared: 0,
        memoriesCreated: 0,
        cultureInfluences: 0,
        religionLinks: 0,
      },
    };
  }
  const state = world.infoFlow;
  if (!Array.isArray(state.links)) state.links = [];
  if (!Array.isArray(state.events)) state.events = [];
  if (!state.stats || typeof state.stats !== 'object') state.stats = {};
  for (const key of ['linksCreated', 'informationShared', 'memoriesCreated', 'cultureInfluences', 'religionLinks']) {
    if (state.stats[key] === undefined) state.stats[key] = 0;
  }
  return state;
}

function processInfoFlowTick(world, options = {}) {
  ensureInformationState(world);
  ensureMemoryState(world);
  ensureReligionState(world);
  const state = ensureInfoFlowState(world);
  const config = { ...DEFAULT_INFO_FLOW_OPTIONS, ...(options || {}) };
  const links = buildInfoFlowLinks(world, config);
  const shared = shareInformationAcrossLinks(world, links, config);
  const memories = consolidateInformationMemories(world, config);
  const culture = applyInformationCultureInfluence(world, config);
  const religion = applyInformationReligionLinks(world, config);
  state.links = links.slice(0, config.maxLinksPerTick);
  trimInfoFlowEvents(world, config.eventLimit);
  return {
    links: links.length,
    shared,
    memories,
    culture,
    religion,
    stats: { ...state.stats },
  };
}

function buildInfoFlowLinks(world, options = {}) {
  const links = [];
  const seen = new Set();
  const groups = groupAliveEntitiesByLocation(world);
  for (const [locationId, entityIds] of Object.entries(groups)) {
    const city = findCityByLocation(world, locationId);
    for (const sourceId of entityIds) {
      for (const targetId of entityIds) {
        if (sourceId !== targetId) pushLink(world, links, seen, 'entity', sourceId, 'entity', targetId, 'same_location', 65);
      }
      if (city) {
        pushLink(world, links, seen, 'entity', sourceId, 'city', city.id, 'local_city', 55);
        pushLink(world, links, seen, 'city', city.id, 'entity', sourceId, 'city_context', 35);
      }
      for (const orgId of getEntityOrganizationIds(world, sourceId)) {
        pushLink(world, links, seen, 'entity', sourceId, 'organization', orgId, 'member_to_organization', 60);
        pushLink(world, links, seen, 'organization', orgId, 'entity', sourceId, 'organization_to_member', 55);
        if (city) pushLink(world, links, seen, 'organization', orgId, 'city', city.id, 'organization_city', 40);
      }
    }
  }
  return links
    .sort((left, right) => right.weight - left.weight || linkKey(left).localeCompare(linkKey(right)))
    .slice(0, Math.max(0, Number(options.maxLinksPerTick || DEFAULT_INFO_FLOW_OPTIONS.maxLinksPerTick)));
}

function pushLink(world, links, seen, sourceType, sourceId, targetType, targetId, reason, weight) {
  if (!sourceId || !targetId) return;
  const link = { sourceType, sourceId, targetType, targetId, reason, weight: Number(weight || 0) };
  const key = linkKey(link);
  if (seen.has(key)) return;
  seen.add(key);
  links.push(link);
  const state = ensureInfoFlowState(world);
  state.stats.linksCreated += 1;
}

function shareInformationAcrossLinks(world, links, options = {}) {
  const state = ensureInfoFlowState(world);
  const shared = [];
  for (const link of links) {
    const known = getKnownInformation(world, link.sourceType, link.sourceId, { status: INFORMATION_STATUS.ACTIVE })
      .sort((left, right) => scoreKnownForFlow(right) - scoreKnownForFlow(left))
      .slice(0, Math.max(1, Number(options.maxInformationPerLink || DEFAULT_INFO_FLOW_OPTIONS.maxInformationPerLink)));
    for (const entry of known) {
      const item = entry.item;
      const score = calculateShareScore(item, entry, link);
      if (score < (options.minShareScore ?? DEFAULT_INFO_FLOW_OPTIONS.minShareScore)) continue;
      const confidence = Math.max(5, Math.min(100, Number(entry.confidence || 0) * (link.weight / 100) - Number(item.secrecy || 0) * 0.05));
      const revealed = revealInformation(world, item.id, link.targetType, link.targetId, {
        confidence,
        sourceOwnerType: link.sourceType,
        sourceOwnerId: link.sourceId,
        tags: ['info_flow', link.reason],
        maxKnownItemsPerOwner: options.maxKnownItemsPerOwner,
      });
      if (!revealed) continue;
      const event = recordInfoFlowEvent(world, 'information.shared', { ...link, informationId: item.id, confidence });
      shared.push(event);
      state.stats.informationShared += 1;
    }
  }
  return shared;
}

function consolidateInformationMemories(world, options = {}) {
  const state = ensureInfoFlowState(world);
  const created = [];
  const information = ensureInformationState(world);
  for (const [key, entries] of Object.entries(information.knownBy || {})) {
    const { ownerType, ownerId } = parseOwnerKey(key);
    if (!['entity', 'organization', 'city'].includes(ownerType)) continue;
    for (const entry of entries || []) {
      if (Number(entry.confidence || 0) < (options.memoryConfidenceThreshold ?? DEFAULT_INFO_FLOW_OPTIONS.memoryConfidenceThreshold)) continue;
      const item = information.items[entry.informationId];
      if (!item || item.status !== INFORMATION_STATUS.ACTIVE) continue;
      if (hasInformationMemory(world, ownerType, ownerId, item.id)) continue;
      const memory = createMemory(world, {
        ownerType,
        ownerId,
        scope: ownerType,
        type: item.type === 'rumor' ? MEMORY_TYPES.RUMOR : MEMORY_TYPES.CULTURE,
        summary: item.summary || item.content,
        sourceId: item.id,
        importance: Math.max(20, Number(entry.confidence || 0) * 0.75 + Number(item.spreadability || 0) * 0.2),
        clarity: Number(entry.confidence || 0),
        tags: ['information', ...(item.tags || []).slice(0, 6)],
        payload: { informationId: item.id, informationType: item.type },
        maxMemoriesPerOwner: options.maxMemoriesPerOwner,
        maxGlobalMemories: options.maxGlobalMemories,
      });
      created.push(memory);
      recordInfoFlowEvent(world, 'memory.created', { ownerType, ownerId, informationId: item.id, memoryId: memory.id });
      state.stats.memoriesCreated += 1;
    }
  }
  return created;
}

function applyInformationCultureInfluence(world, options = {}) {
  const state = ensureInfoFlowState(world);
  const information = ensureInformationState(world);
  const changed = [];
  for (const [key, entries] of Object.entries(information.knownBy || {})) {
    const { ownerType, ownerId } = parseOwnerKey(key);
    if (![CULTURE_SCOPE.ORGANIZATION, CULTURE_SCOPE.CITY].includes(ownerType)) continue;
    const traits = {};
    for (const entry of entries || []) {
      if (Number(entry.confidence || 0) < (options.cultureConfidenceThreshold ?? DEFAULT_INFO_FLOW_OPTIONS.cultureConfidenceThreshold)) continue;
      const item = information.items[entry.informationId];
      if (!item || item.status !== INFORMATION_STATUS.ACTIVE) continue;
      mergeTraitInfluence(traits, inferCultureTraitsFromInformation(item, entry));
    }
    if (!Object.keys(traits).length) continue;
    const existing = getCultureByOwner(world, ownerType, ownerId);
    const merged = { ...(existing?.traits || {}) };
    for (const [trait, amount] of Object.entries(traits)) merged[trait] = Math.max(Number(merged[trait] || 0), amount);
    const culture = upsertCulture(world, {
      ownerType,
      ownerId,
      scope: ownerType,
      traits: merged,
      values: ['information_flow'],
    });
    changed.push(culture);
    recordInfoFlowEvent(world, 'culture.influenced', { ownerType, ownerId, traits });
    state.stats.cultureInfluences += 1;
  }
  return changed;
}

function applyInformationReligionLinks(world, options = {}) {
  const state = ensureInfoFlowState(world);
  const information = ensureInformationState(world);
  const linked = [];
  const religions = Object.values(ensureReligionState(world).byId || {}).filter(religion => religion.status === RELIGION_STATUS.ACTIVE);
  for (const [key, entries] of Object.entries(information.knownBy || {})) {
    const { ownerType, ownerId } = parseOwnerKey(key);
    if (ownerType !== 'entity') continue;
    const entity = world.entities?.[ownerId];
    if (!entity || entity.status !== 'alive') continue;
    const faithEntries = (entries || []).filter(entry => {
      if (Number(entry.confidence || 0) < (options.religionConfidenceThreshold ?? DEFAULT_INFO_FLOW_OPTIONS.religionConfidenceThreshold)) return false;
      const item = information.items[entry.informationId];
      return item && item.status === INFORMATION_STATUS.ACTIVE && isReligionInformation(item);
    });
    if (!faithEntries.length) continue;
    for (const religion of religions) {
      if (religion.believers.includes(entity.id)) continue;
      if (!religionMatchesEntityLocation(world, religion, entity)) continue;
      addBeliever(world, religion.id, entity.id, { source: 'information_flow' });
      linked.push({ religionId: religion.id, entityId: entity.id });
      recordInfoFlowEvent(world, 'religion.linked', { religionId: religion.id, entityId: entity.id });
      state.stats.religionLinks += 1;
      break;
    }
  }
  return linked;
}

function inferCultureTraitsFromInformation(item, entry) {
  const traits = {};
  const tags = new Set([...(item.tags || []), item.type, item.summary, item.content].map(value => String(value || '').toLowerCase()));
  const confidence = Math.max(10, Number(entry.confidence || item.confidence || 0));
  const amount = Math.min(100, Math.max(15, confidence * 0.45));
  if (hasAny(tags, ['trade', 'market', 'economy', 'industry'])) traits[CULTURE_TRAITS.TRADE] = amount;
  if (hasAny(tags, ['knowledge', 'discovery', 'research', 'teaching'])) traits[CULTURE_TRAITS.KNOWLEDGE] = amount;
  if (hasAny(tags, ['faith', 'religion', 'ritual'])) traits[CULTURE_TRAITS.FAITH] = amount;
  if (hasAny(tags, ['organization', 'contract', 'law', 'governance'])) traits[CULTURE_TRAITS.ORDER] = amount;
  if (hasAny(tags, ['legacy', 'family', 'ancestor'])) traits[CULTURE_TRAITS.LEGACY] = amount;
  if (hasAny(tags, ['danger', 'disaster', 'shortage', 'death'])) traits[CULTURE_TRAITS.SURVIVAL] = amount;
  if (hasAny(tags, ['craft', 'building', 'infrastructure'])) traits[CULTURE_TRAITS.CRAFT] = amount;
  return traits;
}

function isReligionInformation(item) {
  const text = `${item.type || ''} ${(item.tags || []).join(' ')} ${item.summary || ''} ${item.content || ''}`.toLowerCase();
  return text.includes('faith') || text.includes('religion') || text.includes('ritual') || text.includes('ancestor');
}

function religionMatchesEntityLocation(world, religion, entity) {
  if (!religion.originLocationId) return true;
  if (religion.originLocationId === entity.locationId) return true;
  const entityCity = findCityByLocation(world, entity.locationId);
  if (!entityCity) return false;
  return religion.organizationIds.some(orgId => world.organizations?.byId?.[orgId]?.homeLocationId === entityCity.locationId);
}

function hasInformationMemory(world, ownerType, ownerId, informationId) {
  return getMemories(world, ownerType, ownerId).some(memory => memory.payload?.informationId === informationId);
}

function calculateShareScore(item, entry, link) {
  const confidence = Number(entry.confidence || 0) / 100;
  const spreadability = Number(item.spreadability || 0) / 100;
  const secrecy = 1 - Number(item.secrecy || 0) / 100;
  return confidence * spreadability * Math.max(0.05, secrecy) * Number(link.weight || 0);
}

function scoreKnownForFlow(entry) {
  const item = entry.item || {};
  return Number(entry.confidence || 0) + Number(item.spreadability || 0) - Number(item.secrecy || 0) * 0.5;
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

function getEntityOrganizationIds(world, entityId) {
  const entity = world.entities?.[entityId];
  const ids = new Set(entity?.organizationIds || []);
  for (const org of Object.values(world.organizations?.byId || {})) {
    if ((org.members || []).includes(entityId)) ids.add(org.id);
  }
  return Array.from(ids).filter(id => world.organizations?.byId?.[id]);
}

function findCityByLocation(world, locationId) {
  return Object.values(world.cities?.byId || {}).find(city => city.locationId === locationId) || null;
}

function recordInfoFlowEvent(world, type, payload = {}) {
  const state = ensureInfoFlowState(world);
  const event = {
    id: nextWorldId(world, 'info_flow', `info_flow.${type}`),
    tick: Number(world.tick || 0),
    type,
    payload: { ...payload },
  };
  state.events.push(event);
  return event;
}

function trimInfoFlowEvents(world, limit = DEFAULT_INFO_FLOW_OPTIONS.eventLimit) {
  const state = ensureInfoFlowState(world);
  if (state.events.length > limit) state.events = state.events.slice(-limit);
}

function mergeTraitInfluence(target, source) {
  for (const [trait, amount] of Object.entries(source || {})) target[trait] = Math.max(Number(target[trait] || 0), Number(amount || 0));
}

function hasAny(values, tokens) {
  for (const value of values) {
    for (const token of tokens) if (String(value || '').includes(token)) return true;
  }
  return false;
}

function linkKey(link) {
  return `${link.sourceType}:${link.sourceId}->${link.targetType}:${link.targetId}:${link.reason}`;
}

function parseOwnerKey(key) {
  const index = String(key || '').indexOf(':');
  if (index < 0) return { ownerType: String(key || ''), ownerId: '' };
  return { ownerType: key.slice(0, index), ownerId: key.slice(index + 1) };
}

module.exports = {
  INFO_FLOW_VERSION,
  DEFAULT_INFO_FLOW_OPTIONS,
  ensureInfoFlowState,
  processInfoFlowTick,
  buildInfoFlowLinks,
  shareInformationAcrossLinks,
  consolidateInformationMemories,
  applyInformationCultureInfluence,
  applyInformationReligionLinks,
};
