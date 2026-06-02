'use strict';

const MEMORY_SCOPE = {
  ENTITY: 'entity',
  FAMILY: 'family',
  ORGANIZATION: 'organization',
  CITY: 'city',
  WORLD: 'world',
};

const MEMORY_TYPES = {
  PERSONAL: 'personal',
  RELATIONSHIP: 'relationship',
  TRAUMA: 'trauma',
  ACHIEVEMENT: 'achievement',
  OBLIGATION: 'obligation',
  LEGACY: 'legacy',
  CULTURE: 'culture',
  RUMOR: 'rumor',
};

const DEFAULT_MEMORY_OPTIONS = {
  importanceDecay: 0.5,
  clarityDecay: 0.25,
  traumaRetentionMultiplier: 0.35,
  maxMemoriesPerOwner: 50,
  maxGlobalMemories: 3000,
  maxConsumedWorldMemoryIds: 3000,
};

function ensureMemoryState(world) {
  if (!world.memories) {
    world.memories = {
      byId: {},
      byOwner: {},
      indexes: { byType: {}, byScope: {}, byTag: {} },
      consumedWorldMemoryIds: [],
      _consumedSet: new Set(),
      _indexDirty: true,
      _lastIndexedCount: 0,
      stats: { created: 0, reinforced: 0, faded: 0, pruned: 0 },
    };
  }
  if (!world.memories._consumedSet) world.memories._consumedSet = new Set(world.memories.consumedWorldMemoryIds || []);
  if (world.memories._indexDirty === undefined) world.memories._indexDirty = true;
  if (world.memories._lastIndexedCount === undefined) world.memories._lastIndexedCount = 0;
  if (world.memories.stats.pruned === undefined) world.memories.stats.pruned = 0;
  return world.memories;
}

function createMemory(world, input = {}) {
  if (!input.ownerType || !input.ownerId) throw new Error('Memory requires ownerType and ownerId');
  if (!input.summary) throw new Error('Memory requires summary');
  const state = ensureMemoryState(world);
  const id = input.id || `mem_${world.tick}_${Math.random().toString(16).slice(2)}`;
  const memory = {
    id,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    scope: input.scope || input.ownerType,
    type: input.type || MEMORY_TYPES.PERSONAL,
    createdAt: world.tick,
    lastReinforcedAt: world.tick,
    sourceId: input.sourceId || null,
    summary: input.summary,
    importance: clamp(input.importance ?? 30, 0, 1000),
    clarity: clamp(input.clarity ?? 100, 0, 100),
    emotionalWeight: clamp(input.emotionalWeight ?? 0, -100, 100),
    participants: Array.isArray(input.participants) ? [...input.participants] : [],
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    payload: { ...(input.payload || {}) },
  };

  state.byId[id] = memory;
  addOwnerMemory(world, memory.ownerType, memory.ownerId, id, input.maxMemoriesPerOwner);
  indexMemory(world, memory);
  state._indexDirty = true;
  state.stats.created += 1;
  trimGlobalMemories(world, input.maxGlobalMemories || DEFAULT_MEMORY_OPTIONS.maxGlobalMemories, input.maxMemoriesPerOwner || DEFAULT_MEMORY_OPTIONS.maxMemoriesPerOwner);
  return memory;
}

function addOwnerMemory(world, ownerType, ownerId, memoryId, maxMemoriesPerOwner) {
  const state = ensureMemoryState(world);
  const key = ownerKey(ownerType, ownerId);
  if (!state.byOwner[key]) state.byOwner[key] = [];
  state.byOwner[key].push(memoryId);
  const limit = maxMemoriesPerOwner || DEFAULT_MEMORY_OPTIONS.maxMemoriesPerOwner;
  if (state.byOwner[key].length > limit) {
    state.byOwner[key] = state.byOwner[key]
      .map(id => state.byId[id])
      .filter(Boolean)
      .sort((a, b) => scoreMemoryForRetention(b) - scoreMemoryForRetention(a))
      .slice(0, limit)
      .map(memory => memory.id);
    const kept = new Set(state.byOwner[key]);
    for (const [id, memory] of Object.entries(state.byId)) {
      if (ownerKey(memory.ownerType, memory.ownerId) === key && !kept.has(id)) delete state.byId[id];
    }
    state._indexDirty = true;
  }
}

