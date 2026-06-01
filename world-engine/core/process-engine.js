'use strict';

const PROCESS_STATUS = {
  ACTIVE: 'active',
  RESOLVED: 'resolved',
  STALLED: 'stalled',
};

const PROCESS_TYPES = {
  RISE: 'rise',
  DECLINE: 'decline',
  CONFLICT: 'conflict',
  LEGACY: 'legacy',
  MIGRATION: 'migration',
  ECONOMIC_CYCLE: 'economic_cycle',
  CULTURAL_SHIFT: 'cultural_shift',
  RELIGIOUS_SPREAD: 'religious_spread',
  CIVILIZATION_GROWTH: 'civilization_growth',
  OPPORTUNITY_CHAIN: 'opportunity_chain',
  LIFE_ARC: 'life_arc',
};

const DEFAULT_PROCESS_OPTIONS = {
  maxSteps: 200,
  maxSourceIds: 200,
  maxParticipants: 200,
  maxProcesses: 1000,
  maxInactiveProcesses: 300,
  staleAfterTicks: 720,
  resolveProgress: 100,
  memoryLimit: 1000,
};

function ensureProcessState(world) {
  if (!world.processes) {
    world.processes = {
      byId: {},
      indexes: { byType: {}, byStatus: {}, byParticipant: {}, byOwner: {} },
      consumedMemoryIds: [],
      stats: { created: 0, updated: 0, resolved: 0, stalled: 0, pruned: 0 },
    };
  }
  if (world.processes.stats.pruned === undefined) world.processes.stats.pruned = 0;
  return world.processes;
}

function createProcess(world, input = {}) {
  const state = ensureProcessState(world);
  const id = input.id || `process_${world.tick}_${Math.random().toString(16).slice(2)}`;
  const process = {
    id,
    type: input.type || PROCESS_TYPES.LIFE_ARC,
    status: input.status || PROCESS_STATUS.ACTIVE,
    title: input.title || input.type || 'process',
    ownerType: input.ownerType || null,
    ownerId: input.ownerId || null,
    startedAt: input.startedAt ?? world.tick,
    lastUpdatedAt: input.lastUpdatedAt ?? world.tick,
    resolvedAt: null,
    progress: clamp(input.progress ?? 0, 0, 100),
    strength: Number(input.strength || 1),
    participants: Array.isArray(input.participants) ? [...input.participants].slice(-DEFAULT_PROCESS_OPTIONS.maxParticipants) : [],
    sourceIds: Array.isArray(input.sourceIds) ? [...input.sourceIds].slice(-DEFAULT_PROCESS_OPTIONS.maxSourceIds) : [],
    steps: Array.isArray(input.steps) ? [...input.steps].slice(-DEFAULT_PROCESS_OPTIONS.maxSteps) : [],
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    payload: { ...(input.payload || {}) },
  };

  state.byId[id] = process;
  state.stats.created += 1;
  indexProcess(world, process);
  return process;
}

function processProcessesTick(world, options = {}) {
  const config = { ...DEFAULT_PROCESS_OPTIONS, ...(options || {}) };
  const created = [];
  const updated = [];
  const resolved = [];
  const stalled = [];

  const ingested = ingestWorldMemoryAsProcesses(world, config);
  created.push(...ingested.created);
  updated.push(...ingested.updated);

  for (const process of Object.values(ensureProcessState(world).byId)) {
    if (process.status !== PROCESS_STATUS.ACTIVE) continue;
    updateProcessProgress(world, process.id, config);
    if (process.progress >= config.resolveProgress) {
      process.status = PROCESS_STATUS.RESOLVED;
      process.resolvedAt = world.tick;
      ensureProcessState(world).stats.resolved += 1;
      resolved.push(process.id);
    } else if (world.tick - process.lastUpdatedAt > config.staleAfterTicks) {
      process.status = PROCESS_STATUS.STALLED;
      ensureProcessState(world).stats.stalled += 1;
      stalled.push(process.id);
    }
  }

  const pruned = pruneProcesses(world, config);
  rebuildProcessIndexes(world);
  return { created, updated, resolved, stalled, pruned, stats: getProcessStats(world) };
}

function ingestWorldMemoryAsProcesses(world, options = {}) {
  const state = ensureProcessState(world);
  const consumed = new Set(state.consumedMemoryIds || []);
  const created = [];
  const updated = [];

  for (const memory of world.memory || []) {
    if (consumed.has(memory.id)) continue;
    if (!memory.type || memory.type === 'world.tick') {
      consumed.add(memory.id);
      continue;
    }

    const descriptor = describeProcessFromMemory(world, memory);
    if (!descriptor) {
      consumed.add(memory.id);
      continue;
    }

    let process = findActiveProcess(world, descriptor.type, descriptor.ownerType, descriptor.ownerId, descriptor.key);
    if (!process) {
      process = createProcess(world, {
        type: descriptor.type,
        title: descriptor.title,
        ownerType: descriptor.ownerType,
        ownerId: descriptor.ownerId,
        participants: descriptor.participants,
        tags: descriptor.tags,
        payload: { key: descriptor.key },
      });
      created.push(process);
    }

    addProcessStep(world, process.id, {
      tick: memory.tick ?? world.tick,
      sourceId: memory.id,
      type: memory.type,
      importance: descriptor.importance,
      participants: descriptor.participants,
      payload: descriptor.payload,
    }, options);
    updated.push(process);
    consumed.add(memory.id);
  }

  state.consumedMemoryIds = Array.from(consumed).slice(-options.memoryLimit);
  return { created, updated };
}

