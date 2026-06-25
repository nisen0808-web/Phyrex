'use strict';

const { executePlayerCommand } = require('./command-engine');
const { processPlayersTick } = require('./player-engine');
const { processQuestsTick } = require('./quest-engine');
const { processTutorialTick } = require('./tutorial-engine');
const { runDeterministicSimulationTicks } = require('./deterministic-simulation-engine');
const { recordPlayerJournal, JOURNAL_TYPES } = require('./player-journal-engine');
const { nextWorldId } = require('./world-id-engine');
const { withDeterministicGlobals } = require('./random-engine');

const OFFLINE_COMMAND_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const DEFAULT_OFFLINE_OPTIONS = {
  maxQueuePerPlayer: 100,
  maxCompletedPerPlayer: 200,
};

function ensureOfflineCommandState(world) {
  if (!world.offlineCommands) {
    world.offlineCommands = {
      byId: {},
      byPlayer: {},
      queue: [],
      stats: {
        queued: 0,
        started: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      },
    };
  }
  return world.offlineCommands;
}

function scheduleOfflineCommand(world, playerId, input = {}, options = {}) {
  if (!playerId) throw new Error('scheduleOfflineCommand requires playerId');
  if (!input.type) throw new Error('scheduleOfflineCommand requires command type');
  const state = ensureOfflineCommandState(world);
  const id = input.id || nextWorldId(world, 'offline', 'offline.command');
  const durationTicks = Math.max(1, Number(input.durationTicks || input.ticks || 1));
  const item = {
    id,
    playerId,
    type: input.type,
    payload: { ...(input.payload || {}), ...copyOfflinePayload(input) },
    status: OFFLINE_COMMAND_STATUS.QUEUED,
    createdAt: world.tick,
    startsAt: Math.max(world.tick, Number(input.startsAt ?? world.tick)),
    durationTicks,
    remainingTicks: durationTicks,
    runsEveryTicks: Math.max(1, Number(input.runsEveryTicks || durationTicks)),
    nextRunAt: Math.max(world.tick, Number(input.startsAt ?? world.tick)),
    repeat: Math.max(1, Number(input.repeat || 1)),
    completedRuns: 0,
    lastRunAt: null,
    completedAt: null,
    resultLog: [],
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
  };
  state.byId[id] = item;
  if (!state.byPlayer[playerId]) state.byPlayer[playerId] = [];
  state.byPlayer[playerId].push(id);
  state.queue.push(id);
  state.stats.queued += 1;
  trimPlayerOfflineCommands(world, playerId, options.maxCompletedPerPlayer || DEFAULT_OFFLINE_OPTIONS.maxCompletedPerPlayer);
  recordPlayerJournal(world, playerId, {
    type: JOURNAL_TYPES.COMMAND,
    title: `Queued offline ${item.type}`,
    summary: `Queued ${item.type} for ${durationTicks} tick(s), repeat ${item.repeat}.`,
    tags: ['offline', 'queued', item.type],
    payload: { offlineCommandId: id },
  });
  return item;
}

function processOfflineCommandsTick(world, options = {}) {
  const state = ensureOfflineCommandState(world);
  const due = state.queue.map(id => state.byId[id]).filter(Boolean).filter(command => shouldRun(world, command));
  const reports = [];
  for (const command of due) reports.push(runOfflineCommand(world, command, options));
  cleanupQueue(world);
  return { tick: world.tick, processed: reports.length, reports };
}

function runOfflineCommand(world, command, options = {}) {
  const state = ensureOfflineCommandState(world);
  if (!command) return null;
  command.status = OFFLINE_COMMAND_STATUS.RUNNING;
  state.stats.started += 1;
  let result;
  try {
    result = executePlayerCommand(world, command.playerId, { type: command.type, ...(command.payload || {}) }, options.command || {});
    command.completedRuns += 1;
    command.remainingTicks = Math.max(0, command.remainingTicks - command.runsEveryTicks);
    command.lastRunAt = world.tick;
    command.resultLog.push({ tick: world.tick, commandId: result.command.id, status: result.command.status, result: result.result });
    if (command.resultLog.length > 20) command.resultLog.shift();
    if (command.completedRuns >= command.repeat || command.remainingTicks <= 0) {
      command.status = OFFLINE_COMMAND_STATUS.COMPLETED;
      command.completedAt = world.tick;
      state.stats.completed += 1;
      recordPlayerJournal(world, command.playerId, { type: JOURNAL_TYPES.COMMAND, title: `Completed offline ${command.type}`, summary: `Offline ${command.type} completed after ${command.completedRuns} run(s).`, tags: ['offline', 'completed', command.type], payload: { offlineCommandId: command.id } });
    } else {
      command.status = OFFLINE_COMMAND_STATUS.QUEUED;
      command.nextRunAt = world.tick + command.runsEveryTicks;
    }
    return { offlineCommandId: command.id, ok: true, status: command.status, result };
  } catch (error) {
    command.status = OFFLINE_COMMAND_STATUS.FAILED;
    command.completedAt = world.tick;
    command.resultLog.push({ tick: world.tick, error: error.message });
    state.stats.failed += 1;
    recordPlayerJournal(world, command.playerId, { type: JOURNAL_TYPES.COMMAND, title: `Failed offline ${command.type}`, summary: error.message || 'offline command failed', tags: ['offline', 'failed', command.type], payload: { offlineCommandId: command.id } });
    return { offlineCommandId: command.id, ok: false, error: error.message };
  }
}

