'use strict';

const crypto = require('crypto');

const STATE_HASH_VERSION = 1;
const DEFAULT_SIMULATION_EXCLUDES = [
  'accounts',
  'apiAudit',
  'runtime',
  'runtimeLoop',
  'engine.replay',
  'engine.scheduler.lastDurationMs',
  'engine.scheduler.lastRunAt',
];

function canonicalStringify(value, options = {}) {
  const excludes = normalizePaths(options.excludePaths || []);
  const normalized = canonicalize(value, {
    excludes,
    path: [],
    seen: new Map(),
    nonFiniteNumbers: options.nonFiniteNumbers || 'string',
  });
  return JSON.stringify(normalized);
}

function hashCanonicalState(value, options = {}) {
  const algorithm = options.algorithm || 'sha256';
  return crypto.createHash(algorithm).update(canonicalStringify(value, options), 'utf8').digest(options.encoding || 'hex');
}

function hashWorldState(world, options = {}) {
  if (!world || typeof world !== 'object') throw new Error('hashWorldState requires world');
  return hashCanonicalState(world, options);
}

function hashSimulationState(world, options = {}) {
  const excludes = [...DEFAULT_SIMULATION_EXCLUDES, ...(options.excludePaths || [])];
  return hashWorldState(world, { ...options, excludePaths: excludes });
}

function createStateCheckpoint(world, input = {}, options = {}) {
  const label = typeof input === 'string' ? input : (input.label || null);
  const metadata = typeof input === 'object' && input !== null ? input.metadata || {} : {};
  return {
    version: STATE_HASH_VERSION,
    label,
    worldId: world.id || null,
    tick: Number(world.tick || 0),
    hash: options.simulationOnly === false
      ? hashWorldState(world, options)
      : hashSimulationState(world, options),
    algorithm: options.algorithm || 'sha256',
    metadata: cloneJson(metadata),
  };
}

function compareCanonicalState(expected, actual, options = {}) {
  const expectedValue = canonicalize(expected, {
    excludes: normalizePaths(options.excludePaths || []),
    path: [],
    seen: new Map(),
    nonFiniteNumbers: options.nonFiniteNumbers || 'string',
  });
  const actualValue = canonicalize(actual, {
    excludes: normalizePaths(options.excludePaths || []),
    path: [],
    seen: new Map(),
    nonFiniteNumbers: options.nonFiniteNumbers || 'string',
  });
  const difference = findFirstDifference(expectedValue, actualValue, []);
  return {
    equal: difference === null,
    difference,
    expectedHash: hashCanonicalState(expectedValue),
    actualHash: hashCanonicalState(actualValue),
  };
}

function canonicalize(value, context) {
  if (shouldExclude(context.path, context.excludes)) return undefined;
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
    if (context.nonFiniteNumbers === 'null') return null;
    if (context.nonFiniteNumbers === 'error') throw new Error(`Non-finite number at ${formatPath(context.path)}`);
    return `[${String(value)}]`;
  }
  if (type === 'bigint') return `[BigInt:${value}]`;
  if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined;

  if (context.seen.has(value)) {
    throw new Error(`Cyclic value at ${formatPath(context.path)} references ${context.seen.get(value)}`);
  }
  context.seen.set(value, formatPath(context.path));

  let output;
  if (Array.isArray(value)) {
    output = value.map((item, index) => {
      const normalized = canonicalize(item, { ...context, path: [...context.path, String(index)] });
      return normalized === undefined ? null : normalized;
    });
  } else if (value instanceof Date) {
    output = value.toISOString();
  } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    output = `[Bytes:${Buffer.from(value).toString('base64')}]`;
  } else if (value instanceof Set) {
    output = [...value]
      .map((item, index) => canonicalize(item, { ...context, path: [...context.path, String(index)] }))
      .sort(compareCanonicalValues);
  } else if (value instanceof Map) {
    output = Object.fromEntries([...value.entries()]
      .map(([key, item]) => [String(key), item])
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item, { ...context, path: [...context.path, key] })]));
  } else {
    output = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = canonicalize(value[key], { ...context, path: [...context.path, key] });
      if (normalized !== undefined) output[key] = normalized;
    }
  }

  context.seen.delete(value);
  return output;
}

function findFirstDifference(expected, actual, path) {
  if (Object.is(expected, actual)) return null;
  if (typeof expected !== typeof actual || expected === null || actual === null) {
    return difference(path, expected, actual, 'value');
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return difference(path, expected, actual, 'type');
    if (expected.length !== actual.length) {
      return difference(path, expected.length, actual.length, 'array_length');
    }
    for (let index = 0; index < expected.length; index += 1) {
      const nested = findFirstDifference(expected[index], actual[index], [...path, String(index)]);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof expected === 'object') {
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    if (expectedKeys.join('\u0000') !== actualKeys.join('\u0000')) {
      return difference(path, expectedKeys, actualKeys, 'object_keys');
    }
    for (const key of expectedKeys) {
      const nested = findFirstDifference(expected[key], actual[key], [...path, key]);
      if (nested) return nested;
    }
    return null;
  }
  return difference(path, expected, actual, 'value');
}

function difference(path, expected, actual, reason) {
  return {
    path: formatPath(path),
    segments: [...path],
    reason,
    expected: cloneJson(expected),
    actual: cloneJson(actual),
  };
}

function shouldExclude(path, patterns) {
  return patterns.some(pattern => pathMatches(path, pattern));
}

function pathMatches(path, pattern) {
  if (pattern.length > path.length) return false;
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] !== '*' && pattern[index] !== path[index]) return false;
  }
  return pattern.length === path.length;
}

function normalizePaths(paths) {
  return (Array.isArray(paths) ? paths : [paths])
    .filter(Boolean)
    .map(path => Array.isArray(path)
      ? path.map(String)
      : String(path).split('.').map(item => item.trim()).filter(Boolean));
}

function compareCanonicalValues(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function formatPath(path) {
  return path.length ? path.map((segment, index) => (
    /^\d+$/.test(segment) ? `[${segment}]` : `${index ? '.' : ''}${segment}`
  )).join('') : '$';
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  STATE_HASH_VERSION,
  DEFAULT_SIMULATION_EXCLUDES,
  canonicalStringify,
  hashCanonicalState,
  hashWorldState,
  hashSimulationState,
  createStateCheckpoint,
  compareCanonicalState,
  normalizePaths,
};