function describeProcessFromMemory(world, memory) {
  const payload = memory.payload || {};
  const participants = collectParticipants(memory);
  const owner = inferOwner(memory, world);
  const type = inferProcessType(memory.type, payload);
  if (!type) return null;
  const key = inferProcessKey(type, owner, payload, participants);
  return {
    type,
    key,
    title: `${type}: ${owner.ownerId || participants[0] || 'world'}`,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    participants,
    tags: ['memory', memory.type, type],
    importance: inferImportance(memory.type, payload),
    payload,
  };
}

function inferProcessType(type, payload = {}) {
  if (type.includes('contract.broken') || type.includes('damaged')) return PROCESS_TYPES.CONFLICT;
  if (type.includes('goal.completed')) return PROCESS_TYPES.RISE;
  if (type.includes('death')) return PROCESS_TYPES.DECLINE;
  if (type.includes('relationship') || type.includes('interacted')) return PROCESS_TYPES.LIFE_ARC;
  if (type.includes('legacy')) return PROCESS_TYPES.LEGACY;
  if (type.includes('moved')) return PROCESS_TYPES.MIGRATION;
  if (type.includes('economy') || type.includes('industry') || type.includes('trade')) return PROCESS_TYPES.ECONOMIC_CYCLE;
  if (type.includes('culture')) return PROCESS_TYPES.CULTURAL_SHIFT;
  if (type.includes('religion')) return PROCESS_TYPES.RELIGIOUS_SPREAD;
  if (type.includes('civilization')) return PROCESS_TYPES.CIVILIZATION_GROWTH;
  if (type.includes('opportunity')) return PROCESS_TYPES.OPPORTUNITY_CHAIN;
  return PROCESS_TYPES.LIFE_ARC;
}

function inferOwner(memory, world) {
  const payload = memory.payload || {};
  if (payload.conflictId) return { ownerType: 'conflict', ownerId: payload.conflictId };
  if (payload.civilizationId) return { ownerType: 'civilization', ownerId: payload.civilizationId };
  if (payload.religionId) return { ownerType: 'religion', ownerId: payload.religionId };
  if (payload.organizationId) return { ownerType: 'organization', ownerId: payload.organizationId };
  if (payload.familyId) return { ownerType: 'family', ownerId: payload.familyId };
  if (payload.entityId) return { ownerType: 'entity', ownerId: payload.entityId };
  const participants = collectParticipants(memory);
  if (participants[0]) return { ownerType: 'entity', ownerId: participants[0] };
  return { ownerType: 'world', ownerId: 'world' };
}

function inferProcessKey(type, owner, payload = {}, participants = []) {
  if (payload.conflictId) return `conflict:${payload.conflictId}`;
  if (payload.contractId) return `contract:${payload.contractId}`;
  if (payload.opportunityId) return `opportunity:${payload.opportunityId}`;
  if (payload.cityId) return `city:${payload.cityId}:${type}`;
  if (owner.ownerId) return `${owner.ownerType}:${owner.ownerId}:${type}`;
  return `${type}:${participants.slice().sort().join(',') || 'world'}`;
}

function addProcessStep(world, processId, step, options = {}) {
  const process = getProcess(world, processId);
  if (!process) return null;
  process.steps.push(step);
  if (process.steps.length > (options.maxSteps || DEFAULT_PROCESS_OPTIONS.maxSteps)) process.steps.shift();
  process.lastUpdatedAt = world.tick;
  process.strength += Number(step.importance || 1) * 0.01;
  process.sourceIds = unique([...process.sourceIds, step.sourceId].filter(Boolean)).slice(-(options.maxSourceIds || DEFAULT_PROCESS_OPTIONS.maxSourceIds));
  process.participants = unique([...process.participants, ...(step.participants || [])].filter(Boolean)).slice(-(options.maxParticipants || DEFAULT_PROCESS_OPTIONS.maxParticipants));
  ensureProcessState(world).stats.updated += 1;
  return process;
}

function updateProcessProgress(world, processId) {
  const process = getProcess(world, processId);
  if (!process) return null;
  const stepScore = process.steps.length * 8;
  const strengthScore = process.strength * 5;
  const participantScore = process.participants.length * 2;
  process.progress = clamp(stepScore + strengthScore + participantScore, 0, 100);
  return process;
}