function advanceWorldWithOfflineCommands(world, ticks = 1, options = {}) {
  const reports = [];
  for (let i = 0; i < ticks; i += 1) {
    const report = withDeterministicGlobals(world, 'runtime.offline', () => {
      const simulation = runDeterministicSimulationTicks(world, 1, options.simulation || {});
      const offline = processOfflineCommandsTick(world, options);
      processPlayersTick(world);
      processTutorialTick(world, { autoStart: true, claimCompleted: false });
      processQuestsTick(world);
      return { tick: world.tick, simulation, offline };
    });
    reports.push(report);
  }
  return reports;
}

function cancelOfflineCommand(world, offlineCommandId, reason = 'cancelled') {
  const state = ensureOfflineCommandState(world);
  const command = state.byId[offlineCommandId];
  if (!command) return null;
  if ([OFFLINE_COMMAND_STATUS.COMPLETED, OFFLINE_COMMAND_STATUS.FAILED, OFFLINE_COMMAND_STATUS.CANCELLED].includes(command.status)) return command;
  command.status = OFFLINE_COMMAND_STATUS.CANCELLED;
  command.completedAt = world.tick;
  command.cancelReason = reason;
  state.stats.cancelled += 1;
  cleanupQueue(world);
  recordPlayerJournal(world, command.playerId, { type: JOURNAL_TYPES.COMMAND, title: `Cancelled offline ${command.type}`, summary: reason, tags: ['offline', 'cancelled', command.type], payload: { offlineCommandId } });
  return command;
}

function getPlayerOfflineCommands(world, playerId, filters = {}) {
  const state = ensureOfflineCommandState(world);
  return (state.byPlayer[playerId] || [])
    .map(id => state.byId[id])
    .filter(Boolean)
    .filter(command => !filters.status || command.status === filters.status)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, filters.limit || 50);
}

function getOfflineCommandStats(world) {
  const state = ensureOfflineCommandState(world);
  const all = Object.values(state.byId || {});
  return {
    total: all.length,
    queued: all.filter(c => c.status === OFFLINE_COMMAND_STATUS.QUEUED).length,
    running: all.filter(c => c.status === OFFLINE_COMMAND_STATUS.RUNNING).length,
    completed: all.filter(c => c.status === OFFLINE_COMMAND_STATUS.COMPLETED).length,
    failed: all.filter(c => c.status === OFFLINE_COMMAND_STATUS.FAILED).length,
    cancelled: all.filter(c => c.status === OFFLINE_COMMAND_STATUS.CANCELLED).length,
    byType: countBy(all.map(command => command.type)),
    stats: { ...state.stats },
  };
}

function formatOfflineCommands(commands = []) {
  if (!commands.length) return 'No offline commands.';
  return commands.map(command => `${command.id} ${command.type} ${command.status} runs=${command.completedRuns}/${command.repeat} next=${command.nextRunAt}`).join('\n');
}

function shouldRun(world, command) {
  return command.status === OFFLINE_COMMAND_STATUS.QUEUED && Number(command.nextRunAt || command.startsAt || 0) <= world.tick;
}

function cleanupQueue(world) {
  const state = ensureOfflineCommandState(world);
  state.queue = state.queue.filter(id => state.byId[id] && state.byId[id].status === OFFLINE_COMMAND_STATUS.QUEUED);
}

function trimPlayerOfflineCommands(world, playerId, limit) {
  const state = ensureOfflineCommandState(world);
  const ids = state.byPlayer[playerId] || [];
  const completed = ids.map(id => state.byId[id]).filter(Boolean).filter(command => [OFFLINE_COMMAND_STATUS.COMPLETED, OFFLINE_COMMAND_STATUS.FAILED, OFFLINE_COMMAND_STATUS.CANCELLED].includes(command.status));
  if (completed.length <= limit) return [];
  const remove = completed.sort((a, b) => Number(a.completedAt || a.createdAt || 0) - Number(b.completedAt || b.createdAt || 0)).slice(0, completed.length - limit);
  for (const command of remove) delete state.byId[command.id];
  state.byPlayer[playerId] = ids.filter(id => state.byId[id]);
  cleanupQueue(world);
  return remove;
}

function copyOfflinePayload(input) {
  const out = {};
  for (const key of ['locationId', 'targetId', 'targetType', 'organizationId', 'entityId', 'resource', 'amount', 'ticks', 'role', 'goalType', 'priority', 'effect', 'energyCost', 'health', 'energy', 'power', 'lethal', 'createContract']) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

function countBy(values) {
  const out = {};
  for (const value of values || []) {
    const key = value === undefined || value === null ? 'unknown' : String(value);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

module.exports = {
  OFFLINE_COMMAND_STATUS,
  DEFAULT_OFFLINE_OPTIONS,
  ensureOfflineCommandState,
  scheduleOfflineCommand,
  processOfflineCommandsTick,
  runOfflineCommand,
  advanceWorldWithOfflineCommands,
  cancelOfflineCommand,
  getPlayerOfflineCommands,
  getOfflineCommandStats,
  formatOfflineCommands,
};
