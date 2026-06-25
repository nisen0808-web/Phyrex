'use strict';

const { ensureEngineState, nextEngineId } = require('./engine-state-engine');
const {
  randomFloat,
  randomInt,
  randomBoolean,
  randomChoice,
  createRandomFunction,
} = require('./deterministic-rng-engine');
const { appendTrace } = require('./engine-trace-engine');

const SCHEDULER_VERSION = 1;
const DEFAULT_PHASES = ['bootstrap', 'before', 'simulation', 'world', 'after', 'finalize'];
const DEFAULT_SCHEDULER_OPTIONS = {
  errorPolicy: 'stop',
  rollbackOnError: false,
  trace: true,
  maxErrors: 100,
  strictDependencies: true,
};

function createSystemRegistry(options = {}) {
  return {
    version: SCHEDULER_VERSION,
    phases: normalizePhases(options.phases || DEFAULT_PHASES),
    systems: new Map(),
    options: { ...DEFAULT_SCHEDULER_OPTIONS, ...(options || {}) },
    revision: 0,
    cachedRevision: -1,
    cachedOrder: null,
  };
}

function registerSystem(registry, input = {}) {
  validateRegistry(registry);
  const system = normalizeSystem(input);
  if (registry.systems.has(system.id)) throw schedulerError('system_exists', `System already registered: ${system.id}`);
  registry.systems.set(system.id, system);
  registry.revision += 1;
  registry.cachedOrder = null;
  return system;
}

function replaceSystem(registry, input = {}) {
  validateRegistry(registry);
  const system = normalizeSystem(input);
  registry.systems.set(system.id, system);
  registry.revision += 1;
  registry.cachedOrder = null;
  return system;
}

function unregisterSystem(registry, systemId) {
  validateRegistry(registry);
  const removed = registry.systems.delete(String(systemId));
  if (removed) {
    registry.revision += 1;
    registry.cachedOrder = null;
  }
  return removed;
}

function setSystemEnabled(registry, systemId, enabled) {
  const system = requireSystem(registry, systemId);
  system.enabled = Boolean(enabled);
  registry.revision += 1;
  registry.cachedOrder = null;
  return system;
}

function getSystem(registry, systemId) {
  validateRegistry(registry);
  return registry.systems.get(String(systemId)) || null;
}

function listSystems(registry) {
  validateRegistry(registry);
  return [...registry.systems.values()].map(system => ({ ...system, run: undefined, when: undefined }));
}

function resolveSystemOrder(registry, options = {}) {
  validateRegistry(registry);
  if (registry.cachedOrder && registry.cachedRevision === registry.revision && options.force !== true) {
    return [...registry.cachedOrder];
  }

  const config = { ...registry.options, ...(options || {}) };
  const systems = [...registry.systems.values()].filter(system => system.enabled !== false);
  const phases = normalizePhases([
    ...registry.phases,
    ...systems.map(system => system.phase),
  ]);
  const phaseIndex = new Map(phases.map((phase, index) => [phase, index]));
  validateCrossPhaseDependencies(systems, phaseIndex, config);

  const ordered = [];
  for (const phase of phases) {
    const phaseSystems = systems.filter(system => system.phase === phase);
    ordered.push(...topologicalSortPhase(phaseSystems, registry.systems, config));
  }

  registry.cachedOrder = ordered;
  registry.cachedRevision = registry.revision;
  return [...ordered];
}

