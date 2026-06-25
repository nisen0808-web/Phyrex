'use strict';

const { ensureEngineState, sanitizeNamespace } = require('./engine-state-engine');

const RNG_VERSION = 1;
const RNG_ALGORITHM = 'xoshiro128ss';
const UINT32_RANGE = 0x100000000;

function ensureRandomState(world, options = {}) {
  const engine = ensureEngineState(world);
  const seed = options.seed ?? world.seed ?? 1;
  const seedHash = hashSeed(seed);
  if (!engine.random || typeof engine.random !== 'object') {
    engine.random = {
      version: RNG_VERSION,
      algorithm: RNG_ALGORITHM,
      seed: serializeSeed(seed),
      seedHash,
      draws: 0,
      streams: {},
    };
  }

  const state = engine.random;
  state.version = Number(state.version || RNG_VERSION);
  state.algorithm = state.algorithm || RNG_ALGORITHM;
  state.seed = state.seed ?? serializeSeed(seed);
  state.seedHash = Number(state.seedHash ?? seedHash) >>> 0;
  state.draws = Math.max(0, Number(state.draws || 0));
  if (!state.streams || typeof state.streams !== 'object') state.streams = {};
  return state;
}

function getRandomStream(world, streamId = 'default') {
  const random = ensureRandomState(world);
  const key = sanitizeStreamId(streamId);
  if (!random.streams[key]) {
    random.streams[key] = createStreamState(random.seedHash, key);
  }
  const stream = random.streams[key];
  normalizeStreamState(stream, random.seedHash, key);
  return stream;
}

function randomUint32(world, streamId = 'default') {
  const random = ensureRandomState(world);
  const stream = getRandomStream(world, streamId);
  const value = nextXoshiro128ss(stream.state);
  stream.draws = Math.max(0, Number(stream.draws || 0)) + 1;
  random.draws = Math.max(0, Number(random.draws || 0)) + 1;
  return value;
}

function randomFloat(world, streamId = 'default') {
  return randomUint32(world, streamId) / UINT32_RANGE;
}

function randomBoolean(world, probability = 0.5, streamId = 'default') {
  const chance = clamp(Number(probability), 0, 1);
  if (chance <= 0) return false;
  if (chance >= 1) return true;
  return randomFloat(world, streamId) < chance;
}

function randomInt(world, min, max, streamId = 'default') {
  let lower = Math.ceil(Number(min));
  let upper = Math.floor(Number(max));
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) throw new Error('randomInt requires finite bounds');
  if (upper < lower) [lower, upper] = [upper, lower];
  const span = upper - lower + 1;
  if (span <= 1) return lower;
  if (span > UINT32_RANGE) {
    return lower + Math.floor(randomFloat(world, streamId) * span);
  }

  const limit = UINT32_RANGE - (UINT32_RANGE % span);
  let value;
  do value = randomUint32(world, streamId);
  while (value >= limit);
  return lower + (value % span);
}

function randomRange(world, min, max, streamId = 'default') {
  const lower = Number(min);
  const upper = Number(max);
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) throw new Error('randomRange requires finite bounds');
  return lower + (upper - lower) * randomFloat(world, streamId);
}

function randomChoice(world, values, streamId = 'default') {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values[randomInt(world, 0, values.length - 1, streamId)];
}

function randomWeightedChoice(world, entries, streamId = 'default') {
  if (!Array.isArray(entries) || !entries.length) return null;
  const normalized = entries
    .map(entry => Array.isArray(entry)
      ? { value: entry[0], weight: Number(entry[1] || 0) }
      : { value: entry?.value, weight: Number(entry?.weight || 0) })
    .filter(entry => Number.isFinite(entry.weight) && entry.weight > 0);
  const total = normalized.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return null;
  let cursor = randomFloat(world, streamId) * total;
  for (const entry of normalized) {
    cursor -= entry.weight;
    if (cursor < 0) return entry.value;
  }
  return normalized[normalized.length - 1].value;
}

function shuffleDeterministic(world, values, streamId = 'default') {
  const output = Array.isArray(values) ? [...values] : [];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(world, 0, index, streamId);
    [output[index], output[swapIndex]] = [output[swapIndex], output[index]];
  }
  return output;
}

function createRandomFunction(world, streamId = 'default') {
  return () => randomFloat(world, streamId);
}

function captureRandomState(world) {
  return JSON.parse(JSON.stringify(ensureRandomState(world)));
}

function restoreRandomState(world, snapshot) {
  if (!snapshot || snapshot.algorithm !== RNG_ALGORITHM) {
    throw new Error(`Unsupported RNG snapshot algorithm ${snapshot?.algorithm || 'missing'}`);
  }
  const engine = ensureEngineState(world);
  engine.random = JSON.parse(JSON.stringify(snapshot));
  ensureRandomState(world);
  return captureRandomState(world);
}

