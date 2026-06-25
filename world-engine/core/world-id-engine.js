'use strict';

const WORLD_ID_STATE_VERSION = 1;
let transientSequence = 0;

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
  return world.engineIds;
}

function nextWorldSequence(world, key = 'default') {
  const state = ensureWorldIdState(world);
  const name = sanitizeKey(key);
  const next = Math.max(0, Number(state.counters[name] || 0)) + 1;
  state.counters[name] = next;
  return next;
}

function nextWorldId(world, prefix, key = prefix) {
  const safePrefix = sanitizeKey(prefix || 'id');
  const sequence = nextWorldSequence(world, key || safePrefix);
  const tick = Math.max(0, Number(world.tick || 0));
  return `${safePrefix}_${tick.toString(36)}_${sequence.toString(36)}`;
}

function nextTransientId(prefix = 'transient') {
  transientSequence += 1;
  return `${sanitizeKey(prefix)}_transient_${transientSequence.toString(36)}`;
}

function reserveWorldSequence(world, key, minimumValue) {
  const state = ensureWorldIdState(world);
  const name = sanitizeKey(key);
  const minimum = Math.max(0, Math.floor(Number(minimumValue || 0)));
  state.counters[name] = Math.max(Number(state.counters[name] || 0), minimum);
  return state.counters[name];
}

function getWorldIdSummary(world) {
  const state = ensureWorldIdState(world);
  return {
    version: state.version,
    counters: Object.fromEntries(
      Object.entries(state.counters)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, Number(value || 0)]),
    ),
  };
}

function sanitizeKey(value) {
  const normalized = String(value || 'id')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'id';
}

module.exports = {
  WORLD_ID_STATE_VERSION,
  ensureWorldIdState,
  nextWorldSequence,
  nextWorldId,
  nextTransientId,
  reserveWorldSequence,
  getWorldIdSummary,
};