function processMemoryTick(world, options = {}) {
  ensureMemoryState(world);
  const config = { ...DEFAULT_MEMORY_OPTIONS, ...(options || {}) };
  const created = ingestWorldMemory(world, config);
  const reinforced = reinforceImportantMemories(world, config);
  const faded = decayMemories(world, config);
  const pruned = trimGlobalMemories(world, config.maxGlobalMemories, config.maxMemoriesPerOwner);
  trimConsumedWorldMemoryIds(world, config.maxConsumedWorldMemoryIds);
  rebuildMemoryIndexes(world, Boolean(faded.length || pruned.length));
  return { created, reinforced, faded, pruned };
}

function ingestWorldMemory(world, options = {}) {
  const state = ensureMemoryState(world);
  const consumed = state._consumedSet || new Set(state.consumedWorldMemoryIds || []);
  state._consumedSet = consumed;
  const created = [];

  for (const item of world.memory || []) {
    if (consumed.has(item.id)) continue;
    if (!item.type || item.type === 'world.tick') {
      consumed.add(item.id);
      continue;
    }

    const payload = item.payload || {};
    const entityIds = collectEntityIdsFromMemory(item);
    const familyIds = collectFamilyIdsFromMemory(item, world);
    const organizationIds = collectOrganizationIdsFromMemory(item, world);

    for (const entityId of entityIds) {
      if (!world.entities[entityId]) continue;
      created.push(createMemory(world, {
        ownerType: MEMORY_SCOPE.ENTITY,
        ownerId: entityId,
        type: inferMemoryType(item.type),
        summary: item.type,
        sourceId: item.id,
        importance: inferMemoryImportance(item.type, payload),
        emotionalWeight: inferEmotionalWeight(item.type),
        participants: entityIds,
        tags: ['world_memory', item.type],
        payload,
        maxMemoriesPerOwner: options.maxMemoriesPerOwner,
        maxGlobalMemories: options.maxGlobalMemories,
      }));
    }

    for (const familyId of familyIds) {
      created.push(createMemory(world, {
        ownerType: MEMORY_SCOPE.FAMILY,
        ownerId: familyId,
        type: inferMemoryType(item.type),
        summary: item.type,
        sourceId: item.id,
        importance: inferMemoryImportance(item.type, payload) * 0.8,
        emotionalWeight: inferEmotionalWeight(item.type),
        participants: entityIds,
        tags: ['family_memory', item.type],
        payload,
        maxMemoriesPerOwner: options.maxMemoriesPerOwner,
        maxGlobalMemories: options.maxGlobalMemories,
      }));
    }

    for (const organizationId of organizationIds) {
      created.push(createMemory(world, {
        ownerType: MEMORY_SCOPE.ORGANIZATION,
        ownerId: organizationId,
        type: inferMemoryType(item.type),
        summary: item.type,
        sourceId: item.id,
        importance: inferMemoryImportance(item.type, payload) * 0.7,
        emotionalWeight: inferEmotionalWeight(item.type),
        participants: entityIds,
        tags: ['organization_memory', item.type],
        payload,
        maxMemoriesPerOwner: options.maxMemoriesPerOwner,
        maxGlobalMemories: options.maxGlobalMemories,
      }));
    }

    consumed.add(item.id);
  }

  trimConsumedWorldMemoryIds(world, options.maxConsumedWorldMemoryIds || DEFAULT_MEMORY_OPTIONS.maxConsumedWorldMemoryIds);
  return created;
}

function collectEntityIdsFromMemory(memory) {
  const payload = memory.payload || {};
  const ids = new Set();
  for (const id of payload.actorIds || []) ids.add(id);
  if (payload.entityId) ids.add(payload.entityId);
  if (payload.fromId) ids.add(payload.fromId);
  if (payload.toId) ids.add(payload.toId);
  if (payload.childId) ids.add(payload.childId);
  for (const id of payload.parentIds || []) ids.add(id);
  return Array.from(ids).filter(Boolean);
}