function resetRandomState(world, seed = world.seed ?? 1) {
  const engine = ensureEngineState(world);
  engine.random = null;
  world.seed = seed;
  return ensureRandomState(world, { seed });
}

function getRandomSummary(world) {
  const state = ensureRandomState(world);
  return {
    version: state.version,
    algorithm: state.algorithm,
    seed: state.seed,
    seedHash: state.seedHash,
    draws: state.draws,
    streams: Object.fromEntries(Object.entries(state.streams).map(([id, stream]) => [id, {
      draws: Number(stream.draws || 0),
      state: [...stream.state],
    }])),
  };
}

function createStreamState(seedHash, streamId) {
  const mixed = mix32((Number(seedHash) ^ hashSeed(streamId)) >>> 0);
  const state = expandSeed(mixed);
  return {
    id: streamId,
    seedHash: mixed,
    draws: 0,
    state,
  };
}

function normalizeStreamState(stream, seedHash, streamId) {
  stream.id = stream.id || streamId;
  stream.seedHash = Number(stream.seedHash ?? mix32((Number(seedHash) ^ hashSeed(streamId)) >>> 0)) >>> 0;
  stream.draws = Math.max(0, Number(stream.draws || 0));
  if (!Array.isArray(stream.state) || stream.state.length !== 4) stream.state = expandSeed(stream.seedHash);
  stream.state = stream.state.map(value => Number(value) >>> 0);
  if (stream.state.every(value => value === 0)) stream.state = expandSeed(stream.seedHash || 1);
  return stream;
}

function nextXoshiro128ss(state) {
  const result = Math.imul(rotl(Math.imul(state[1], 5) >>> 0, 7), 9) >>> 0;
  const t = (state[1] << 9) >>> 0;

  state[2] = (state[2] ^ state[0]) >>> 0;
  state[3] = (state[3] ^ state[1]) >>> 0;
  state[1] = (state[1] ^ state[2]) >>> 0;
  state[0] = (state[0] ^ state[3]) >>> 0;
  state[2] = (state[2] ^ t) >>> 0;
  state[3] = rotl(state[3], 11);
  return result;
}

function expandSeed(seed) {
  const state = [];
  let value = Number(seed) >>> 0;
  for (let index = 0; index < 4; index += 1) {
    value = (value + 0x9e3779b9) >>> 0;
    state.push(mix32(value));
  }
  if (state.every(item => item === 0)) state[0] = 1;
  return state;
}

function hashSeed(seed) {
  const text = serializeSeed(seed);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return mix32(hash);
}

function serializeSeed(seed) {
  if (typeof seed === 'string') return seed;
  if (typeof seed === 'number' || typeof seed === 'bigint' || typeof seed === 'boolean') return String(seed);
  if (seed === null || seed === undefined) return '1';
  return stableSerialize(seed);
}

function stableSerialize(value, seen = new Set()) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  if (type === 'boolean' || type === 'string') return JSON.stringify(value);
  if (type === 'undefined') return '"[undefined]"';
  if (type === 'bigint') return JSON.stringify(`${value}n`);
  if (type !== 'object') return JSON.stringify(String(value));
  if (seen.has(value)) throw new Error('Cannot serialize cyclic RNG seed');
  seen.add(value);
  let output;
  if (Array.isArray(value)) {
    output = `[${value.map(item => stableSerialize(item, seen)).join(',')}]`;
  } else {
    const keys = Object.keys(value).sort();
    output = `{${keys.map(key => `${JSON.stringify(key)}:${stableSerialize(value[key], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return output;
}

function mix32(value) {
  let result = Number(value) >>> 0;
  result = Math.imul(result ^ (result >>> 16), 0x21f0aaad) >>> 0;
  result = Math.imul(result ^ (result >>> 15), 0x735a2d97) >>> 0;
  return (result ^ (result >>> 15)) >>> 0;
}

function rotl(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function sanitizeStreamId(value) {
  return sanitizeNamespace(String(value || 'default').replace(/:/g, '.'));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

module.exports = {
  RNG_VERSION,
  RNG_ALGORITHM,
  ensureRandomState,
  getRandomStream,
  randomUint32,
  randomFloat,
  randomBoolean,
  randomInt,
  randomRange,
  randomChoice,
  randomWeightedChoice,
  shuffleDeterministic,
  createRandomFunction,
  captureRandomState,
  restoreRandomState,
  resetRandomState,
  getRandomSummary,
  hashSeed,
  serializeSeed,
};
