'use strict';
const { validateTerminalLimit, pruneTerminalRecords, processReferences, finiteTick } = require('./terminal-retention-engine');

function pruneWorldGoalHistory(world, options = {}) {
  const limit = options.maxTerminalGoalsPerEntity;
  validateTerminalLimit(limit, 'maxTerminalGoalsPerEntity');
  if (limit === undefined) return null;
  const protectedIds = processReferences(world, 'goal');
  for (const row of [...(world.actionQueue || []), ...(world.events || []).filter(event => event.status === 'pending')]) {
    if (typeof row.payload?.goalId === 'string') protectedIds.add(row.payload.goalId);
  }
  const memoryIds = new Set((world.memory || []).map(row => row.id));
  let removed = 0, overLimit = 0;
  for (const entity of Object.values(world.entities || {})) {
    if (!Array.isArray(entity.goals)) continue;
    const state = { byId: Object.fromEntries(entity.goals.map(goal => [goal.id, goal])), retention: entity.goalRetention };
    const report = pruneTerminalRecords(state, limit, {
      isTerminal: row => ['completed', 'failed', 'abandoned'].includes(row.status),
      terminalTick: row => finiteTick(row.completedAt, row.updatedAt, row.createdAt), protectedIds,
    });
    // Preserve survivor order: goal choice ties must not change with pruning.
    entity.goals = entity.goals.filter(goal => Object.hasOwn(state.byId, goal.id));
    entity.goalRetention = state.retention;
    if (Array.isArray(entity.goalMemory)) entity.goalMemory = entity.goalMemory.filter(id => memoryIds.has(id));
    removed += report.removedIds.length; overLimit += report.overLimit;
  }
  return { removed, overLimit };
}
module.exports = { pruneWorldGoalHistory };