function collectFamilyIdsFromMemory(memory, world) {
  const ids = new Set();
  const payload = memory.payload || {};
  if (payload.familyId) ids.add(payload.familyId);
  for (const entityId of collectEntityIdsFromMemory(memory)) {
    const entity = world.entities[entityId];
    const familyId = entity?.familyId || entity?.demographics?.familyId;
    if (familyId) ids.add(familyId);
  }
  return Array.from(ids).filter(Boolean);
}

function collectOrganizationIdsFromMemory(memory, world) {
  const ids = new Set();
  const payload = memory.payload || {};
  if (payload.organizationId) ids.add(payload.organizationId);
  for (const entityId of collectEntityIdsFromMemory(memory)) {
    const entity = world.entities[entityId];
    for (const orgId of entity?.organizationIds || []) ids.add(orgId);
  }
  return Array.from(ids).filter(Boolean);
}

function reinforceImportantMemories(world, options = {}) {
  const reinforced = [];
  for (const memory of Object.values(ensureMemoryState(world).byId)) {
    if (memory.importance >= 150 || Math.abs(memory.emotionalWeight) >= 75) {
      memory.clarity = clamp(memory.clarity + 0.2, 0, 100);
      memory.lastReinforcedAt = world.tick;
      reinforced.push(memory.id);
    }
  }
  ensureMemoryState(world).stats.reinforced += reinforced.length;
  return reinforced;
}

function decayMemories(world, options = {}) {
  const state = ensureMemoryState(world);
  const faded = [];
  for (const memory of Object.values(state.byId)) {
    const traumaMultiplier = memory.type === MEMORY_TYPES.TRAUMA ? options.traumaRetentionMultiplier : 1;
    memory.importance = clamp(memory.importance - options.importanceDecay * traumaMultiplier, 0, 1000);
    memory.clarity = clamp(memory.clarity - options.clarityDecay * traumaMultiplier, 0, 100);
    if (memory.clarity <= 1 || memory.importance <= 1) faded.push(memory.id);
  }
  for (const id of faded) deleteMemory(world, id);
  state.stats.faded += faded.length;
  if (faded.length) state._indexDirty = true;
  return faded;
}

function reinforceMemory(world, memoryId, amount = 10) {
  const memory = ensureMemoryState(world).byId[memoryId];
  if (!memory) return null;
  memory.importance = clamp(memory.importance + amount, 0, 1000);
  memory.clarity = clamp(memory.clarity + amount * 0.5, 0, 100);
  memory.lastReinforcedAt = world.tick;
  ensureMemoryState(world).stats.reinforced += 1;
  ensureMemoryState(world)._indexDirty = true;
  return memory;
}

function deleteMemory(world, memoryId) {
  const state = ensureMemoryState(world);
  const memory = state.byId[memoryId];
  if (!memory) return false;
  const key = ownerKey(memory.ownerType, memory.ownerId);
  state.byOwner[key] = (state.byOwner[key] || []).filter(id => id !== memoryId);
  delete state.byId[memoryId];
  state._indexDirty = true;
  return true;
}

function trimGlobalMemories(world, maxGlobal = DEFAULT_MEMORY_OPTIONS.maxGlobalMemories, maxPerOwner = DEFAULT_MEMORY_OPTIONS.maxMemoriesPerOwner) {
  const state = ensureMemoryState(world);
  const pruned = [];

  for (const key of Object.keys(state.byOwner)) {
    const memories = (state.byOwner[key] || []).map(id => state.byId[id]).filter(Boolean);
    const kept = memories.sort((a, b) => scoreMemoryForRetention(b) - scoreMemoryForRetention(a)).slice(0, maxPerOwner);
    const keptIds = new Set(kept.map(memory => memory.id));
    for (const memory of memories) {
      if (!keptIds.has(memory.id)) {
        delete state.byId[memory.id];
        pruned.push(memory.id);
      }
    }
    state.byOwner[key] = kept.map(memory => memory.id);
  }

  const all = Object.values(state.byId);
  if (all.length > maxGlobal) {
    const keep = new Set(all.sort((a, b) => scoreMemoryForRetention(b) - scoreMemoryForRetention(a)).slice(0, maxGlobal).map(memory => memory.id));
    for (const memory of all) {
      if (!keep.has(memory.id)) {
        delete state.byId[memory.id];
        pruned.push(memory.id);
      }
    }
    for (const key of Object.keys(state.byOwner)) {
      state.byOwner[key] = (state.byOwner[key] || []).filter(id => keep.has(id));
    }
  }

  if (pruned.length) {
    state.stats.pruned += pruned.length;
    state._indexDirty = true;
  }
  return pruned;
}

