'use strict';

const { createRandomContext } = require('./random-engine');
const {
  createDeterminismAuditRecord,
  runWithDeterminismAudit,
  normalizeDeterminismPolicy,
  compactDeterminismAudit,
} = require('./determinism-audit-engine');
const {
  CONTRACT_POLICIES,
  normalizeContractPolicy,
  normalizeSystemContract,
  validateSystemContract,
  createSystemContractError,
} = require('./system-contract-engine');
const { nextWorldId } = require('./world-id-engine');
const { hashState, cloneCanonical } = require('./state-integrity-engine');

const SCHEDULER_STATE_VERSION = 1;
const DEFAULT_PHASES = ['bootstrap', 'pre', 'core', 'post', 'finalize'];
const DEFAULT_SCHEDULER_OPTIONS = {
  failurePolicy: 'halt',
  atomic: false,
  strictDependencies: true,
  recordResults: false,
  contractPolicy: CONTRACT_POLICIES.STRICT,
  determinismPolicy: 'audit',
};

function createSystemRegistry(options = {}) {
  const phases = normalizePhases(options.phases || DEFAULT_PHASES);
  return {
    version: SCHEDULER_STATE_VERSION,
    phases,
    systems: {},
  };
}

function registerSystem(registry, definition) {
  validateRegistry(registry);
  const system = normalizeSystemDefinition(definition, registry.phases);
  if (registry.systems[system.id]) throw new Error(`System ${system.id} is already registered`);
  registry.systems[system.id] = system;
  return system;
}

function unregisterSystem(registry, systemId) {
  validateRegistry(registry);
  const system = registry.systems[systemId] || null;
  if (system) delete registry.systems[systemId];
  return system;
}

function resolveSystemOrder(registry, options = {}) {
  validateRegistry(registry);
  const strict = options.strictDependencies ?? true;
  const systems = Object.values(registry.systems).filter(system => system.enabled !== false);
  const byId = Object.fromEntries(systems.map(system => [system.id, system]));
  const phaseRank = Object.fromEntries(registry.phases.map((phase, index) => [phase, index]));
  const ordered = [];

  for (const phase of registry.phases) {
    const phaseSystems = systems.filter(system => system.phase === phase);
    const graph = new Map(phaseSystems.map(system => [system.id, new Set()]));
    const indegree = new Map(phaseSystems.map(system => [system.id, 0]));

    for (const system of phaseSystems) {
      for (const dependencyId of system.after) {
        const dependency = byId[dependencyId];
        if (!dependency) {
          if (strict) throw new Error(`System ${system.id} depends on missing system ${dependencyId}`);
          continue;
        }
        if (phaseRank[dependency.phase] > phaseRank[system.phase]) {
          throw new Error(`System ${system.id} cannot run after later phase system ${dependencyId}`);
        }
        if (dependency.phase === system.phase) addGraphEdge(graph, indegree, dependency.id, system.id);
      }

      for (const targetId of system.before) {
        const target = byId[targetId];
        if (!target) {
          if (strict) throw new Error(`System ${system.id} references missing system ${targetId}`);
          continue;
        }
        if (phaseRank[target.phase] < phaseRank[system.phase]) {
          throw new Error(`System ${system.id} cannot run before earlier phase system ${targetId}`);
        }
        if (target.phase === system.phase) addGraphEdge(graph, indegree, system.id, target.id);
      }
    }

    const ready = phaseSystems.filter(system => indegree.get(system.id) === 0);
    ready.sort(compareSystems);
    let processed = 0;

    while (ready.length) {
      const system = ready.shift();
      ordered.push(system);
      processed += 1;
      for (const targetId of graph.get(system.id) || []) {
        indegree.set(targetId, indegree.get(targetId) - 1);
        if (indegree.get(targetId) === 0) {
          ready.push(byId[targetId]);
          ready.sort(compareSystems);
        }
      }
    }

    if (processed !== phaseSystems.length) {
      const cyclic = phaseSystems
        .filter(system => indegree.get(system.id) > 0)
        .map(system => system.id)
        .sort();
      throw new Error(`System dependency cycle detected: ${cyclic.join(', ')}`);
    }
  }

  return ordered;
}

