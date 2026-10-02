'use strict';

// Only actions explicitly attached by the command dispatcher can settle a command.
function settlePlayerAction(world, action, outcome) {
  const commandId = action.playerCommandId;
  if (!commandId || !Object.hasOwn(world.commands?.byId || {}, commandId)) return;
  const command = world.commands.byId[commandId];
  if (command.status !== 'accepted' || command.result?.actionId !== action.id) return;
  const ok = outcome.status === 'completed' && outcome.result?.moved !== false;
  command.status = ok ? 'completed' : 'rejected';
  command.updatedAt = world.tick;
  command.result = { ...command.result, ok, completed: true, actionStatus: outcome.status,
    ...(ok ? { value: outcome.result } : { reason: outcome.reason || outcome.result?.reason || 'action_failed' }) };
  // accepted counts admissions; completed/rejected include later settlements.
  world.commands.stats[ok ? 'completed' : 'rejected'] += 1;
}
module.exports = { settlePlayerAction };