function trimConsumedWorldMemoryIds(world, limit = DEFAULT_MEMORY_OPTIONS.maxConsumedWorldMemoryIds) {
  const state = ensureMemoryState(world);
  if (!state._consumedSet) state._consumedSet = new Set(state.consumedWorldMemoryIds || []);
  if (state._consumedSet.size > limit) {
    const kept = Array.from(state._consumedSet).slice(-limit);
    state._consumedSet = new Set(kept);
  }
  state.consumedWorldMemoryIds = Array.from(state._consumedSet).slice(-limit);
}

function scoreMemoryForRetention(memory) {
  return Number(memory.importance || 0) * 2
    + Number(memory.clarity || 0)
    + Math.abs(Number(memory.emotionalWeight || 0))
    + Number(memory.lastReinforcedAt || memory.createdAt || 0) * 0.01;
}

function getMemories(world, ownerType, ownerId, filters = {}) {
  const state = ensureMemoryState(world);
  const key = ownerKey(ownerType, ownerId);
  const ids = state.byOwner[key] || [];
  const memories = ids
    .map(id => state.byId[id])
    .filter(Boolean)
    .filter(memory => !filters.type || memory.type === filters.type)
    .filter(memory => !filters.tag || memory.tags.includes(filters.tag))
    .filter(memory => filters.minImportance === undefined || memory.importance >= filters.minImportance)
    .sort((a, b) => b.importance - a.importance);
  if (memories.length !== ids.length) state.byOwner[key] = memories.map(memory => memory.id);
  return memories;
}

function inferMemoryType(type) {
  if (type.includes('death') || type.includes('damaged')) return MEMORY_TYPES.TRAUMA;
  if (type.includes('goal.completed')) return MEMORY_TYPES.ACHIEVEMENT;
  if (type.includes('relationship') || type.includes('interacted')) return MEMORY_TYPES.RELATIONSHIP;
  if (type.includes('legacy')) return MEMORY_TYPES.LEGACY;
  if (type.includes('contract')) return MEMORY_TYPES.OBLIGATION;
  if (type.includes('rumor')) return MEMORY_TYPES.RUMOR;
  return MEMORY_TYPES.PERSONAL;
}

function inferMemoryImportance(type, payload = {}) {
  if (type.includes('death')) return 200;
  if (type.includes('goal.completed')) return payload.scope === 'dream' ? 180 : 90;
  if (type.includes('legacy')) return 120;
  if (type.includes('contract')) return 70;
  if (type.includes('organization')) return 60;
  if (type.includes('city')) return 90;
  return 25;
}

function inferEmotionalWeight(type) {
  if (type.includes('death')) return -90;
  if (type.includes('damaged')) return -70;
  if (type.includes('goal.completed')) return 60;
  if (type.includes('relationship')) return 30;
  if (type.includes('legacy')) return 40;
  return 0;
}

function rebuildMemoryIndexes(world, force = false) {
  const state = ensureMemoryState(world);
  const count = Object.keys(state.byId).length;
  if (!force && !state._indexDirty && state._lastIndexedCount === count) return;
  state.indexes = { byType: {}, byScope: {}, byTag: {} };
  for (const memory of Object.values(state.byId)) indexMemory(world, memory);
  state._indexDirty = false;
  state._lastIndexedCount = count;
}

function indexMemory(world, memory) {
  const state = ensureMemoryState(world);
  addIndex(state.indexes.byType, memory.type, memory.id);
  addIndex(state.indexes.byScope, memory.scope, memory.id);
  for (const tag of memory.tags || []) addIndex(state.indexes.byTag, tag, memory.id);
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
  MEMORY_SCOPE,
  MEMORY_TYPES,
  DEFAULT_MEMORY_OPTIONS,
  ensureMemoryState,
  createMemory,
  processMemoryTick,
  ingestWorldMemory,
  reinforceMemory,
  getMemories,
  trimGlobalMemories,
  rebuildMemoryIndexes,
};