function runSystemSchedule(world, registry, options = {}) {
  if (!world || typeof world !== 'object') throw new Error('runSystemSchedule requires world');
  const config = normalizeSchedulerOptions(options);
  if (config.atomic && config.failurePolicy === 'continue') {
    throw new Error('Atomic schedule cannot continue after failure');
  }
  const scheduler = ensureSchedulerState(world);
  const plan = resolveSystemOrder(registry, config);
  const tick = Number(options.tick ?? world.tick ?? 0);
  const shared = options.shared || {};
  const snapshot = config.atomic ? cloneWorldForRollback(world) : null;
  const report = {
    id: nextWorldId(world, 'schedule', 'scheduler.run'),
    tick,
    targetTick: Number(options.targetTick ?? tick + 1),
    systems: [],
    completed: 0,
    skipped: 0,
    failed: 0,
    halted: false,
    contractViolations: 0,
    determinismWarnings: 0,
    implicitRandomCalls: 0,
    implicitClockCalls: 0,
  };

  for (const system of plan) {
    const contractPolicy = normalizeContractPolicy(system.contractPolicy || config.contractPolicy);
    const determinismPolicy = normalizeDeterminismPolicy(system.determinismPolicy || config.determinismPolicy);
    const audit = createDeterminismAuditRecord(`system:${system.id}`, determinismPolicy);
    const entry = {
      id: system.id,
      phase: system.phase,
      status: 'pending',
      resultDigest: null,
      result: null,
      error: null,
      contract: createContractEntry(system.contract, contractPolicy),
      determinism: compactDeterminismAudit(audit),
    };
    report.systems.push(entry);

    const context = createSystemContext(world, system, report, config, shared);
    if (!isSystemScheduledForTick(system, context)) {
      entry.status = 'skipped';
      if (entry.contract.status === 'pending') entry.contract.status = 'skipped';
      report.skipped += 1;
      recordSystemRun(scheduler, system, entry, tick);
      continue;
    }

    try {
      let execution;
      try {
        execution = runWithDeterminismAudit(
          world,
          `system:${system.id}`,
          () => {
            if (typeof system.when === 'function') {
              const decision = system.when(context);
              if (decision && typeof decision.then === 'function') {
                throw new Error(`System ${system.id} when predicate returned a Promise; predicates must be synchronous`);
              }
              if (decision === false) return { skipped: true, result: undefined };
            }

            validateContractStage(system, 'input', context, undefined, contractPolicy, entry, report);
            const result = system.run(context);
            if (result && typeof result.then === 'function') {
              throw new Error(`System ${system.id} returned a Promise; scheduler systems must be synchronous`);
            }
            validateContractStage(system, 'output', context, result, contractPolicy, entry, report);
            validateContractStage(system, 'post', context, result, contractPolicy, entry, report);
            return { skipped: false, result };
          },
          { policy: determinismPolicy, audit },
        );
      } finally {
        entry.determinism = compactDeterminismAudit(audit);
        applyDeterminismReport(entry, report);
      }

      if (execution.skipped) {
        entry.status = 'skipped';
        if (entry.contract.status === 'pending') entry.contract.status = 'skipped';
        report.skipped += 1;
        recordSystemRun(scheduler, system, entry, tick);
        continue;
      }

      const result = execution.result;
      finalizeContractEntry(entry.contract);
      entry.status = 'completed';
      entry.resultDigest = hashState(result);
      if (config.recordResults) entry.result = cloneResult(result);
      report.completed += 1;
      recordSystemRun(scheduler, system, entry, tick);
    } catch (error) {
      if (!entry.determinism || entry.determinism.policy !== audit.policy) {
        entry.determinism = compactDeterminismAudit(audit);
        applyDeterminismReport(entry, report);
      }
      if (error?.code === 'system_contract_violation') entry.contract.status = 'failed';
      entry.status = 'failed';
      entry.error = serializeError(error);
      report.failed += 1;
      scheduler.failures += 1;
      recordSystemRun(scheduler, system, entry, tick);

      if (config.atomic && snapshot) restoreWorldFromRollback(world, snapshot);
      if (config.failurePolicy !== 'continue') {
        report.halted = true;
        scheduler.lastReport = compactScheduleReport(report);
        const schedulerError = new Error(`System ${system.id} failed: ${error.message}`);
        schedulerError.code = 'system_schedule_failed';
        schedulerError.systemId = system.id;
        schedulerError.cause = error;
        schedulerError.report = report;
        throw schedulerError;
      }
    }
  }

  scheduler.runs += 1;
  scheduler.lastRunAtTick = Number(world.tick || tick);
  scheduler.lastReport = compactScheduleReport(report);
  scheduler.history.push(scheduler.lastReport);
  if (scheduler.history.length > 100) scheduler.history.shift();
  return report;
}

