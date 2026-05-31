'use strict';

const INFORMATION_STATUS = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
  DISCREDITED: 'discredited',
};

const INFORMATION_TYPES = {
  FACT: 'fact',
  SECRET: 'secret',
  RUMOR: 'rumor',
  REPORT: 'report',
  DISCOVERY: 'discovery',
};

const DEFAULT_INFORMATION_OPTIONS = {
  spreadChance: 0.18,
  rumorMutationChance: 0.08,
  confidenceDecay: 0.002,
  maxKnownItemsPerOwner: 500,
};

function ensureInformationState(world) {
  if (!world.information) {
    world.information = {
      items: {},
      knownBy: {},
      indexes: {
        byType: {},
        byStatus: {},
        byLocation: {},
        byTag: {},
      },
      consumedMemoryIds: [],
      stats: {
        created: 0,
        spread: 0,
        rumors: 0,
      },
    };
  }
  return world.information;
}

function createInformation(world, input = {}) {
  if (!input.content && !input.summary) throw new Error('Information requires content or summary');
  const state = ensureInformationState(world);
  const id = input.id || `info_${world.tick}_${Math.random().toString(16).slice(2)}`;
  const item = {
    id,
    type: input.type || INFORMATION_TYPES.FACT,
    status: INFORMATION_STATUS.ACTIVE,
    createdAt: world.tick,
    updatedAt: world.tick,
    expiresAt: input.expiresAt ?? null,
    originEntityId: input.originEntityId || null,
    originOrganizationId: input.originOrganizationId || null,
    originLocationId: input.originLocationId || null,
    content: input.content || input.summary,
    summary: input.summary || input.content,
    truth: input.truth ?? true,
    confidence: clamp(input.confidence ?? 80, 0, 100),
    secrecy: clamp(input.secrecy ?? (input.type === INFORMATION_TYPES.SECRET ? 80 : 0), 0, 100),
    spreadability: clamp(input.spreadability ?? (input.type === INFORMATION_TYPES.SECRET ? 10 : 50), 0, 100),
    sourceInformationId: input.sourceInformationId || null,
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    payload: { ...(input.payload || {}) },
  };

  state.items[id] = item;
  state.stats.created += 1;
  indexInformation(world, item);

  for (const owner of input.knownBy || []) {
    revealInformation(world, id, owner.ownerType, owner.ownerId, owner);
  }

  return item;
}

function revealInformation(world, informationId, ownerType, ownerId, options = {}) {
  const state = ensureInformationState(world);
  const item = state.items[informationId];
  if (!item) throw new Error(`Missing information ${informationId}`);
  const key = ownerKey(ownerType, ownerId);
  if (!state.knownBy[key]) state.knownBy[key] = [];

  const existing = state.knownBy[key].find(entry => entry.informationId === informationId);
  if (existing) {
    existing.confidence = Math.max(existing.confidence, clamp(options.confidence ?? item.confidence, 0, 100));
    existing.lastUpdatedAt = world.tick;
    return existing;
  }

  const entry = {
    informationId,
    ownerType,
    ownerId,
    learnedAt: world.tick,
    lastUpdatedAt: world.tick,
    confidence: clamp(options.confidence ?? item.confidence, 0, 100),
    sourceOwnerType: options.sourceOwnerType || null,
    sourceOwnerId: options.sourceOwnerId || null,
    tags: Array.isArray(options.tags) ? [...options.tags] : [],
  };

  state.knownBy[key].push(entry);
  if (state.knownBy[key].length > (options.maxKnownItemsPerOwner || DEFAULT_INFORMATION_OPTIONS.maxKnownItemsPerOwner)) {
    state.knownBy[key].shift();
  }
  return entry;
}

function processInformationTick(world, options = {}) {
  const state = ensureInformationState(world);
  const config = { ...DEFAULT_INFORMATION_OPTIONS, ...(options || {}) };
  const createdFromMemory = ingestWorldMemoryAsInformation(world, config);
  const spread = spreadInformation(world, config);
  const expired = expireInformation(world, config);
  decayKnownInformation(world, config);
  return { createdFromMemory, spread, expired };
}

function ingestWorldMemoryAsInformation(world, options = {}) {
  const state = ensureInformationState(world);
  const consumed = new Set(state.consumedMemoryIds || []);
  const created = [];

  for (const memory of world.memory || []) {
    if (consumed.has(memory.id)) continue;
    if (!memory.type || memory.type === 'world.tick') {
      consumed.add(memory.id);
      continue;
    }

    const payload = memory.payload || {};
    const actorIds = payload.actorIds || (payload.entityId ? [payload.entityId] : []);
    const item = createInformation(world, {
      type: INFORMATION_TYPES.REPORT,
      summary: memory.type,
      content: `${memory.type} at tick ${memory.tick}`,
      confidence: 70,
      spreadability: inferSpreadability(memory.type),
      originEntityId: actorIds[0] || null,
      originLocationId: payload.locationId || null,
      tags: ['memory', memory.type],
      payload: { memoryId: memory.id, ...payload },
      knownBy: actorIds.map(id => ({ ownerType: 'entity', ownerId: id, confidence: 90 })),
    });
    created.push(item);
    consumed.add(memory.id);
  }

  state.consumedMemoryIds = Array.from(consumed);
  return created;
}

