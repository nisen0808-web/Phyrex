'use strict';

const { advanceWorldWithOfflineCommands, getOfflineCommandStats } = require('./offline-command-engine');
const { saveWorld } = require('./persistence-engine');
const { createWorldSnapshot } = require('./snapshot-engine');

const RUNTIME_STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  STOPPED: 'stopped',
};

const DEFAULT_RUNTIME_OPTIONS = {
  tickBatch: 1,
  maxTicks: 0,
  autosaveEveryTicks: 0,
  autosavePath: null,
  snapshotEveryTicks: 0,
  stopOnError: true,
};

function createWorldRuntime(world, options = {}) {
  if (!world) throw new Error('createWorldRuntime requires world');
  return {
    world,
    options: { ...DEFAULT_RUNTIME_OPTIONS, ...(options || {}) },
    status: RUNTIME_STATUS.IDLE,
    startedAtTick: world.tick,
    stoppedAtTick: null,
    ticksRun: 0,
    saves: [],
    snapshots: [],
    errors: [],
  };
}

function runWorldRuntime(runtime, options = {}) {
  const config = { ...(runtime.options || DEFAULT_RUNTIME_OPTIONS), ...(options || {}) };
  runtime.options = config;
  runtime.status = RUNTIME_STATUS.RUNNING;
  const maxTicks = Math.max(0, Number(config.maxTicks || 0));
  const batch = Math.max(1, Number(config.tickBatch || 1));
  const target = maxTicks || batch;
  while (runtime.status === RUNTIME_STATUS.RUNNING && runtime.ticksRun < target) {
    const step = Math.min(batch, target - runtime.ticksRun);
    try {
      advanceWorldWithOfflineCommands(runtime.world, step, config);
      runtime.ticksRun += step;
      handleRuntimeArtifacts(runtime, config);
    } catch (error) {
      const entry = { tick: runtime.world.tick, message: error.message || 'runtime_error' };
      runtime.errors.push(entry);
      if (config.stopOnError !== false) {
        runtime.status = RUNTIME_STATUS.STOPPED;
        break;
      }
    }
  }
  if (runtime.status === RUNTIME_STATUS.RUNNING) runtime.status = RUNTIME_STATUS.IDLE;
  runtime.stoppedAtTick = runtime.world.tick;
  return getRuntimeSummary(runtime);
}

function runRuntimeTicks(world, ticks = 1, options = {}) {
  const runtime = createWorldRuntime(world, { ...options, maxTicks: ticks });
  return runWorldRuntime(runtime);
}

function stopWorldRuntime(runtime, reason = 'manual') {
  runtime.status = RUNTIME_STATUS.STOPPED;
  runtime.stopReason = reason;
  runtime.stoppedAtTick = runtime.world.tick;
  return getRuntimeSummary(runtime);
}

function getRuntimeSummary(runtime) {
  return {
    status: runtime.status,
    worldId: runtime.world.id,
    tick: runtime.world.tick,
    ticksRun: runtime.ticksRun,
    startedAtTick: runtime.startedAtTick,
    stoppedAtTick: runtime.stoppedAtTick,
    saves: [...(runtime.saves || [])],
    snapshots: [...(runtime.snapshots || [])],
    errors: [...(runtime.errors || [])],
    offline: getOfflineCommandStats(runtime.world),
  };
}

function handleRuntimeArtifacts(runtime, config) {
  if (config.autosaveEveryTicks && config.autosavePath && runtime.world.tick % Number(config.autosaveEveryTicks) === 0) {
    const save = saveWorld(runtime.world, config.autosavePath, { reason: 'runtime_autosave' });
    runtime.saves.push(save);
  }
  if (config.snapshotEveryTicks && runtime.world.tick % Number(config.snapshotEveryTicks) === 0) {
    runtime.snapshots.push({ tick: runtime.world.tick, snapshot: createWorldSnapshot(runtime.world) });
    if (runtime.snapshots.length > 10) runtime.snapshots.shift();
  }
}

module.exports = {
  RUNTIME_STATUS,
  DEFAULT_RUNTIME_OPTIONS,
  createWorldRuntime,
  runWorldRuntime,
  runRuntimeTicks,
  stopWorldRuntime,
  getRuntimeSummary,
};