function runSystemSchedule(world, registry, options = {}) {
  validateRegistry(registry);
  const config = { ...registry.options, ...(options || {}) };
  const state = ensureSchedulerState(world, config);
  const ordered = resolveSystemOrder(registry, config);
  const tick = Number(options.tick ?? world.tick ?? 0);
  const correlationId = options.correlationId || nextEngineId(world, 'schedule');
  const report = {
    version: SCHEDULER_VERSION,
    tick,
    correlationId,
    order: ordered.map(system => system.id),
    completed: [],
    skipped: [],
    failed: [],
  };

  if (config.trace) {
    appendTrace(world, {
      type: 'scheduler.started',
      phase: 'scheduler',
      correlationId,
      payload: { tick, order: report.order },
    });
  }

  for (const system of ordered) {
    const systemState = ensureSystemRuntimeState(state, system.id);
    const eligibility = shouldRunSystem(system, world, tick, options);
    if (!eligibility.run) {
      systemState.skips += 1;
      systemState.lastStatus = 'skipped';
      const skipped = { id: system.id, phase: system.phase, reason: eligibility.reason };
      report.skipped.push(skipped);
      if (config.trace) appendTrace(world, {
        type: 'system.skipped',
        phase: system.phase,
        systemId: system.id,
        correlationId,
        payload: skipped,
      });
      continue;
    }

    const snapshot = config.rollbackOnError || system.rollbackOnError
      ? cloneWorld(world)
      : null;
    const startedAt = config.measureTime ? monotonicNow() : null;
    systemState.lastStatus = 'running';
    systemState.lastTick = tick;

    try {
      const context = createSystemContext(world, system, systemState, tick, correlationId, options, config);
      const result = system.run(context);
      if (result && typeof result.then === 'function') {
        throw schedulerError('async_system_in_sync_schedule', `System ${system.id} returned a Promise; use runSystemScheduleAsync`);
      }
      const item = {
        id: system.id,
        phase: system.phase,
        result: cloneSerializable(result),
      };
      if (startedAt !== null) item.durationMs = Math.max(0, monotonicNow() - startedAt);
      report.completed.push(item);
      systemState.runs += 1;
      systemState.lastStatus = 'completed';
      systemState.lastResult = item.result;
      systemState.lastError = null;
      if (config.trace) appendTrace(world, {
        type: 'system.completed',
        phase: system.phase,
        systemId: system.id,
        correlationId,
        payload: item,
      });
    } catch (error) {
      if (snapshot) restoreWorld(world, snapshot);
      const restoredState = ensureSchedulerState(world, config);
      const restoredSystemState = ensureSystemRuntimeState(restoredState, system.id);
      restoredSystemState.failures += 1;
      restoredSystemState.lastStatus = 'failed';
      restoredSystemState.lastError = serializeError(error);
      const failed = {
        id: system.id,
        phase: system.phase,
        error: serializeError(error),
        rolledBack: Boolean(snapshot),
      };
      report.failed.push(failed);
      recordSchedulerError(restoredState, { tick, ...failed }, config.maxErrors);
      if (config.trace) appendTrace(world, {
        type: 'system.failed',
        phase: system.phase,
        systemId: system.id,
        correlationId,
        payload: failed,
        tags: ['error'],
      });

      const policy = system.errorPolicy || config.errorPolicy;
      if (policy === 'disable') {
        system.enabled = false;
        registry.revision += 1;
        registry.cachedOrder = null;
      }
      if (policy === 'stop') {
        const wrapped = schedulerError('system_execution_failed', `System ${system.id} failed: ${error.message}`);
        wrapped.cause = error;
        wrapped.report = report;
        finalizeSchedule(world, state, report, config);
        throw wrapped;
      }
    }
  }

  finalizeSchedule(world, state, report, config);
  return report;
}