function spreadInformation(world, options = {}) {
  const state = ensureInformationState(world);
  const spread = [];
  const entityGroups = groupAliveEntitiesByLocation(world);

  for (const entityIds of Object.values(entityGroups)) {
    for (const sourceId of entityIds) {
      const known = getKnownInformation(world, 'entity', sourceId, { status: INFORMATION_STATUS.ACTIVE });
      if (!known.length) continue;
      for (const targetId of entityIds) {
        if (targetId === sourceId) continue;
        for (const entry of known.slice(0, 10)) {
          const item = state.items[entry.informationId];
          if (!item || Math.random() > spreadProbability(item, entry, options)) continue;
          const targetItem = maybeMutateRumor(world, item, options);
          revealInformation(world, targetItem.id, 'entity', targetId, {
            confidence: Math.max(5, entry.confidence - item.secrecy * 0.1 - 5),
            sourceOwnerType: 'entity',
            sourceOwnerId: sourceId,
          });
          state.stats.spread += 1;
          spread.push({ from: sourceId, to: targetId, informationId: targetItem.id });
        }
      }
    }
  }

  return spread;
}

function maybeMutateRumor(world, item, options = {}) {
  const state = ensureInformationState(world);
  if (item.type === INFORMATION_TYPES.SECRET) return item;
  if (Math.random() > (options.rumorMutationChance ?? DEFAULT_INFORMATION_OPTIONS.rumorMutationChance)) return item;

  const rumor = createInformation(world, {
    type: INFORMATION_TYPES.RUMOR,
    summary: `Rumor: ${item.summary}`,
    content: `Rumor based on: ${item.content}`,
    truth: item.truth,
    confidence: Math.max(10, item.confidence - 25),
    secrecy: Math.max(0, item.secrecy - 10),
    spreadability: Math.min(100, item.spreadability + 20),
    sourceInformationId: item.id,
    originEntityId: item.originEntityId,
    originLocationId: item.originLocationId,
    tags: [...(item.tags || []), 'rumor'],
    payload: { sourceInformationId: item.id },
  });
  state.stats.rumors += 1;
  return rumor;
}

function expireInformation(world) {
  const expired = [];
  for (const item of Object.values(ensureInformationState(world).items)) {
    if (item.status !== INFORMATION_STATUS.ACTIVE) continue;
    if (item.expiresAt !== null && world.tick >= item.expiresAt) {
      item.status = INFORMATION_STATUS.EXPIRED;
      item.updatedAt = world.tick;
      expired.push(item.id);
    }
  }
  rebuildInformationIndexes(world);
  return expired;
}

function decayKnownInformation(world, options = {}) {
  const decay = options.confidenceDecay ?? DEFAULT_INFORMATION_OPTIONS.confidenceDecay;
  for (const entries of Object.values(ensureInformationState(world).knownBy)) {
    for (const entry of entries) {
      entry.confidence = clamp(entry.confidence - decay, 0, 100);
    }
  }
}

function getKnownInformation(world, ownerType, ownerId, filters = {}) {
  const state = ensureInformationState(world);
  const entries = state.knownBy[ownerKey(ownerType, ownerId)] || [];
  return entries
    .map(entry => ({ ...entry, item: state.items[entry.informationId] }))
    .filter(entry => entry.item)
    .filter(entry => !filters.status || entry.item.status === filters.status)
    .filter(entry => !filters.type || entry.item.type === filters.type)
    .filter(entry => !filters.tag || entry.item.tags.includes(filters.tag));
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

function spreadProbability(item, entry, options = {}) {
  const base = options.spreadChance ?? DEFAULT_INFORMATION_OPTIONS.spreadChance;
  const confidenceFactor = clamp(entry.confidence, 0, 100) / 100;
  const spreadFactor = clamp(item.spreadability, 0, 100) / 100;
  const secrecyPenalty = 1 - clamp(item.secrecy, 0, 100) / 100;
  return base * confidenceFactor * spreadFactor * Math.max(0.05, secrecyPenalty);
}

function inferSpreadability(type) {
  if (type.includes('death')) return 80;
  if (type.includes('legacy')) return 55;
  if (type.includes('organization')) return 65;
  if (type.includes('contract')) return 45;
  if (type.includes('city')) return 70;
  return 35;
}

function rebuildInformationIndexes(world) {
  const state = ensureInformationState(world);
  state.indexes = { byType: {}, byStatus: {}, byLocation: {}, byTag: {} };
  for (const item of Object.values(state.items)) indexInformation(world, item);
}

function indexInformation(world, item) {
  const state = ensureInformationState(world);
  addIndex(state.indexes.byType, item.type, item.id);
  addIndex(state.indexes.byStatus, item.status, item.id);
  if (item.originLocationId) addIndex(state.indexes.byLocation, item.originLocationId, item.id);
  for (const tag of item.tags || []) addIndex(state.indexes.byTag, tag, item.id);
}

function ownerKey(ownerType, ownerId) {
  return `${ownerType}:${ownerId}`;
}

function addIndex(index, key, value) {
  if (!index[key]) index[key] = [];
  if (!index[key].includes(value)) index[key].push(value);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

module.exports = {
  INFORMATION_STATUS,
  INFORMATION_TYPES,
  DEFAULT_INFORMATION_OPTIONS,
  ensureInformationState,
  createInformation,
  revealInformation,
  processInformationTick,
  ingestWorldMemoryAsInformation,
  spreadInformation,
  getKnownInformation,
  rebuildInformationIndexes,
};
