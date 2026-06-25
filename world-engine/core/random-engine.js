'use strict';

const RANDOM_STATE_VERSION = 1;
const DEFAULT_RANDOM_STREAM = 'default';
const UINT32_RANGE = 0x100000000;
const NON_ZERO_FALLBACK = 0x6d2b79f5;

function ensureRandomState(world) {
  if (!world || typeof world !== 'object') throw new Error('ensureRandomState requires world');
  const seed = normalizeSeed(world.seed ?? 1);
  if (!world.random || typeof world.random !== 'object') {
    world.random = createRandomState(seed);
  }
  const state = world.random;
  if (state.version !== RANDOM_STATE_VERSION) {
    throw new Error(`Unsupported random state version ${state.version}`);
  }
  if (!Number.isInteger(state.baseSeed)) state.baseSeed = seed;
  state.baseSeed >>>= 0;
  if (!state.streams || typeof state.streams !== 'object') state.streams = {};
  if (!state.clock || typeof state.clock !== 'object') {
    state.clock = { epochMs: deterministicEpoch(state.baseSeed), sequence: 0 };
  }
  if (!Number.isFinite(state.clock.epochMs)) state.clock.epochMs = deterministicEpoch(state.baseSeed);
  if (!Number.isInteger(state.clock.sequence) || state.clock.sequence < 0) state.clock.sequence = 0;
  if (!Number.isInteger(state.draws) || state.draws < 0) state.draws = 0;
  return state;
}

function createRandomState(seed = 1) {
  const baseSeed = normalizeSeed(seed);
  return {
    version: RANDOM_STATE_VERSION,
    algorithm: 'xorshift32',
    baseSeed,
    draws: 0,
    streams: {},
    clock: {
      epochMs: deterministicEpoch(baseSeed),
      sequence: 0,
    },
  };
}

function normalizeSeed(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = Math.trunc(value) >>> 0;
    return normalized || NON_ZERO_FALLBACK;
  }
  const text = typeof value === 'string' ? value : stableSeedText(value);
  const normalized = hashString32(text || '1');
  return normalized || NON_ZERO_FALLBACK;
}

function nextRandomUint32(world, streamId = DEFAULT_RANDOM_STREAM) {
  const state = ensureRandomState(world);
  const stream = ensureRandomStream(state, streamId);
  let value = stream.state >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  value >>>= 0;
  if (value === 0) value = NON_ZERO_FALLBACK;
  stream.state = value;
  stream.draws += 1;
  state.draws += 1;
  return value;
}

function randomFloat(world, streamId = DEFAULT_RANDOM_STREAM) {
  return nextRandomUint32(world, streamId) / UINT32_RANGE;
}

function randomInt(world, min, max, streamId = DEFAULT_RANDOM_STREAM) {
  let lower = Math.ceil(Number(min));
  let upper = Math.floor(Number(max));
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) throw new Error('randomInt requires finite bounds');
  if (upper < lower) [lower, upper] = [upper, lower];
  const span = upper - lower + 1;
  if (span <= 0 || span > UINT32_RANGE) throw new Error('randomInt range is unsupported');
  return lower + Math.floor(randomFloat(world, streamId) * span);
}

function randomChance(world, probability, streamId = DEFAULT_RANDOM_STREAM) {
  const chance = Math.max(0, Math.min(1, Number(probability || 0)));
  if (chance <= 0) return false;
  if (chance >= 1) return true;
  return randomFloat(world, streamId) < chance;
}

function randomPick(world, values, streamId = DEFAULT_RANDOM_STREAM) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values[randomInt(world, 0, values.length - 1, streamId)];
}

function randomWeightedPick(world, entries, streamId = DEFAULT_RANDOM_STREAM) {
  const normalized = (entries || [])
    .map(entry => Array.isArray(entry)
      ? { value: entry[0], weight: Number(entry[1] || 0) }
      : { value: entry?.value, weight: Number(entry?.weight || 0) })
    .filter(entry => Number.isFinite(entry.weight) && entry.weight > 0);
  if (!normalized.length) return null;
  const total = normalized.reduce((sum, entry) => sum + entry.weight, 0);
  let cursor = randomFloat(world, streamId) * total;
  for (const entry of normalized) {
    cursor -= entry.weight;
    if (cursor < 0) return entry.value;
  }
  return normalized[normalized.length - 1].value;
}

function shuffleDeterministic(world, values, streamId = DEFAULT_RANDOM_STREAM) {
  const output = Array.isArray(values) ? [...values] : [];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(world, 0, index, streamId);
    [output[index], output[swapIndex]] = [output[swapIndex], output[index]];
  }
  return output;
}

