'use strict';

const { createRandomContext, withDeterministicGlobals } = require('./random-engine');
const { nextWorldId } = require('./world-id-engine');
const { hashState, cloneCanonical } = require('./state-integrity-engine');
const {
  CONTRACT_POLICIES,
  normalizeSystemContract,
  validateSystemInput,
  validateSystemOutput,
  validateSystemInvariants,
  createContractViolation,
  summarizeContract,
  normalizeContractPolicy,
} = require('./system-contract-engine');

const SCHEDULER_STATE_VERSION = 1;
const DEFAULT_PHASES = ['bootstrap', 'pre', 'core', 'post', 'finalize'];
const IMPLICIT_GLOBAL_POLICIES = {
  IGNORE: 'ignore',
  TRACK: 'track',
  WARN: 'warn',
  ERROR: 'error',
};
const DEFAULT_SCHEDULER_OPTIONS = {
  failurePolicy: 'halt',
  atomic: false,
  strictDependencies: true,
  recordResults: false,
  contractPolicy: CONTRACT_POLICIES.ERROR,
  implicitGlobalPolicy: IMPLICIT_GLOBAL_POLICIES.TRACK,
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

function attachSystemContract(registry, systemId, contract) {
  validateRegistry(registry);
  const system = registry.systems[systemId];
  if (!system) throw new Error(`Missing system ${systemId}`);
  system.contract = normalizeSystemContract(contract);
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
    contractWarnings: 0,
    implicitRandomCalls: 0,
    implicitNowCalls: 0,
    implicitGlobalWarnings: 0,
  };

  for (const system of plan) {
    const entry = createScheduleEntry(system, config);
    report.systems.push(entry);

    const context = createSystemContext(world, system, report, config, shared);
    if (!isSystemDue(system, context)) {
      entry.status = 'skipped';
      report.skipped += 1;
      recordSystemRun(scheduler, system, entry, tick);
      continue;
    }

    const usage = { randomCalls: 0, nowCalls: 0 };
    let caughtError = null;

    try {
      if (config.contractPolicy !== CONTRACT_POLICIES.OFF) {
        applyContractValidation(
          validateSystemInput(system.contract, context),
          entry,
          report,
          scheduler,
          config,
        );
      }

      const result = withDeterministicGlobals(
        world,
        `system:${system.id}`,
        () => system.run(context),
        createImplicitGlobalOptions(system, config, usage),
      );
      if (result && typeof result.then === 'function') {
        throw new Error(`System ${system.id} returned a Promise; scheduler systems must be synchronous`);
      }

      if (config.contractPolicy !== CONTRACT_POLICIES.OFF) {
        applyContractValidation(
          validateSystemOutput(system.contract, context, result),
          entry,
          report,
          scheduler,
          config,
        );
        applyContractValidation(
          validateSystemInvariants(system.contract, context, result),
          entry,
          report,
          scheduler,
          config,
        );
      }

      entry.status = 'completed';
      entry.resultDigest = hashState(result);
      if (config.recordResults) entry.result = cloneResult(result);
      report.completed += 1;
    } catch (error) {
      caughtError = error;
      entry.status = 'failed';
      entry.error = serializeError(error);
      report.failed += 1;
      scheduler.failures += 1;
      if (config.atomic && snapshot) restoreWorldFromRollback(world, snapshot);
    } finally {
      recordImplicitGlobalUsage(scheduler, system, entry, report, config, usage);
      recordSystemRun(scheduler, system, entry, tick);
    }

    if (caughtError && config.failurePolicy !== 'continue') {
      report.halted = true;
      scheduler.lastReport = compactScheduleReport(report);
      const schedulerError = new Error(`System ${system.id} failed: ${caughtError.message}`);
      schedulerError.code = 'system_schedule_failed';
      schedulerError.systemId = system.id;
      schedulerError.cause = caughtError;
      schedulerError.report = report;
      throw schedulerError;
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
      contractWarnings: 0,
      implicitRandomCalls: 0,
      implicitNowCalls: 0,
      implicitGlobalWarnings: 0,
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
  for (const key of [
    'runs',
    'failures',
    'contractViolations',
    'contractWarnings',
    'implicitRandomCalls',
    'implicitNowCalls',
    'implicitGlobalWarnings',
  ]) {
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
    contractWarnings: state.contractWarnings,
    implicitRandomCalls: state.implicitRandomCalls,
    implicitNowCalls: state.implicitNowCalls,
    implicitGlobalWarnings: state.implicitGlobalWarnings,
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

  for (const system of order) {
    const purity = analyzeSystemFunctionPurity(system.run);
    const globals = [];
    if (purity.mathRandom && !system.determinism.allowMathRandom) globals.push('Math.random');
    if (purity.dateNow && !system.determinism.allowDateNow) globals.push('Date.now');
    if (globals.length) {
      warnings.push({
        type: 'implicit_global_reference',
        system: system.id,
        globals,
      });
    }
  }

  return {
    phases: [...registry.phases],
    order: order.map(system => system.id),
    warnings,
    contracts: auditSystemContracts(registry),
  };
}

function auditSystemContracts(registry) {
  validateRegistry(registry);
  const systems = Object.values(registry.systems).sort((left, right) => left.id.localeCompare(right.id));
  const details = systems.map(system => ({
    id: system.id,
    ...summarizeContract(system.contract),
  }));
  return {
    systems: systems.length,
    contracted: details.filter(item => item.input || item.output || item.invariants > 0).length,
    inputContracts: details.filter(item => item.input).length,
    outputContracts: details.filter(item => item.output).length,
    invariants: details.reduce((sum, item) => sum + item.invariants, 0),
    missing: details.filter(item => !item.input && !item.output && item.invariants === 0).map(item => item.id),
    details,
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

function isSystemDue(system, context) {
  if (system.enabled === false) return false;
  const every = Math.max(1, Number(system.everyTicks || 1));
  const offset = normalizeModulo(Number(system.offsetTicks || 0), every);
  if (normalizeModulo(context.targetTick, every) !== offset) return false;
  if (typeof system.when === 'function' && system.when(context) === false) return false;
  return true;
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
    when: typeof definition.when === 'function' ? definition.when : null,
    contract: normalizeSystemContract(definition.contract),
    determinism: normalizeDeterminism(definition.determinism),
    run: definition.run,
  };
}

function validateRegistry(registry) {
  if (!registry || registry.version !== SCHEDULER_STATE_VERSION || !registry.systems) {
    throw new Error('Invalid system registry');
  }
}

function normalizeSchedulerOptions(options) {
  const config = { ...DEFAULT_SCHEDULER_OPTIONS, ...(options || {}) };
  config.contractPolicy = normalizeContractPolicy(config.contractPolicy);
  config.implicitGlobalPolicy = normalizeImplicitGlobalPolicy(config.implicitGlobalPolicy);
  return config;
}

function normalizeImplicitGlobalPolicy(value) {
  const policy = String(value || IMPLICIT_GLOBAL_POLICIES.TRACK).toLowerCase();
  if (!Object.values(IMPLICIT_GLOBAL_POLICIES).includes(policy)) {
    throw new Error(`Unsupported implicit global policy ${policy}`);
  }
  return policy;
}

function normalizeDeterminism(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    allowMathRandom: Boolean(input.allowMathRandom),
    allowDateNow: Boolean(input.allowDateNow),
    reason: input.reason ? String(input.reason) : null,
  };
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

function createScheduleEntry(system, config) {
  return {
    id: system.id,
    phase: system.phase,
    status: 'pending',
    resultDigest: null,
    result: null,
    error: null,
    contract: {
      policy: config.contractPolicy,
      input: null,
      output: null,
      invariant: null,
      issues: [],
    },
    implicitGlobals: {
      policy: config.implicitGlobalPolicy,
      randomCalls: 0,
      nowCalls: 0,
      warnings: 0,
    },
  };
}

function applyContractValidation(validation, entry, report, scheduler, config) {
  const stage = validation.stage === 'invariant' ? 'invariant' : validation.stage;
  entry.contract[stage] = cloneCanonical(validation);
  if (validation.ok) return;
  entry.contract.issues.push(...validation.issues.map(issue => ({ ...issue })));
  const count = validation.issues.length;
  if (config.contractPolicy === CONTRACT_POLICIES.WARN) {
    report.contractWarnings += count;
    scheduler.contractWarnings += count;
    return;
  }
  report.contractViolations += count;
  scheduler.contractViolations += count;
  throw createContractViolation(entry.id, [validation]);
}

function createImplicitGlobalOptions(system, config, usage) {
  const policy = config.implicitGlobalPolicy;
  return {
    onRandom: () => { usage.randomCalls += 1; },
    onNow: () => { usage.nowCalls += 1; },
    forbidRandom: policy === IMPLICIT_GLOBAL_POLICIES.ERROR && !system.determinism.allowMathRandom,
    forbidNow: policy === IMPLICIT_GLOBAL_POLICIES.ERROR && !system.determinism.allowDateNow,
  };
}

function recordImplicitGlobalUsage(scheduler, system, entry, report, config, usage) {
  entry.implicitGlobals.randomCalls = usage.randomCalls;
  entry.implicitGlobals.nowCalls = usage.nowCalls;
  report.implicitRandomCalls += usage.randomCalls;
  report.implicitNowCalls += usage.nowCalls;
  scheduler.implicitRandomCalls += usage.randomCalls;
  scheduler.implicitNowCalls += usage.nowCalls;

  if (config.implicitGlobalPolicy !== IMPLICIT_GLOBAL_POLICIES.WARN) return;
  let warnings = 0;
  if (usage.randomCalls && !system.determinism.allowMathRandom) warnings += usage.randomCalls;
  if (usage.nowCalls && !system.determinism.allowDateNow) warnings += usage.nowCalls;
  entry.implicitGlobals.warnings = warnings;
  report.implicitGlobalWarnings += warnings;
  scheduler.implicitGlobalWarnings += warnings;
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
      contractWarnings: 0,
      implicitRandomCalls: 0,
      implicitNowCalls: 0,
      implicitGlobalWarnings: 0,
      lastStatus: null,
      lastRunAtTick: null,
      lastResultDigest: null,
      lastError: null,
      lastContractIssues: [],
    };
  }
  const state = scheduler.systems[system.id];
  for (const key of [
    'runs',
    'skips',
    'failures',
    'contractViolations',
    'contractWarnings',
    'implicitRandomCalls',
    'implicitNowCalls',
    'implicitGlobalWarnings',
  ]) {
    if (!Number.isInteger(state[key]) || state[key] < 0) state[key] = 0;
  }
  if (entry.status === 'completed') state.runs += 1;
  if (entry.status === 'skipped') state.skips += 1;
  if (entry.status === 'failed') state.failures += 1;
  state.phase = system.phase;
  state.lastStatus = entry.status;
  state.lastRunAtTick = tick;
  state.lastResultDigest = entry.resultDigest;
  state.lastError = entry.error;
  state.contractViolations += entry.contract.policy === CONTRACT_POLICIES.ERROR
    ? entry.contract.issues.length
    : 0;
  state.contractWarnings += entry.contract.policy === CONTRACT_POLICIES.WARN
    ? entry.contract.issues.length
    : 0;
  state.implicitRandomCalls += entry.implicitGlobals.randomCalls;
  state.implicitNowCalls += entry.implicitGlobals.nowCalls;
  state.implicitGlobalWarnings += entry.implicitGlobals.warnings;
  state.lastContractIssues = entry.contract.issues.map(issue => ({ ...issue }));
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
    contractWarnings: report.contractWarnings,
    implicitRandomCalls: report.implicitRandomCalls,
    implicitNowCalls: report.implicitNowCalls,
    implicitGlobalWarnings: report.implicitGlobalWarnings,
    systems: report.systems.map(entry => ({
      id: entry.id,
      phase: entry.phase,
      status: entry.status,
      resultDigest: entry.resultDigest,
      error: entry.error,
      contractIssues: entry.contract.issues,
      implicitGlobals: entry.implicitGlobals,
    })),
  };
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

function analyzeSystemFunctionPurity(run) {
  const source = typeof run === 'function' ? Function.prototype.toString.call(run) : '';
  return {
    mathRandom: /\bMath\.random\s*\(/.test(source),
    dateNow: /\bDate\.now\s*\(/.test(source),
  };
}

module.exports = {
  SCHEDULER_STATE_VERSION,
  DEFAULT_PHASES,
  IMPLICIT_GLOBAL_POLICIES,
  DEFAULT_SCHEDULER_OPTIONS,
  createSystemRegistry,
  registerSystem,
  unregisterSystem,
  attachSystemContract,
  resolveSystemOrder,
  runSystemSchedule,
  ensureSchedulerState,
  getSchedulerSummary,
  analyzeSystemRegistry,
  auditSystemContracts,
  analyzeSystemFunctionPurity,
  normalizeImplicitGlobalPolicy,
  pathsOverlap,
};