async function runSystemScheduleAsync(world, registry, options = {}) {
  validateRegistry(registry);
  const config = { ...registry.options, ...(options || {}) };
  const state = ensureSchedulerState(world, config);
  const ordered = resolveSystemOrder(registry, config);
  const tick = Number(options.tick ?? world.tick ?? 0);
  const correlationId = options.correlationId || nextEngineId(world, 'schedule');
  const report = {
    version: SCHEDULER_VERSION,
    tick,
    correlationId,
    order: ordered.map(system => system.id),
    completed: [],
    skipped: [],
    failed: [],
  };

  for (const system of ordered) {
    const systemState = ensureSystemRuntimeState(state, system.id);
    const eligibility = shouldRunSystem(system, world, tick, options);
    if (!eligibility.run) {
      systemState.skips += 1;
      systemState.lastStatus = 'skipped';
      report.skipped.push({ id: system.id, phase: system.phase, reason: eligibility.reason });
      continue;
    }

    const snapshot = config.rollbackOnError || system.rollbackOnError ? cloneWorld(world) : null;
    try {
      const result = await system.run(createSystemContext(world, system, systemState, tick, correlationId, options, config));
      report.completed.push({ id: system.id, phase: system.phase, result: cloneSerializable(result) });
      systemState.runs += 1;
      systemState.lastTick = tick;
      systemState.lastStatus = 'completed';
      systemState.lastResult = cloneSerializable(result);
      systemState.lastError = null;
    } catch (error) {
      if (snapshot) restoreWorld(world, snapshot);
      const restoredState = ensureSchedulerState(world, config);
      const restoredSystemState = ensureSystemRuntimeState(restoredState, system.id);
      restoredSystemState.failures += 1;
      restoredSystemState.lastStatus = 'failed';
      restoredSystemState.lastError = serializeError(error);
      const failed = { id: system.id, phase: system.phase, error: serializeError(error), rolledBack: Boolean(snapshot) };
      report.failed.push(failed);
      recordSchedulerError(restoredState, { tick, ...failed }, config.maxErrors);
      const policy = system.errorPolicy || config.errorPolicy;
      if (policy === 'disable') setSystemEnabled(registry, system.id, false);
      if (policy === 'stop') {
        const wrapped = schedulerError('system_execution_failed', `System ${system.id} failed: ${error.message}`);
        wrapped.cause = error;
        wrapped.report = report;
        finalizeSchedule(world, restoredState, report, config);
        throw wrapped;
      }
    }
  }

  finalizeSchedule(world, state, report, config);
  return report;
}

function ensureSchedulerState(world, options = {}) {
  const engine = ensureEngineState(world);
  if (!engine.scheduler || typeof engine.scheduler !== 'object') {
    engine.scheduler = {
      version: SCHEDULER_VERSION,
      runs: 0,
      lastTick: null,
      lastOrder: [],
      lastReport: null,
      systems: {},
      errors: [],
    };
  }
  const state = engine.scheduler;
  state.version = Number(state.version || SCHEDULER_VERSION);
  state.runs = Math.max(0, Number(state.runs || 0));
  if (!Array.isArray(state.lastOrder)) state.lastOrder = [];
  if (!state.systems || typeof state.systems !== 'object') state.systems = {};
  if (!Array.isArray(state.errors)) state.errors = [];
  if (state.errors.length > Number(options.maxErrors || DEFAULT_SCHEDULER_OPTIONS.maxErrors)) {
    state.errors = state.errors.slice(-Number(options.maxErrors || DEFAULT_SCHEDULER_OPTIONS.maxErrors));
  }
  return state;
}

function getSchedulerSummary(world) {
  const state = ensureSchedulerState(world);
  return cloneSerializable(state);
}

function createSystemContext(world, system, systemState, tick, correlationId, runOptions, schedulerOptions) {
  const streamId = system.randomStream || `system.${system.id}`;
  return {
    world,
    tick,
    phase: system.phase,
    systemId: system.id,
    correlationId,
    options: {
      ...(runOptions.systemOptions?.[system.id] || {}),
      ...(system.options || {}),
    },
    schedulerOptions,
    state: systemState.data,
    random: createRandomFunction(world, streamId),
    randomFloat: () => randomFloat(world, streamId),
    randomInt: (min, max) => randomInt(world, min, max, streamId),
    chance: probability => randomBoolean(world, probability, streamId),
    choice: values => randomChoice(world, values, streamId),
    nextId: namespace => nextEngineId(world, namespace || system.id),
    trace: input => appendTrace(world, {
      ...input,
      systemId: input?.systemId || system.id,
      phase: input?.phase || system.phase,
      correlationId: input?.correlationId || correlationId,
    }),
  };
}

function shouldRunSystem(system, world, tick, runOptions) {
  if (system.enabled === false) return { run: false, reason: 'disabled' };
  const every = Math.max(1, Number(system.every || 1));
  const offset = Number(system.offset || 0);
  if (every > 1 && modulo(tick - offset, every) !== 0) return { run: false, reason: 'frequency' };
  if (typeof system.when === 'function' && !system.when({ world, tick, options: runOptions })) {
    return { run: false, reason: 'condition' };
  }
  return { run: true, reason: null };
}

