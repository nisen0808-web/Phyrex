'use strict';
// Frozen a89b0e0 reference algorithms: change implementation, not these acceptance oracles.
const { ensureMemoryState, DEFAULT_MEMORY_OPTIONS } = require('../../core/memory-engine');
const { DEFAULT_DESIRE_OPTIONS, ensureEntityDesires, updateDesireProfile, generateGoalsFromDesires, ensureDesireState, getDesireStats } = require('../../core/desire-engine');
function legacyTrimGlobalMemories(world, maxGlobal = DEFAULT_MEMORY_OPTIONS.maxGlobalMemories, maxPerOwner = DEFAULT_MEMORY_OPTIONS.maxMemoriesPerOwner) {
  const state = ensureMemoryState(world);
  const pruned = [];

  for (const key of Object.keys(state.byOwner)) {
    const memories = (state.byOwner[key] || []).map(id => state.byId[id]).filter(Boolean);
    const kept = memories.sort((a, b) => scoreMemoryForRetention(b) - scoreMemoryForRetention(a)).slice(0, maxPerOwner);
    const keptIds = new Set(kept.map(memory => memory.id));
    for (const memory of memories) {
      if (!keptIds.has(memory.id)) {
        delete state.byId[memory.id];
        pruned.push(memory.id);
      }
    }
    state.byOwner[key] = kept.map(memory => memory.id);
  }

  const all = Object.values(state.byId);
  if (all.length > maxGlobal) {
    const keep = new Set(all.sort((a, b) => scoreMemoryForRetention(b) - scoreMemoryForRetention(a)).slice(0, maxGlobal).map(memory => memory.id));
    for (const memory of all) {
      if (!keep.has(memory.id)) {
        delete state.byId[memory.id];
        pruned.push(memory.id);
      }
    }
    for (const key of Object.keys(state.byOwner)) {
      state.byOwner[key] = (state.byOwner[key] || []).filter(id => keep.has(id));
    }
  }

  if (pruned.length) {
    state.stats.pruned += pruned.length;
    state._indexDirty = true;
  }
  return pruned;
}

function scoreMemoryForRetention(memory) {
  return Number(memory.importance || 0) * 2
    + Number(memory.clarity || 0)
    + Math.abs(Number(memory.emotionalWeight || 0))
    + Number(memory.lastReinforcedAt || memory.createdAt || 0) * 0.01;
}

function legacyProcessDesireTick(world, options = {}) {
  const config = { ...DEFAULT_DESIRE_OPTIONS, ...(options || {}) };
  const updated = [];
  const generatedGoals = [];
  for (const entity of Object.values(world.entities || {})) {
    if (entity.status !== 'alive') continue;
    ensureEntityDesires(world, entity.id);
    updateDesireProfile(world, entity.id, config);
    const goals = generateGoalsFromDesires(world, entity.id, config);
    updated.push(entity.id);
    generatedGoals.push(...goals);
  }
  const state = ensureDesireState(world);
  state.stats.updated += updated.length;
  state.stats.goalsGenerated += generatedGoals.length;
  state.stats.environmentGoalsGenerated += generatedGoals.filter(goal => goal.tags?.includes('environment_generated')).length;
  return { updated, generatedGoals, stats: getDesireStats(world) };
}

module.exports = { legacyTrimGlobalMemories, legacyProcessDesireTick };
