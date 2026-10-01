'use strict';

// Membership is supplied only for one synchronous rebuild of fresh indexes.
// Nothing is cached on the world or reused after callers can edit an array.
function addOrderedIndex(index, key, value, membership) {
  if (!index[key]) index[key] = [];
  const bucket = index[key];
  if (!membership || !Array.isArray(bucket)) {
    if (!bucket.includes(value)) bucket.push(value);
    return;
  }
  let seen = membership.get(bucket);
  if (!seen) { seen = new Set(bucket); membership.set(bucket, seen); }
  if (!seen.has(value)) { bucket.push(value); seen.add(value); }
}

module.exports = { addOrderedIndex };