function normalizeSystem(input) {
  if (!input || typeof input !== 'object') throw schedulerError('system_invalid', 'System definition must be an object');
  const id = String(input.id || '').trim();
  if (!id) throw schedulerError('system_id_missing', 'System requires id');
  if (typeof input.run !== 'function') throw schedulerError('system_run_missing', `System ${id} requires run function`);
  return {
    id,
    phase: String(input.phase || 'simulation'),
    order: Number(input.order || 0),
    priority: Number(input.priority || 0),
    after: normalizeDependencyList(input.after),
    before: normalizeDependencyList(input.before),
    optionalAfter: normalizeDependencyList(input.optionalAfter),
    optionalBefore: normalizeDependencyList(input.optionalBefore),
    every: Math.max(1, Number(input.every || 1)),
    offset: Number(input.offset || 0),
    enabled: input.enabled !== false,
    errorPolicy: input.errorPolicy || null,
    rollbackOnError: Boolean(input.rollbackOnError),
    randomStream: input.randomStream || null,
    options: cloneSerializable(input.options || {}),
    when: input.when || null,
    run: input.run,
  };
}

function topologicalSortPhase(systems, allSystems, options) {
  const byId = new Map(systems.map(system => [system.id, system]));
  const outgoing = new Map(systems.map(system => [system.id, new Set()]));
  const incoming = new Map(systems.map(system => [system.id, 0]));

  for (const system of systems) {
    addAfterEdges(system, system.after, byId, allSystems, outgoing, incoming, options, false);
    addAfterEdges(system, system.optionalAfter, byId, allSystems, outgoing, incoming, options, true);
    addBeforeEdges(system, system.before, byId, allSystems, outgoing, incoming, options, false);
    addBeforeEdges(system, system.optionalBefore, byId, allSystems, outgoing, incoming, options, true);
  }

  const ready = systems.filter(system => incoming.get(system.id) === 0).sort(compareSystems);
  const output = [];
  while (ready.length) {
    const system = ready.shift();
    output.push(system);
    for (const targetId of [...outgoing.get(system.id)].sort()) {
      incoming.set(targetId, incoming.get(targetId) - 1);
      if (incoming.get(targetId) === 0) {
        ready.push(byId.get(targetId));
        ready.sort(compareSystems);
      }
    }
  }

  if (output.length !== systems.length) {
    const unresolved = systems.filter(system => !output.includes(system)).map(system => system.id).sort();
    throw schedulerError('system_dependency_cycle', `System dependency cycle in phase ${systems[0]?.phase || 'unknown'}: ${unresolved.join(', ')}`);
  }
  return output;
}

function addAfterEdges(system, dependencies, byId, allSystems, outgoing, incoming, options, optional) {
  for (const dependencyId of dependencies) {
    if (!allSystems.has(dependencyId)) {
      if (!optional && options.strictDependencies) throw schedulerError('system_dependency_missing', `System ${system.id} requires missing system ${dependencyId}`);
      continue;
    }
    if (!byId.has(dependencyId)) continue;
    addEdge(dependencyId, system.id, outgoing, incoming);
  }
}

function addBeforeEdges(system, targets, byId, allSystems, outgoing, incoming, options, optional) {
  for (const targetId of targets) {
    if (!allSystems.has(targetId)) {
      if (!optional && options.strictDependencies) throw schedulerError('system_dependency_missing', `System ${system.id} references missing system ${targetId}`);
      continue;
    }
    if (!byId.has(targetId)) continue;
    addEdge(system.id, targetId, outgoing, incoming);
  }
}

function addEdge(fromId, toId, outgoing, incoming) {
  if (fromId === toId) throw schedulerError('system_self_dependency', `System ${fromId} cannot depend on itself`);
  if (outgoing.get(fromId).has(toId)) return;
  outgoing.get(fromId).add(toId);
  incoming.set(toId, incoming.get(toId) + 1);
}