function ensureSchedulerState(world) {
  if (!world.kernel || typeof world.kernel !== 'object') {
    world.kernel = {
      version: SCHEDULER_STATE_VERSION,
      runs: 0,
      failures: 0,
      contractViolations: 0,
      determinismWarnings: 0,
      implicitRandomCalls: 0,
      implicitClockCalls: 0,
      lastRunAtTick: null,
      systems: {},
      lastReport: null,
      history: [],
    };
  }
  const state = world.kernel;
  if (state.version !== SCHEDULER_STATE_VERSION) {
    throw new Error(`Unsupported scheduler state version ${state.version}`);
  }
  if (!state.systems || typeof state.systems !== 'object') state.systems = {};
  if (!Array.isArray(state.history)) state.history = [];
  if (!Number.isInteger(state.runs) || state.runs < 0) state.runs = 0;
  if (!Number.isInteger(state.failures) || state.failures < 0) state.failures = 0;
  for (const key of ['contractViolations', 'determinismWarnings', 'implicitRandomCalls', 'implicitClockCalls']) {
    if (!Number.isInteger(state[key]) || state[key] < 0) state[key] = 0;
  }
  return state;
}

function getSchedulerSummary(world) {
  const state = ensureSchedulerState(world);
  return {
    version: state.version,
    runs: state.runs,
    failures: state.failures,
    contractViolations: state.contractViolations,
    determinismWarnings: state.determinismWarnings,
    implicitRandomCalls: state.implicitRandomCalls,
    implicitClockCalls: state.implicitClockCalls,
    lastRunAtTick: state.lastRunAtTick,
    lastReport: state.lastReport ? cloneCanonical(state.lastReport) : null,
    systems: Object.values(state.systems)
      .map(system => ({ ...system }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function analyzeSystemRegistry(registry) {
  const order = resolveSystemOrder(registry);
  const warnings = [];
  for (let leftIndex = 0; leftIndex < order.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < order.length; rightIndex += 1) {
      const left = order[leftIndex];
      const right = order[rightIndex];
      if (left.phase !== right.phase) continue;
      const conflicts = findWriteConflicts(left.writes, right.writes);
      if (!conflicts.length) continue;
      const explicitlyOrdered = left.before.includes(right.id)
        || right.after.includes(left.id)
        || right.before.includes(left.id)
        || left.after.includes(right.id);
      if (!explicitlyOrdered) {
        warnings.push({
          type: 'unordered_write_conflict',
          systems: [left.id, right.id],
          paths: conflicts,
        });
      }
    }
  }
  return {
    phases: [...registry.phases],
    order: order.map(system => system.id),
    warnings,
    contracts: order.map(system => ({
      id: system.id,
      declared: Boolean(system.contract),
      policy: system.contractPolicy,
    })),
    determinism: order.map(system => ({
      id: system.id,
      policy: system.determinismPolicy,
    })),
  };
}

function createSystemContext(world, system, report, options, shared) {
  return {
    world,
    system,
    report,
    shared,
    options,
    tick: Number(options.tick ?? world.tick ?? 0),
    targetTick: Number(options.targetTick ?? Number(world.tick || 0) + 1),
    random: createRandomContext(world, `system:${system.id}`),
    nextId: (prefix, key) => nextWorldId(world, prefix, key || `${system.id}.${prefix}`),
    hash: value => hashState(value),
  };
}

function isSystemScheduledForTick(system, context) {
  if (system.enabled === false) return false;
  const every = Math.max(1, Number(system.everyTicks || 1));
  const offset = normalizeModulo(Number(system.offsetTicks || 0), every);
  return normalizeModulo(context.targetTick, every) === offset;
}

function normalizeSystemDefinition(definition, phases) {
  if (!definition || typeof definition !== 'object') throw new Error('System definition is required');
  const id = String(definition.id || '').trim();
  if (!id) throw new Error('System requires id');
  if (typeof definition.run !== 'function') throw new Error(`System ${id} requires run function`);
  const phase = String(definition.phase || 'core');
  if (!phases.includes(phase)) throw new Error(`System ${id} uses unknown phase ${phase}`);
  return {
    id,
    phase,
    priority: Number(definition.priority || 0),
    enabled: definition.enabled !== false,
    everyTicks: Math.max(1, Math.floor(Number(definition.everyTicks || 1))),
    offsetTicks: Math.floor(Number(definition.offsetTicks || 0)),
    after: normalizeStringList(definition.after),
    before: normalizeStringList(definition.before),
    reads: normalizeStringList(definition.reads),
    writes: normalizeStringList(definition.writes),
    tags: normalizeStringList(definition.tags),
    contract: normalizeSystemContract(definition.contract),
    contractPolicy: definition.contractPolicy
      ? normalizeContractPolicy(definition.contractPolicy)
      : null,
    determinismPolicy: definition.determinismPolicy
      ? normalizeDeterminismPolicy(definition.determinismPolicy)
      : null,
    when: typeof definition.when === 'function' ? definition.when : null,
    run: definition.run,
  };
}

function validateRegistry(registry) {
  if (!registry || registry.version !== SCHEDULER_STATE_VERSION || !registry.systems) {
    throw new Error('Invalid system registry');
  }
}

function normalizePhases(phases) {
  const output = normalizeStringList(phases);
  if (!output.length) throw new Error('System registry requires at least one phase');
  return output;
}

function normalizeStringList(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map(item => String(item || '').trim()).filter(Boolean))];
}

function normalizeSchedulerOptions(options) {
  const config = { ...DEFAULT_SCHEDULER_OPTIONS, ...(options || {}) };
  config.contractPolicy = normalizeContractPolicy(config.contractPolicy);
  config.determinismPolicy = normalizeDeterminismPolicy(config.determinismPolicy);
  return config;
}

function addGraphEdge(graph, indegree, sourceId, targetId) {
  const targets = graph.get(sourceId);
  if (!targets || targets.has(targetId)) return;
  targets.add(targetId);
  indegree.set(targetId, indegree.get(targetId) + 1);
}

function compareSystems(left, right) {
  if (right.priority !== left.priority) return right.priority - left.priority;
  return left.id.localeCompare(right.id);
}

function normalizeModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function createContractEntry(contract, policy) {
  return {
    policy,
    status: !contract ? 'undeclared' : policy === CONTRACT_POLICIES.OFF ? 'disabled' : 'pending',
    violations: [],
    stages: {},
  };
}

function validateContractStage(system, stage, context, result, policy, entry, report) {
  if (!system.contract || policy === CONTRACT_POLICIES.OFF) return;
  const validation = validateSystemContract(system.contract, stage, context, result);
  entry.contract.stages[stage] = {
    ok: validation.ok,
    violations: validation.violations.map(violation => ({ ...violation })),
  };
  if (validation.ok) return;
  entry.contract.violations.push(...validation.violations.map(violation => ({ ...violation })));
  report.contractViolations += validation.violations.length;
  entry.contract.status = policy === CONTRACT_POLICIES.WARN ? 'warned' : 'failed';
  if (policy === CONTRACT_POLICIES.STRICT) {
    throw createSystemContractError(system.id, stage, validation.violations);
  }
}

function finalizeContractEntry(contract) {
  if (!contract || !['pending', 'warned'].includes(contract.status)) return;
  if (contract.status === 'pending') contract.status = 'passed';
}

function applyDeterminismReport(entry, report) {
  if (!entry.determinism || entry.determinism.applied === true) return;
  const warnings = entry.determinism.warnings || [];
  report.determinismWarnings += warnings.length;
  report.implicitRandomCalls += Number(entry.determinism.implicitRandomCalls || 0);
  report.implicitClockCalls += Number(entry.determinism.implicitClockCalls || 0);
  entry.determinism.applied = true;
}

function recordSystemRun(scheduler, system, entry, tick) {
  if (!scheduler.systems[system.id]) {
    scheduler.systems[system.id] = {
      id: system.id,
      phase: system.phase,
      runs: 0,
      skips: 0,
      failures: 0,
      contractViolations: 0,
      determinismWarnings: 0,
      implicitRandomCalls: 0,
      implicitClockCalls: 0,
      lastStatus: null,
      lastRunAtTick: null,
      lastResultDigest: null,
      lastError: null,
      lastContractStatus: null,
      lastDeterminism: null,
    };
  }
  const state = scheduler.systems[system.id];
  if (entry.status === 'completed') state.runs += 1;
  if (entry.status === 'skipped') state.skips += 1;
  if (entry.status === 'failed') state.failures += 1;
  const contractViolations = Number(entry.contract?.violations?.length || 0);
  const determinismWarnings = Number(entry.determinism?.warnings?.length || 0);
  const implicitRandomCalls = Number(entry.determinism?.implicitRandomCalls || 0);
  const implicitClockCalls = Number(entry.determinism?.implicitClockCalls || 0);
  state.contractViolations += contractViolations;
  state.determinismWarnings += determinismWarnings;
  state.implicitRandomCalls += implicitRandomCalls;
  state.implicitClockCalls += implicitClockCalls;
  scheduler.contractViolations += contractViolations;
  scheduler.determinismWarnings += determinismWarnings;
  scheduler.implicitRandomCalls += implicitRandomCalls;
  scheduler.implicitClockCalls += implicitClockCalls;
  state.phase = system.phase;
  state.lastStatus = entry.status;
  state.lastRunAtTick = tick;
  state.lastResultDigest = entry.resultDigest;
  state.lastError = entry.error;
  state.lastContractStatus = entry.contract?.status || null;
  state.lastDeterminism = entry.determinism ? compactDeterminismEntry(entry.determinism) : null;
}

function compactScheduleReport(report) {
  return {
    id: report.id,
    tick: report.tick,
    targetTick: report.targetTick,
    completed: report.completed,
    skipped: report.skipped,
    failed: report.failed,
    halted: report.halted,
    contractViolations: report.contractViolations,
    determinismWarnings: report.determinismWarnings,
    implicitRandomCalls: report.implicitRandomCalls,
    implicitClockCalls: report.implicitClockCalls,
    systems: report.systems.map(entry => ({
      id: entry.id,
      phase: entry.phase,
      status: entry.status,
      resultDigest: entry.resultDigest,
      error: entry.error,
      contract: compactContractEntry(entry.contract),
      determinism: compactDeterminismEntry(entry.determinism),
    })),
  };
}

function compactContractEntry(contract) {
  if (!contract) return null;
  return {
    policy: contract.policy,
    status: contract.status,
    violations: (contract.violations || []).map(violation => ({ ...violation })),
  };
}

function compactDeterminismEntry(determinism) {
  if (!determinism) return null;
  const compact = { ...determinism };
  delete compact.applied;
  return compact;
}

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code || null,
  };
}

