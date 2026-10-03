'use strict';
// Frozen rebuild algorithms from 441d2d0. Keep their insertion/deduplication
// semantics independent of the optimized ordered-index helper.
const { ensureMemoryState } = require('../../core/memory-engine');
const { ensureInformationState } = require('../../core/information-engine');
function addIndex(index, key, value) {
  if (!index[key]) index[key] = [];
  if (!index[key].includes(value)) index[key].push(value);
}
function rebuildMemoryIndexes(world, force = false) {
  const state = ensureMemoryState(world);
  const count = Object.keys(state.byId).length;
  if (!force && !state._indexDirty && state._lastIndexedCount === count) return;
  state.indexes = { byType: {}, byScope: {}, byTag: {} };
  for (const memory of Object.values(state.byId)) {
    ensureMemoryState(world);
    addIndex(state.indexes.byType, memory.type, memory.id);
    addIndex(state.indexes.byScope, memory.scope, memory.id);
    for (const tag of memory.tags || []) addIndex(state.indexes.byTag, tag, memory.id);
  }
  state._indexDirty = false;
  state._lastIndexedCount = count;
}
function rebuildInformationIndexes(world, force = false) {
  const state = ensureInformationState(world);
  const count = Object.keys(state.items).length;
  if (!force && !state._indexDirty && state._lastIndexedItemCount === count) return;
  state.indexes = { byType: {}, byStatus: {}, byLocation: {}, byTag: {} };
  for (const item of Object.values(state.items)) {
    ensureInformationState(world);
    addIndex(state.indexes.byType, item.type, item.id);
    addIndex(state.indexes.byStatus, item.status, item.id);
    if (item.originLocationId) addIndex(state.indexes.byLocation, item.originLocationId, item.id);
    for (const tag of item.tags || []) addIndex(state.indexes.byTag, tag, item.id);
  }
  state._indexDirty = false;
  state._lastIndexedItemCount = count;
}
module.exports = { rebuildMemoryIndexes, rebuildInformationIndexes };
