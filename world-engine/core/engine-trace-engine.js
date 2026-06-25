'use strict';

const { ensureEngineState, nextEngineId } = require('./engine-state-engine');

const ENGINE_TRACE_VERSION = 1;
const DEFAULT_TRACE_LIMIT = 2000;

function ensureTraceState(world, options = {}) {
  const engine = ensureEngineState(world);
  if (!engine.events || typeof engine.events !== 'object') {
    engine.events = {
      version: ENGINE_TRACE_VERSION,
      sequence: 0,
      maxEvents: Number(options.maxEvents || DEFAULT_TRACE_LIMIT),
      log: [],
      counters: { appended: 0, trimmed: 0, byType: {}, bySystem: {} },
    };
  }
  const state = engine.events;
  state.version = Number(state.version || ENGINE_TRACE_VERSION);
  state.sequence = Math.max(0, Number(state.sequence || 0));
  state.maxEvents = Math.max(1, Number(options.maxEvents || state.maxEvents || DEFAULT_TRACE_LIMIT));
  if (!Array.isArray(state.log)) state.log = [];
  if (!state.counters) state.counters = { appended: 0, trimmed: 0, byType: {}, bySystem: {} };
  if (!state.counters.byType) state.counters.byType = {};
  if (!state.counters.bySystem) state.counters.bySystem = {};
  return state;
}

function appendTrace(world, input = {}, options = {}) {
  if (!input.type) throw new Error('Engine trace requires type');
  const state = ensureTraceState(world, options);
  state.sequence += 1;
  const entry = {
    id: input.id || nextEngineId(world, 'trace'),
    version: ENGINE_TRACE_VERSION,
    sequence: state.sequence,
    tick: Number(input.tick ?? world.tick ?? 0),
    type: String(input.type),
    phase: input.phase || null,
    systemId: input.systemId || null,
    correlationId: input.correlationId || null,
    parentId: input.parentId || null,
    payload: cloneValue(input.payload || {}),
    tags: stringList(input.tags),
  };
  state.log.push(entry);
  state.counters.appended = Number(state.counters.appended || 0) + 1;
  increment(state.counters.byType, entry.type);
  if (entry.systemId) increment(state.counters.bySystem, entry.systemId);
  trimTrace(world, state.maxEvents);
  return entry;
}

function queryTrace(world, query = {}) {
  const state = ensureTraceState(world);
  const types = filterList(query.type || query.types);
  const systems = filterList(query.systemId || query.systemIds);
  const tags = filterList(query.tag || query.tags);
  const limit = Math.max(1, Number(query.limit || 100));
  return state.log.filter(entry => {
    if (query.fromSequence !== undefined && entry.sequence < Number(query.fromSequence)) return false;
    if (query.toSequence !== undefined && entry.sequence > Number(query.toSequence)) return false;
    if (query.fromTick !== undefined && entry.tick < Number(query.fromTick)) return false;
    if (query.toTick !== undefined && entry.tick > Number(query.toTick)) return false;
    if (types.length && !types.includes(entry.type)) return false;
    if (systems.length && !systems.includes(entry.systemId)) return false;
    if (query.correlationId && entry.correlationId !== query.correlationId) return false;
    if (tags.length && !tags.every(tag => entry.tags.includes(tag))) return false;
    return true;
  }).slice(-limit).map(cloneValue);
}

function getTraceChain(world, entryId, options = {}) {
  const state = ensureTraceState(world);
  const byId = new Map(state.log.map(entry => [entry.id, entry]));
  const output = [];
  const seen = new Set();
  const maxDepth = Math.max(1, Number(options.maxDepth || 100));
  let current = byId.get(entryId);
  while (current && output.length < maxDepth && !seen.has(current.id)) {
    output.push(cloneValue(current));
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  return output;
}

function trimTrace(world, maxEvents) {
  const state = ensureTraceState(world, { maxEvents });
  const excess = Math.max(0, state.log.length - Math.max(1, Number(maxEvents || state.maxEvents)));
  if (excess) {
    state.log.splice(0, excess);
    state.counters.trimmed = Number(state.counters.trimmed || 0) + excess;
  }
  return excess;
}

function getTraceSummary(world) {
  const state = ensureTraceState(world);
  return {
    version: state.version,
    sequence: state.sequence,
    retained: state.log.length,
    maxEvents: state.maxEvents,
    counters: cloneValue(state.counters),
    firstSequence: state.log[0]?.sequence || null,
    lastSequence: state.log[state.log.length - 1]?.sequence || null,
  };
}

function increment(target, key) {
  const normalized = String(key || 'unknown');
  target[normalized] = Number(target[normalized] || 0) + 1;
}

function filterList(value) {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : [value]).map(item => String(item)).filter(Boolean);
}

function stringList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(item => String(item)).filter(Boolean))];
}

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

module.exports = {
  ENGINE_TRACE_VERSION,
  DEFAULT_TRACE_LIMIT,
  ensureTraceState,
  appendTrace,
  queryTrace,
  getTraceChain,
  trimTrace,
  getTraceSummary,
};