function deterministicNow(world, namespace = 'clock') {
  const state = ensureRandomState(world);
  const tick = Math.max(0, Number(world.tick || 0));
  const sequence = state.clock.sequence++;
  const namespaceOffset = hashString32(String(namespace || 'clock')) % 1000;
  return Number(state.clock.epochMs) + tick * 100000 + namespaceOffset * 100 + sequence;
}

function withDeterministicGlobals(world, namespace, callback) {
  if (typeof callback !== 'function') throw new Error('withDeterministicGlobals requires callback');
  const streamId = `compat:${String(namespace || DEFAULT_RANDOM_STREAM)}`;
  const originalRandom = Math.random;
  const originalNow = Date.now;
  Math.random = () => randomFloat(world, streamId);
  Date.now = () => deterministicNow(world, streamId);
  try {
    const result = callback();
    if (result && typeof result.then === 'function') {
      throw new Error('Deterministic global scope only supports synchronous callbacks');
    }
    return result;
  } finally {
    Math.random = originalRandom;
    Date.now = originalNow;
  }
}

function createRandomContext(world, namespace = DEFAULT_RANDOM_STREAM) {
  const prefix = String(namespace || DEFAULT_RANDOM_STREAM);
  const stream = suffix => suffix ? `${prefix}:${suffix}` : prefix;
  return {
    uint32: suffix => nextRandomUint32(world, stream(suffix)),
    float: suffix => randomFloat(world, stream(suffix)),
    int: (min, max, suffix) => randomInt(world, min, max, stream(suffix)),
    chance: (probability, suffix) => randomChance(world, probability, stream(suffix)),
    pick: (values, suffix) => randomPick(world, values, stream(suffix)),
    weightedPick: (entries, suffix) => randomWeightedPick(world, entries, stream(suffix)),
    shuffle: (values, suffix) => shuffleDeterministic(world, values, stream(suffix)),
    now: suffix => deterministicNow(world, stream(suffix)),
  };
}

function snapshotRandomState(world) {
  return JSON.parse(JSON.stringify(ensureRandomState(world)));
}

function restoreRandomState(world, snapshot) {
  if (!snapshot || snapshot.version !== RANDOM_STATE_VERSION) {
    throw new Error('Invalid random state snapshot');
  }
  world.random = JSON.parse(JSON.stringify(snapshot));
  return ensureRandomState(world);
}

function getRandomSummary(world) {
  const state = ensureRandomState(world);
  return {
    version: state.version,
    algorithm: state.algorithm,
    baseSeed: state.baseSeed,
    draws: state.draws,
    streams: Object.entries(state.streams)
      .map(([id, stream]) => ({ id, draws: Number(stream.draws || 0), state: stream.state >>> 0 }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    clockSequence: state.clock.sequence,
  };
}

function ensureRandomStream(state, streamId) {
  const id = String(streamId || DEFAULT_RANDOM_STREAM);
  if (!state.streams[id]) {
    const initial = mix32((state.baseSeed ^ hashString32(id)) >>> 0) || NON_ZERO_FALLBACK;
    state.streams[id] = { state: initial >>> 0, draws: 0 };
  }
  const stream = state.streams[id];
  if (!Number.isInteger(stream.state)) stream.state = NON_ZERO_FALLBACK;
  stream.state >>>= 0;
  if (stream.state === 0) stream.state = NON_ZERO_FALLBACK;
  if (!Number.isInteger(stream.draws) || stream.draws < 0) stream.draws = 0;
  return stream;
}

function hashString32(value) {
  let hash = 0x811c9dc5;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mix32(value) {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function deterministicEpoch(seed) {
  return 1700000000000 + (seed % 1000000000);
}

function stableSeedText(value) {
  if (value === null || value === undefined) return '1';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableSeedText).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${key}:${stableSeedText(value[key])}`).join(',')}}`;
}

module.exports = {
  RANDOM_STATE_VERSION,
  DEFAULT_RANDOM_STREAM,
  createRandomState,
  ensureRandomState,
  normalizeSeed,
  nextRandomUint32,
  randomFloat,
  randomInt,
  randomChance,
  randomPick,
  randomWeightedPick,
  shuffleDeterministic,
  deterministicNow,
  withDeterministicGlobals,
  createRandomContext,
  snapshotRandomState,
  restoreRandomState,
  getRandomSummary,
  hashString32,
};
