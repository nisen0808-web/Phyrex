'use strict';
const { detachedJson, canonicalJson } = require('../storage/postgres/codec');
const { repairLoadedWorld } = require('../core/persistence-engine');

function canonicalWorldCopy(world) {
  return JSON.parse(canonicalJson(detachedJson(world)));
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