function cloneResult(result) {
  if (result === undefined) return null;
  try { return cloneCanonical(result); }
  catch (_error) { return { unrecordable: true, digest: hashState(String(result)) }; }
}

function cloneWorldForRollback(world) {
  return JSON.parse(JSON.stringify(world));
}

function restoreWorldFromRollback(world, snapshot) {
  for (const key of Object.keys(world)) delete world[key];
  for (const [key, value] of Object.entries(snapshot)) world[key] = value;
}

function findWriteConflicts(leftPaths, rightPaths) {
  const conflicts = [];
  for (const left of leftPaths || []) {
    for (const right of rightPaths || []) {
      if (pathsOverlap(left, right)) conflicts.push([left, right]);
    }
  }
  return conflicts;
}

function pathsOverlap(left, right) {
  if (left === '*' || right === '*') return true;
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

module.exports = {
  SCHEDULER_STATE_VERSION,
  DEFAULT_PHASES,
  DEFAULT_SCHEDULER_OPTIONS,
  createSystemRegistry,
  registerSystem,
  unregisterSystem,
  resolveSystemOrder,
  runSystemSchedule,
  ensureSchedulerState,
  getSchedulerSummary,
  analyzeSystemRegistry,
  createSystemContext,
  normalizeSystemDefinition,
  normalizeSchedulerOptions,
  pathsOverlap,
};