function pruneProcesses(world, options = {}) {
  const state = ensureProcessState(world);
  const all = Object.values(state.byId);
  const inactive = all.filter(p => p.status !== PROCESS_STATUS.ACTIVE).sort((a, b) => (b.resolvedAt || b.lastUpdatedAt) - (a.resolvedAt || a.lastUpdatedAt));
  const keepInactive = new Set(inactive.slice(0, options.maxInactiveProcesses || DEFAULT_PROCESS_OPTIONS.maxInactiveProcesses).map(p => p.id));
  const remove = [];

  for (const process of inactive) {
    if (!keepInactive.has(process.id)) remove.push(process.id);
  }

  const remainingCount = all.length - remove.length;
  if (remainingCount > (options.maxProcesses || DEFAULT_PROCESS_OPTIONS.maxProcesses)) {
    const candidates = all
      .filter(p => !remove.includes(p.id))
      .sort((a, b) => a.lastUpdatedAt - b.lastUpdatedAt);
    for (const process of candidates.slice(0, remainingCount - options.maxProcesses)) remove.push(process.id);
  }

  for (const id of remove) delete state.byId[id];
  state.stats.pruned += remove.length;
  return remove;
}

function findActiveProcess(world, type, ownerType, ownerId, key) {
  return Object.values(ensureProcessState(world).byId).find(process =>
    process.status === PROCESS_STATUS.ACTIVE
    && process.type === type
    && process.ownerType === ownerType
    && process.ownerId === ownerId
    && process.payload?.key === key
  ) || null;
}

function getProcess(world, processId) {
  return ensureProcessState(world).byId[processId] || null;
}

function getProcessChronicle(world, processId) {
  const process = getProcess(world, processId);
  if (!process) return null;
  return {
    processId,
    type: process.type,
    status: process.status,
    title: process.title,
    ownerType: process.ownerType,
    ownerId: process.ownerId,
    startedAt: process.startedAt,
    lastUpdatedAt: process.lastUpdatedAt,
    resolvedAt: process.resolvedAt,
    progress: process.progress,
    strength: process.strength,
    participants: [...process.participants],
    steps: [...process.steps],
    tags: [...process.tags],
  };
}

function getProcessStats(world) {
  const state = ensureProcessState(world);
  return {
    total: Object.keys(state.byId).length,
    active: Object.values(state.byId).filter(process => process.status === PROCESS_STATUS.ACTIVE).length,
    resolved: Object.values(state.byId).filter(process => process.status === PROCESS_STATUS.RESOLVED).length,
    stalled: Object.values(state.byId).filter(process => process.status === PROCESS_STATUS.STALLED).length,
    pruned: state.stats.pruned,
    byType: countIndex(state.indexes.byType),
    byStatus: countIndex(state.indexes.byStatus),
  };
}

function rebuildProcessIndexes(world) {
  const state = ensureProcessState(world);
  state.indexes = { byType: {}, byStatus: {}, byParticipant: {}, byOwner: {} };
  for (const process of Object.values(state.byId)) indexProcess(world, process);
}

function indexProcess(world, process) {
  const state = ensureProcessState(world);
  addIndex(state.indexes.byType, process.type, process.id);
  addIndex(state.indexes.byStatus, process.status, process.id);
  if (process.ownerId) addIndex(state.indexes.byOwner, `${process.ownerType}:${process.ownerId}`, process.id);
  for (const participant of process.participants || []) addIndex(state.indexes.byParticipant, participant, process.id);
}

function collectParticipants(memory) {
  const payload = memory.payload || {};
  const ids = new Set();
  for (const id of payload.actorIds || []) ids.add(id);
  for (const id of payload.participants || []) ids.add(id);
  for (const id of payload.parentIds || []) ids.add(id);
  if (payload.entityId) ids.add(payload.entityId);
  if (payload.childId) ids.add(payload.childId);
  if (payload.fromId) ids.add(payload.fromId);
  if (payload.toId) ids.add(payload.toId);
  if (payload.controllerId) ids.add(payload.controllerId);
  if (payload.subjectId) ids.add(payload.subjectId);
  return Array.from(ids).filter(Boolean);
}

function inferImportance(type, payload = {}) {
  if (type.includes('death')) return 100;
  if (type.includes('goal.completed')) return payload.scope === 'dream' ? 120 : 60;
  if (type.includes('civilization')) return 120;
  if (type.includes('religion')) return 80;
  if (type.includes('contract')) return 60;
  if (type.includes('city')) return 80;
  return 30;
}

function unique(items) {
  return Array.from(new Set(items));
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
  PROCESS_STATUS,
  PROCESS_TYPES,
  DEFAULT_PROCESS_OPTIONS,
  ensureProcessState,
  createProcess,
  processProcessesTick,
  ingestWorldMemoryAsProcesses,
  addProcessStep,
  pruneProcesses,
  getProcess,
  getProcessChronicle,
  getProcessStats,
  rebuildProcessIndexes,
};
