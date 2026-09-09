'use strict';

const WORLD_ID_STATE_VERSION = 1;

function ensureWorldIdState(world) {
  if (!world || typeof world !== 'object') throw new Error('ensureWorldIdState requires world');
  if (!world.engineIds || typeof world.engineIds !== 'object') {
    world.engineIds = {
      version: WORLD_ID_STATE_VERSION,
      counters: {},
    };
  }
  if (world.engineIds.version !== WORLD_ID_STATE_VERSION) {
    throw new Error(`Unsupported world id state version ${world.engineIds.version}`);
  }
  if (!world.engineIds.counters || typeof world.engineIds.counters !== 'object') {
    world.engineIds.counters = {};
  }
  // Old saves only recorded per-namespace counters. Reserve their high-water
  // mark once so a new shared-prefix allocator cannot reuse an emitted ID.
  if (!world.engineIds.prefixCounters || typeof world.engineIds.prefixCounters !== 'object') {
    world.engineIds.prefixCounters = {};
    world.engineIds.legacySequenceFloor = Object.values(world.engineIds.counters)
      .reduce((maximum, value) => Math.max(maximum, checkedSequence(value)), 0);
  }
  return world.engineIds;
}

function nextWorldSequence(world, key = 'default') {
  const state = ensureWorldIdState(world);
  const name = sanitizeKey(key);
  const next = checkedSequence(Object.hasOwn(state.counters, name) ? state.counters[name] : 0) + 1;
  checkedSequence(next);
  state.counters[name] = next;
  return next;
}

function nextWorldId(world, prefix, key = prefix) {
  const safePrefix = sanitizeKey(prefix || 'id');
  const state = ensureWorldIdState(world);
  const name = sanitizeKey(key || safePrefix);
  const previous = Object.hasOwn(state.prefixCounters, safePrefix)
    ? checkedSequence(state.prefixCounters[safePrefix])
    : checkedSequence(state.legacySequenceFloor ?? 0);
  const namespacePrevious = checkedSequence(Object.hasOwn(state.counters, name) ? state.counters[name] : 0);
  const sequence = checkedSequence(Math.max(previous, namespacePrevious) + 1);
  const tick = checkedSequence(world.tick ?? 0);
  state.counters[name] = sequence;
  state.prefixCounters[safePrefix] = sequence;
  return `${safePrefix}_${tick.toString(36)}_${sequence.toString(36)}`;
}

function reserveWorldSequence(world, key, minimumValue) {
  const state = ensureWorldIdState(world);
  const name = sanitizeKey(key);
  const minimum = checkedSequence(minimumValue ?? 0);
  state.counters[name] = Math.max(checkedSequence(Object.hasOwn(state.counters, name) ? state.counters[name] : 0), minimum);
  return state.counters[name];
}

function getWorldIdSummary(world) {
  const state = ensureWorldIdState(world);
  return {
    version: state.version,
    legacySequenceFloor: state.legacySequenceFloor ?? 0,
    prefixCounters: Object.fromEntries(Object.entries(state.prefixCounters).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    counters: Object.fromEntries(
      Object.entries(state.counters)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, Number(value || 0)]),
    ),
  };
}

function checkedSequence(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('World ID counters and ticks must be non-negative safe integers');
  return number;
}

function sanitizeKey(value) {
  const normalized = String(value || 'id')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'id';
}

module.exports = {
  WORLD_ID_STATE_VERSION,
  ensureWorldIdState,
  nextWorldSequence,
  nextWorldId,
  reserveWorldSequence,
  getWorldIdSummary,
};