function validateCrossPhaseDependencies(systems, phaseIndex, options) {
  const byId = new Map(systems.map(system => [system.id, system]));
  for (const system of systems) {
    for (const dependencyId of system.after) {
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        if (options.strictDependencies) throw schedulerError('system_dependency_missing', `System ${system.id} requires missing system ${dependencyId}`);
        continue;
      }
      if (phaseIndex.get(dependency.phase) > phaseIndex.get(system.phase)) {
        throw schedulerError('system_phase_dependency_invalid', `System ${system.id} cannot run after later-phase system ${dependencyId}`);
      }
    }
    for (const targetId of system.before) {
      const target = byId.get(targetId);
      if (!target) {
        if (options.strictDependencies) throw schedulerError('system_dependency_missing', `System ${system.id} references missing system ${targetId}`);
        continue;
      }
      if (phaseIndex.get(system.phase) > phaseIndex.get(target.phase)) {
        throw schedulerError('system_phase_dependency_invalid', `System ${system.id} cannot run before earlier-phase system ${targetId}`);
      }
    }
  }
}

function finalizeSchedule(world, state, report, options) {
  const activeState = ensureSchedulerState(world, options);
  activeState.runs = Number(activeState.runs || 0) + 1;
  activeState.lastTick = report.tick;
  activeState.lastOrder = [...report.order];
  activeState.lastReport = {
    tick: report.tick,
    correlationId: report.correlationId,
    completed: report.completed.map(item => item.id),
    skipped: report.skipped.map(item => item.id),
    failed: report.failed.map(item => item.id),
  };
  if (options.trace) appendTrace(world, {
    type: 'scheduler.completed',
    phase: 'scheduler',
    correlationId: report.correlationId,
    payload: activeState.lastReport,
    tags: report.failed.length ? ['error'] : [],
  });
  return activeState;
}

function ensureSystemRuntimeState(state, systemId) {
  if (!state.systems[systemId]) {
    state.systems[systemId] = {
      runs: 0,
      skips: 0,
      failures: 0,
      lastTick: null,
      lastStatus: null,
      lastResult: null,
      lastError: null,
      data: {},
    };
  }
  if (!state.systems[systemId].data) state.systems[systemId].data = {};
  return state.systems[systemId];
}

function recordSchedulerError(state, error, maxErrors) {
  state.errors.push(cloneSerializable(error));
  const limit = Math.max(1, Number(maxErrors || DEFAULT_SCHEDULER_OPTIONS.maxErrors));
  if (state.errors.length > limit) state.errors.splice(0, state.errors.length - limit);
}

function normalizePhases(phases) {
  const output = [];
  for (const phase of phases || []) {
    const value = String(phase || '').trim();
    if (value && !output.includes(value)) output.push(value);
  }
  return output.length ? output : [...DEFAULT_PHASES];
}

function normalizeDependencyList(value) {
  if (value === undefined || value === null) return [];
  return [...new Set((Array.isArray(value) ? value : [value]).map(item => String(item).trim()).filter(Boolean))];
}

function compareSystems(left, right) {
  if (left.order !== right.order) return left.order - right.order;
  if (left.priority !== right.priority) return right.priority - left.priority;
  return left.id.localeCompare(right.id);
}

function requireSystem(registry, systemId) {
  validateRegistry(registry);
  const system = registry.systems.get(String(systemId));
  if (!system) throw schedulerError('system_missing', `Missing system ${systemId}`);
  return system;
}

function validateRegistry(registry) {
  if (!registry || !(registry.systems instanceof Map)) throw schedulerError('registry_invalid', 'Invalid system registry');
}

function cloneWorld(world) {
  return JSON.parse(JSON.stringify(world));
}

function restoreWorld(world, snapshot) {
  for (const key of Object.keys(world)) delete world[key];
  Object.assign(world, JSON.parse(JSON.stringify(snapshot)));
  return world;
}

function cloneSerializable(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); }
  catch (_error) { return String(value); }
}

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    code: error?.code || null,
    message: error?.message || String(error),
  };
}

function schedulerError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function modulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function monotonicNow() {
  if (typeof process !== 'undefined' && process.hrtime?.bigint) return Number(process.hrtime.bigint() / 1000000n);
  return Date.now();
}

module.exports = {
  SCHEDULER_VERSION,
  DEFAULT_PHASES,
  DEFAULT_SCHEDULER_OPTIONS,
  createSystemRegistry,
  registerSystem,
  replaceSystem,
  unregisterSystem,
  setSystemEnabled,
  getSystem,
  listSystems,
  resolveSystemOrder,
  runSystemSchedule,
  runSystemScheduleAsync,
  ensureSchedulerState,
  getSchedulerSummary,
  shouldRunSystem,
};
