'use strict';
const { detachedJson } = require('../storage/postgres/codec');
const { repairLoadedWorld } = require('../core/persistence-engine');

function canonicalWorldCopy(world) {
  // Keep the established finite-JSON boundary, then sort the captured tree
  // directly instead of building and parsing another full-world JSON string.
  return sortCapturedJson(detachedJson(world));
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
