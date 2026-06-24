'use strict';

const { advanceWorldWithOfflineCommands } = require('./offline-command-engine');
const { saveWorld } = require('./persistence-engine');

const RUNTIME_LOOP_STATUS = {
  STOPPED: 'stopped',
  RUNNING: 'running',
  PAUSED: 'paused',
};

const DEFAULT_RUNTIME_LOOP_OPTIONS = {
  intervalMs: 1000,
  ticksPerCycle: 1,
  autosaveEveryTicks: 0,
  autosavePath: null,
  stopOnError: false,
  maxErrors: 50,
  immediate: false,
  simulation: {},
  persistence: {},
};

function createRuntimeLoop(worldOrProvider, options = {}) {
  const getWorld = typeof worldOrProvider === 'function'
    ? worldOrProvider
    : () => worldOrProvider;
  const world = getWorld();
  if (!world) throw new Error('createRuntimeLoop requires world or world provider');

  return {
    getWorld,
    options: mergeOptions(DEFAULT_RUNTIME_LOOP_OPTIONS, options || {}),
    status: RUNTIME_LOOP_STATUS.STOPPED,
    timer: null,
    busy: false,
    cycles: 0,
    ticksRun: 0,
    startedAt: null,
    stoppedAt: null,
    pausedAt: null,
    lastCycleAt: null,
    nextCycleAt: null,
    lastDurationMs: 0,
    totalDurationMs: 0,
    lastTickBefore: world.tick,
    lastTickAfter: world.tick,
    lastAutosaveTick: world.tick,
    lastAutosave: null,
    stopReason: null,
    errors: [],
    onCycle: typeof options.onCycle === 'function' ? options.onCycle : null,
  };
}

function startRuntimeLoop(loop, options = {}) {
  if (!loop) throw new Error('startRuntimeLoop requires loop');
  if (Object.keys(options || {}).length) configureRuntimeLoop(loop, options, { reschedule: false });
  if (loop.status === RUNTIME_LOOP_STATUS.RUNNING) return getRuntimeLoopSummary(loop);

  loop.status = RUNTIME_LOOP_STATUS.RUNNING;
  loop.startedAt = loop.startedAt || new Date().toISOString();
  loop.stoppedAt = null;
  loop.pausedAt = null;
  loop.stopReason = null;
  scheduleNextCycle(loop, loop.options.immediate ? 0 : loop.options.intervalMs);
  return getRuntimeLoopSummary(loop);
}

function pauseRuntimeLoop(loop, reason = 'manual') {
  clearLoopTimer(loop);
  loop.status = RUNTIME_LOOP_STATUS.PAUSED;
  loop.pausedAt = new Date().toISOString();
  loop.stopReason = reason;
  loop.nextCycleAt = null;
  return getRuntimeLoopSummary(loop);
}

function stopRuntimeLoop(loop, reason = 'manual') {
  clearLoopTimer(loop);
  loop.status = RUNTIME_LOOP_STATUS.STOPPED;
  loop.stoppedAt = new Date().toISOString();
  loop.stopReason = reason;
  loop.nextCycleAt = null;
  return getRuntimeLoopSummary(loop);
}

function configureRuntimeLoop(loop, patch = {}, options = {}) {
  if (!loop) throw new Error('configureRuntimeLoop requires loop');
  const wasRunning = loop.status === RUNTIME_LOOP_STATUS.RUNNING;
  const onCycle = typeof patch.onCycle === 'function' ? patch.onCycle : loop.onCycle;
  const safePatch = { ...(patch || {}) };
  delete safePatch.onCycle;
  loop.options = mergeOptions(loop.options || DEFAULT_RUNTIME_LOOP_OPTIONS, safePatch);
  loop.options.intervalMs = Math.max(10, Number(loop.options.intervalMs || 1000));
  loop.options.ticksPerCycle = Math.max(1, Number(loop.options.ticksPerCycle || 1));
  loop.onCycle = onCycle;

  if (wasRunning && options.reschedule !== false) {
    clearLoopTimer(loop);
    scheduleNextCycle(loop, loop.options.intervalMs);
  }
  return getRuntimeLoopSummary(loop);
}

