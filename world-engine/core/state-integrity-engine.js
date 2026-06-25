'use strict';

const crypto = require('crypto');

const DEFAULT_HASH_OPTIONS = {
  algorithm: 'sha256',
  excludePaths: [],
  maxDifferences: 25,
};

function canonicalize(value, options = {}, path = '', seen = new WeakSet()) {
  const config = { ...DEFAULT_HASH_OPTIONS, ...(options || {}) };
  if (shouldExcludePath(path, config.excludePaths)) return undefined;
  if (value === null) return null;

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (Number.isNaN(value)) return { $number: 'NaN' };
    if (value === Infinity) return { $number: 'Infinity' };
    if (value === -Infinity) return { $number: '-Infinity' };
    if (Object.is(value, -0)) return 0;
    return value;
  }
  if (type === 'bigint') return { $bigint: value.toString() };
  if (type === 'undefined') return { $undefined: true };
  if (type === 'function' || type === 'symbol') return undefined;

  if (Buffer.isBuffer(value)) return { $buffer: value.toString('base64') };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (seen.has(value)) throw new Error(`Cannot canonicalize circular value at ${path || '<root>'}`);
  seen.add(value);

  let output;
  if (Array.isArray(value)) {
    output = value.map((item, index) => {
      const next = canonicalize(item, config, joinPath(path, String(index)), seen);
      return next === undefined ? null : next;
    });
  } else if (value instanceof Map) {
    output = {
      $map: [...value.entries()]
        .map(([key, item]) => [canonicalize(key, config, joinPath(path, '$key'), seen), canonicalize(item, config, joinPath(path, String(key)), seen)])
        .sort((left, right) => stableStringify(left[0]).localeCompare(stableStringify(right[0]))),
    };
  } else if (value instanceof Set) {
    output = {
      $set: [...value.values()]
        .map(item => canonicalize(item, config, joinPath(path, '$set'), seen))
        .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))),
    };
  } else {
    output = {};
    for (const key of Object.keys(value).sort()) {
      const nextPath = joinPath(path, key);
      if (shouldExcludePath(nextPath, config.excludePaths)) continue;
      const next = canonicalize(value[key], config, nextPath, seen);
      if (next !== undefined) output[key] = next;
    }
  }

  seen.delete(value);
  return output;
}

function stableStringify(value, options = {}) {
  return JSON.stringify(canonicalize(value, options));
}

function hashState(value, options = {}) {
  const config = { ...DEFAULT_HASH_OPTIONS, ...(options || {}) };
  return crypto
    .createHash(config.algorithm)
    .update(stableStringify(value, config), 'utf8')
    .digest('hex');
}

function hashWorldState(world, options = {}) {
  if (!world || typeof world !== 'object') throw new Error('hashWorldState requires world');
  return hashState(world, options);
}

function compareStates(left, right, options = {}) {
  const config = { ...DEFAULT_HASH_OPTIONS, ...(options || {}) };
  const canonicalLeft = canonicalize(left, config);
  const canonicalRight = canonicalize(right, config);
  const leftHash = hashState(canonicalLeft, { algorithm: config.algorithm });
  const rightHash = hashState(canonicalRight, { algorithm: config.algorithm });
  const differences = [];
  if (leftHash !== rightHash) {
    collectDifferences(canonicalLeft, canonicalRight, '', differences, config.maxDifferences);
  }
  return {
    equal: leftHash === rightHash,
    leftHash,
    rightHash,
    differences,
  };
}

function verifyStateHash(value, expectedHash, options = {}) {
  const actualHash = hashState(value, options);
  return {
    ok: actualHash === expectedHash,
    expectedHash,
    actualHash,
  };
}

function cloneCanonical(value, options = {}) {
  return JSON.parse(stableStringify(value, options));
}

function collectDifferences(left, right, path, output, limit) {
  if (output.length >= limit) return;
  if (Object.is(left, right)) return;

  const leftArray = Array.isArray(left);
  const rightArray = Array.isArray(right);
  const leftObject = left && typeof left === 'object';
  const rightObject = right && typeof right === 'object';

  if (!leftObject || !rightObject || leftArray !== rightArray) {
    output.push({ path: path || '<root>', left, right });
    return;
  }

  if (leftArray && rightArray) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length && output.length < limit; index += 1) {
      if (index >= left.length || index >= right.length) {
        output.push({
          path: joinPath(path, String(index)),
          left: index < left.length ? left[index] : { $missing: true },
          right: index < right.length ? right[index] : { $missing: true },
        });
      } else {
        collectDifferences(left[index], right[index], joinPath(path, String(index)), output, limit);
      }
    }
    return;
  }

  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  for (const key of keys) {
    if (output.length >= limit) break;
    if (!Object.prototype.hasOwnProperty.call(left, key) || !Object.prototype.hasOwnProperty.call(right, key)) {
      output.push({
        path: joinPath(path, key),
        left: Object.prototype.hasOwnProperty.call(left, key) ? left[key] : { $missing: true },
        right: Object.prototype.hasOwnProperty.call(right, key) ? right[key] : { $missing: true },
      });
    } else {
      collectDifferences(left[key], right[key], joinPath(path, key), output, limit);
    }
  }
}

function shouldExcludePath(path, patterns = []) {
  if (!path) return false;
  return (patterns || []).some(pattern => {
    if (pattern instanceof RegExp) return pattern.test(path);
    const text = String(pattern || '').trim();
    if (!text) return false;
    if (text.endsWith('.*')) {
      const prefix = text.slice(0, -2);
      return path === prefix || path.startsWith(`${prefix}.`);
    }
    return path === text;
  });
}

function joinPath(base, key) {
  return base ? `${base}.${key}` : key;
}

module.exports = {
  DEFAULT_HASH_OPTIONS,
  canonicalize,
  stableStringify,
  hashState,
  hashWorldState,
  compareStates,
  verifyStateHash,
  cloneCanonical,
};
