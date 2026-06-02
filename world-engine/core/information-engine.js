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
  maxKnownItemsPerOwner: 120,
  maxInformationItems: 1000,
  maxConsumedMemoryIds: 3000,
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
      _consumedSet: new Set(),
      _indexDirty: true,
      _lastIndexedItemCount: 0,
      stats: {
        created: 0,
        spread: 0,
        rumors: 0,
        pruned: 0,
      },
    };
  }
  if (!world.information._consumedSet) world.information._consumedSet = new Set(world.information.consumedMemoryIds || []);
  if (world.information._indexDirty === undefined) world.information._indexDirty = true;
  if (world.information._lastIndexedItemCount === undefined) world.information._lastIndexedItemCount = 0;
  if (world.information.stats.pruned === undefined) world.information.stats.pruned = 0;
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
  state._indexDirty = true;
  indexInformation(world, item);

  for (const owner of input.knownBy || []) {
    revealInformation(world, id, owner.ownerType, owner.ownerId, owner);
  }

  trimInformationItems(world, input.maxInformationItems || DEFAULT_INFORMATION_OPTIONS.maxInformationItems);
  return item;
}

function revealInformation(world, informationId, ownerType, ownerId, options = {}) {
  const state = ensureInformationState(world);
  const item = state.items[informationId];
  if (!item) return null;
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
  const limit = options.maxKnownItemsPerOwner || DEFAULT_INFORMATION_OPTIONS.maxKnownItemsPerOwner;
  if (state.knownBy[key].length > limit) {
    state.knownBy[key] = state.knownBy[key]
      .sort((a, b) => scoreKnownInformation(state, b) - scoreKnownInformation(state, a))
      .slice(0, limit);
  }
  return entry;
}

function processInformationTick(world, options = {}) {
  ensureInformationState(world);
  const config = { ...DEFAULT_INFORMATION_OPTIONS, ...(options || {}) };
  const createdFromMemory = ingestWorldMemoryAsInformation(world, config);
  const spread = spreadInformation(world, config);
  const expired = expireInformation(world, config);
  decayKnownInformation(world, config);
  const pruned = trimInformationItems(world, config.maxInformationItems);
  trimConsumedMemoryIds(world, config.maxConsumedMemoryIds);
  rebuildInformationIndexes(world, expired.length > 0 || pruned.length > 0);
  return { createdFromMemory, spread, expired, pruned };
}

function ingestWorldMemoryAsInformation(world, options = {}) {
  const state = ensureInformationState(world);
  const consumed = state._consumedSet || new Set(state.consumedMemoryIds || []);
  state._consumedSet = consumed;
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
      maxInformationItems: options.maxInformationItems,
    });
    created.push(item);
    consumed.add(memory.id);
  }

  trimConsumedMemoryIds(world, options.maxConsumedMemoryIds || DEFAULT_INFORMATION_OPTIONS.maxConsumedMemoryIds);
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
        for (const entry of known.slice(0, 6)) {
          const item = state.items[entry.informationId];
          if (!item || Math.random() > spreadProbability(item, entry, options)) continue;
          const targetItem = maybeMutateRumor(world, item, options);
          revealInformation(world, targetItem.id, 'entity', targetId, {
            confidence: Math.max(5, entry.confidence - item.secrecy * 0.1 - 5),
            sourceOwnerType: 'entity',
            sourceOwnerId: sourceId,
            maxKnownItemsPerOwner: options.maxKnownItemsPerOwner,
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
    maxInformationItems: options.maxInformationItems,
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
  if (expired.length) ensureInformationState(world)._indexDirty = true;
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
  const key = ownerKey(ownerType, ownerId);
  const entries = state.knownBy[key] || [];
  const filtered = entries
    .map(entry => ({ ...entry, item: state.items[entry.informationId] }))
    .filter(entry => entry.item)
    .filter(entry => !filters.status || entry.item.status === filters.status)
    .filter(entry => !filters.type || entry.item.type === filters.type)
    .filter(entry => !filters.tag || entry.item.tags.includes(filters.tag));

  if (filtered.length !== entries.length) {
    state.knownBy[key] = filtered.map(({ item, ...entry }) => entry);
  }
  return filtered;
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

function trimInformationItems(world, limit = DEFAULT_INFORMATION_OPTIONS.maxInformationItems) {
  const state = ensureInformationState(world);
  const items = Object.values(state.items);
  if (items.length <= limit) return [];

  const remove = items
    .sort((a, b) => scoreInformationForRetention(a) - scoreInformationForRetention(b))
    .slice(0, items.length - limit)
    .map(item => item.id);

  for (const id of remove) delete state.items[id];
  const removed = new Set(remove);
  for (const key of Object.keys(state.knownBy)) {
    state.knownBy[key] = (state.knownBy[key] || []).filter(entry => !removed.has(entry.informationId));
  }
  state.stats.pruned += remove.length;
  state._indexDirty = true;
  return remove;
}

function trimConsumedMemoryIds(world, limit = DEFAULT_INFORMATION_OPTIONS.maxConsumedMemoryIds) {
  const state = ensureInformationState(world);
  if (!state._consumedSet) state._consumedSet = new Set(state.consumedMemoryIds || []);
  if (state._consumedSet.size > limit) {
    const kept = Array.from(state._consumedSet).slice(-limit);
    state._consumedSet = new Set(kept);
  }
  state.consumedMemoryIds = Array.from(state._consumedSet).slice(-limit);
}

function scoreInformationForRetention(item) {
  const statusScore = item.status === INFORMATION_STATUS.ACTIVE ? 1000 : item.status === INFORMATION_STATUS.EXPIRED ? 100 : 0;
  const typeScore = item.type === INFORMATION_TYPES.SECRET ? 500 : item.type === INFORMATION_TYPES.FACT ? 300 : item.type === INFORMATION_TYPES.DISCOVERY ? 200 : 0;
  return statusScore + typeScore + Number(item.confidence || 0) + Number(item.spreadability || 0) + Number(item.createdAt || 0) * 0.01;
}

function scoreKnownInformation(state, entry) {
  const item = state.items[entry.informationId];
  if (!item) return -Infinity;
  return Number(entry.confidence || 0) + Number(entry.lastUpdatedAt || entry.learnedAt || 0) * 0.01 + (item.status === INFORMATION_STATUS.ACTIVE ? 10 : 0);
}

function rebuildInformationIndexes(world, force = false) {
  const state = ensureInformationState(world);
  const count = Object.keys(state.items).length;
  if (!force && !state._indexDirty && state._lastIndexedItemCount === count) return;
  state.indexes = { byType: {}, byStatus: {}, byLocation: {}, byTag: {} };
  for (const item of Object.values(state.items)) indexInformation(world, item);
  state._indexDirty = false;
  state._lastIndexedItemCount = count;
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
  trimInformationItems,
  rebuildInformationIndexes,
};