function stepRuntimeLoop(loop, ticks = null, metadata = {}) {
  if (!loop) throw new Error('stepRuntimeLoop requires loop');
  if (loop.busy) {
    return {
      ok: false,
      skipped: true,
      reason: 'runtime_loop_busy',
      summary: getRuntimeLoopSummary(loop),
    };
  }

  const world = loop.getWorld();
  if (!world) throw new Error('Runtime loop world provider returned no world');
  const amount = Math.max(1, Number(ticks || loop.options.ticksPerCycle || 1));
  const started = Date.now();
  const tickBefore = Number(world.tick || 0);
  loop.busy = true;

  let report;
  try {
    const reports = advanceWorldWithOfflineCommands(world, amount, {
      simulation: loop.options.simulation || {},
      command: loop.options.command || {},
    });
    const tickAfter = Number(world.tick || tickBefore);
    const durationMs = Date.now() - started;
    loop.cycles += 1;
    loop.ticksRun += Math.max(0, tickAfter - tickBefore);
    loop.lastCycleAt = new Date().toISOString();
    loop.lastDurationMs = durationMs;
    loop.totalDurationMs += durationMs;
    loop.lastTickBefore = tickBefore;
    loop.lastTickAfter = tickAfter;

    const autosave = maybeAutosave(loop, world);
    report = {
      ok: true,
      skipped: false,
      cycle: loop.cycles,
      worldId: world.id,
      tickBefore,
      tickAfter,
      ticks: tickAfter - tickBefore,
      durationMs,
      autosave,
      reports,
      metadata: { ...(metadata || {}) },
    };
    notifyCycle(loop, report, world);
  } catch (error) {
    const entry = {
      at: new Date().toISOString(),
      tick: Number(world.tick || 0),
      message: error.message || 'runtime_loop_error',
    };
    loop.errors.push(entry);
    while (loop.errors.length > Number(loop.options.maxErrors || 50)) loop.errors.shift();
    report = {
      ok: false,
      skipped: false,
      error: entry,
      metadata: { ...(metadata || {}) },
    };
    notifyCycle(loop, report, world);
    if (loop.options.stopOnError) stopRuntimeLoop(loop, 'error');
  } finally {
    loop.busy = false;
  }

  return report;
}

function getRuntimeLoopSummary(loop) {
  const world = loop.getWorld();
  return {
    status: loop.status,
    worldId: world?.id || null,
    tick: world?.tick ?? null,
    intervalMs: Number(loop.options.intervalMs || 0),
    ticksPerCycle: Number(loop.options.ticksPerCycle || 1),
    autosaveEveryTicks: Number(loop.options.autosaveEveryTicks || 0),
    autosavePath: loop.options.autosavePath || null,
    cycles: loop.cycles,
    ticksRun: loop.ticksRun,
    busy: loop.busy,
    startedAt: loop.startedAt,
    pausedAt: loop.pausedAt,
    stoppedAt: loop.stoppedAt,
    lastCycleAt: loop.lastCycleAt,
    nextCycleAt: loop.nextCycleAt,
    lastDurationMs: loop.lastDurationMs,
    averageDurationMs: loop.cycles ? loop.totalDurationMs / loop.cycles : 0,
    lastTickBefore: loop.lastTickBefore,
    lastTickAfter: loop.lastTickAfter,
    lastAutosaveTick: loop.lastAutosaveTick,
    lastAutosave: loop.lastAutosave,
    stopReason: loop.stopReason,
    errorCount: loop.errors.length,
    lastError: loop.errors.length ? loop.errors[loop.errors.length - 1] : null,
  };
}

function scheduleNextCycle(loop, delayMs) {
  if (loop.status !== RUNTIME_LOOP_STATUS.RUNNING) return;
  clearLoopTimer(loop);
  const delay = Math.max(0, Number(delayMs ?? loop.options.intervalMs));
  loop.nextCycleAt = new Date(Date.now() + delay).toISOString();
  loop.timer = setTimeout(() => {
    loop.timer = null;
    if (loop.status !== RUNTIME_LOOP_STATUS.RUNNING) return;
    stepRuntimeLoop(loop, loop.options.ticksPerCycle, { source: 'timer' });
    if (loop.status === RUNTIME_LOOP_STATUS.RUNNING) scheduleNextCycle(loop, loop.options.intervalMs);
  }, delay);
}

function clearLoopTimer(loop) {
  if (loop?.timer) clearTimeout(loop.timer);
  if (loop) loop.timer = null;
}

function maybeAutosave(loop, world) {
  const every = Number(loop.options.autosaveEveryTicks || 0);
  const file = loop.options.autosavePath;
  if (!every || !file) return null;
  if (Number(world.tick || 0) - Number(loop.lastAutosaveTick || 0) < every) return null;
  const save = saveWorld(world, file, {
    ...(loop.options.persistence || {}),
    reason: 'runtime_loop_autosave',
  });
  loop.lastAutosaveTick = world.tick;
  loop.lastAutosave = save;
  return save;
}

function notifyCycle(loop, report, world) {
  if (typeof loop.onCycle !== 'function') return;
  try {
    const result = loop.onCycle(report, world, loop);
    if (result && typeof result.catch === 'function') {
      result.catch(error => rememberCallbackError(loop, error));
    }
  } catch (error) {
    rememberCallbackError(loop, error);
  }
}

function rememberCallbackError(loop, error) {
  loop.errors.push({
    at: new Date().toISOString(),
    tick: loop.getWorld()?.tick ?? null,
    message: `onCycle: ${error.message || error}`,
  });
  while (loop.errors.length > Number(loop.options.maxErrors || 50)) loop.errors.shift();
}

function mergeOptions(base, patch) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base?.[key] && typeof base[key] === 'object') {
      out[key] = mergeOptions(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

module.exports = {
  RUNTIME_LOOP_STATUS,
  DEFAULT_RUNTIME_LOOP_OPTIONS,
  createRuntimeLoop,
  startRuntimeLoop,
  pauseRuntimeLoop,
  stopRuntimeLoop,
  configureRuntimeLoop,
  stepRuntimeLoop,
  getRuntimeLoopSummary,
};
