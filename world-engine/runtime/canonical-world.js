'use strict';
const { detachedJson } = require('../storage/postgres/codec');
const { repairLoadedWorld } = require('../core/persistence-engine');
const { isProxy } = require('node:util').types;
const LEGACY_CAPTURE = Symbol('legacy JSON capture');

function canonicalWorldCopy(world) {
  // Plain data can be validated, detached and ordered in one traversal. Do not
  // evaluate user accessors/toJSON or Proxy traps while choosing this path:
  // those values keep the established JSON capture, including call order.
  try {
    const captured = capturePlainJson(world, new Set());
    if (captured !== undefined) return captured;
  } catch (error) {
    if (error !== LEGACY_CAPTURE) throw error;
  }
  return sortCapturedJson(detachedJson(world));
}
function capturePlainJson(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || value === undefined) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? 0 : value;
  if (typeof value !== 'object' || isProxy(value)) throw LEGACY_CAPTURE;
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if ((array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      || 'toJSON' in value || ancestors.has(value) || ancestors.size >= 256) throw LEGACY_CAPTURE;
  ancestors.add(value);
  let result;
  if (array) {
    result = [];
    for (let index = 0; index < value.length; index++) {
      if (index in Array.prototype) throw LEGACY_CAPTURE;
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor && index in value) throw LEGACY_CAPTURE;
      if (descriptor && !Object.hasOwn(descriptor, 'value')) throw LEGACY_CAPTURE;
      const child = capturePlainJson(descriptor?.value, ancestors);
      result[index] = child === undefined ? null : child;
    }
  } else {
    result = {};
    for (const key of Object.keys(value).sort()) {
      // An inherited setter could execute user code before a later fallback.
      if (key !== '__proto__' && key in Object.prototype) throw LEGACY_CAPTURE;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!Object.hasOwn(descriptor, 'value')) throw LEGACY_CAPTURE;
      const child = capturePlainJson(descriptor.value, ancestors);
      if (child === undefined) continue;
      if (key === '__proto__') Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true });
      else result[key] = child;
    }
  }
  ancestors.delete(value);
  return result;
}
function sortCapturedJson(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) value[index] = sortCapturedJson(value[index]);
    return value;
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const child = sortCapturedJson(value[key]);
    if (key === '__proto__') Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true });
    else result[key] = child;
  }
  return result;
}
function canonicalizeWorldInPlace(world) {
  // JSONB reorders object keys. Normalize before every tick, not only after a
  // restore, so map iteration and derived audit digests are restart-independent.
  // Arrays are intentionally never reordered: their order is simulation state.
  repairLoadedWorld(world);
  const normalized = canonicalWorldCopy(world);
  for (const key of Object.keys(world)) delete world[key];
  Object.assign(world, normalized);
  return world;
}
module.exports = { canonicalWorldCopy, canonicalizeWorldInPlace };
