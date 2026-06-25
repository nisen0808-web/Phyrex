'use strict';

const {
  SYSTEM_CONTRACT_VERSION,
  normalizeSystemContracts,
  evaluateSystemContracts,
  compactContractReport,
  createSystemContractError,
  normalizeContractOptions,
} = require('./system-contract-engine');
const { cloneCanonical } = require('./state-integrity-engine');

const CONTRACT_RUNTIME_VERSION = 1;

function instrumentSystemContracts(registry, options = {}) {
  if (!registry || !registry.systems || typeof registry.systems !== 'object') {
    throw new Error('instrumentSystemContracts requires a system registry');
  }
  const config = normalizeContractOptions(options);
  for (const system of Object.values(registry.systems)) {
    instrumentSystemContract(system, config);
  }
  Object.defineProperty(registry, 'contractOptions', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: config,
  });
  return registry;
}

function instrumentSystemContract(system, options = {}) {
  if (!system || typeof system.run !== 'function') throw new Error('instrumentSystemContract requires system');
  const contracts = normalizeSystemContracts(system.contracts || {});
  system.contracts = contracts;
  const total = Object.values(contracts).reduce((sum, entries) => sum + entries.length, 0);
  if (!total) return system;

  const config = normalizeContractOptions(options);
  if (system.__contractRuntime) {
    system.__contractRuntime.options = config;
    return system;
  }

  const originalRun = system.run;
  const runtime = {
    version: CONTRACT_RUNTIME_VERSION,
    options: config,
    originalRun,
  };
  Object.defineProperty(system, '__contractRuntime', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: runtime,
  });

  system.run = function runContractInstrumentedSystem(context) {
    const runConfig = contractConfigForRun(runtime.options, context?.options || {});
    const entry = findSystemEntry(context?.report, system.id);
    const runReport = createRunContractReport(system, runConfig);
    attachRunReport(context?.report, entry, runReport);
    const state = ensureSystemContractState(context.world);
    const systemState = ensureContractSystemState(state, system);
    state.runs += 1;
    systemState.runs += 1;
    systemState.lastRunAtTick = Number(context.tick ?? context.world?.tick ?? 0);

    try {
      const before = evaluateSystemContracts(system, 'before', contractPayload(context), runConfig);
      recordContractStage(state, systemState, runReport, before);
      enforceContractReport(system, before, runConfig);

      const result = originalRun(context);
      if (result && typeof result.then === 'function') return result;

      const resultReport = evaluateSystemContracts(system, 'result', contractPayload(context, result), runConfig);
      recordContractStage(state, systemState, runReport, resultReport);
      enforceContractReport(system, resultReport, runConfig);

      const after = evaluateSystemContracts(system, 'after', contractPayload(context, result), runConfig);
      recordContractStage(state, systemState, runReport, after);
      enforceContractReport(system, after, runConfig);

      runReport.passed = runReport.violations === 0;
      runReport.status = runReport.passed ? 'passed' : 'warning';
      systemState.lastStatus = runReport.status;
      systemState.lastReport = compactRunContractReport(runReport);
      state.lastReport = compactRunContractReport(runReport);
      return result;
    } catch (error) {
      runReport.passed = false;
      runReport.status = error?.code === 'system_contract_failed' ? 'failed' : 'system_error';
      if (error?.code === 'system_contract_failed') {
        state.failures += 1;
        systemState.failures += 1;
      }
      systemState.lastStatus = runReport.status;
      systemState.lastError = serializeContractError(error);
      systemState.lastReport = compactRunContractReport(runReport);
      state.lastReport = compactRunContractReport(runReport);
      throw error;
    }
  };
  return system;
}

function ensureSystemContractState(world) {
  if (!world || typeof world !== 'object') throw new Error('ensureSystemContractState requires world');
  if (!world.kernel || typeof world.kernel !== 'object') world.kernel = {};
  if (!world.kernel.contracts || typeof world.kernel.contracts !== 'object') {
    world.kernel.contracts = {
      version: CONTRACT_RUNTIME_VERSION,
      runs: 0,
      checks: 0,
      warnings: 0,
      violations: 0,
      failures: 0,
      lastReport: null,
      systems: {},
    };
  }
  const state = world.kernel.contracts;
  if (state.version !== CONTRACT_RUNTIME_VERSION) {
    throw new Error(`Unsupported system contract runtime version ${state.version}`);
  }
  if (!state.systems || typeof state.systems !== 'object') state.systems = {};
  for (const key of ['runs', 'checks', 'warnings', 'violations', 'failures']) {
    if (!Number.isInteger(state[key]) || state[key] < 0) state[key] = 0;
  }
  return state;
}

function getSystemContractSummary(world) {
  const state = ensureSystemContractState(world);
  return {
    version: state.version,
    runs: state.runs,
    checks: state.checks,
    warnings: state.warnings,
    violations: state.violations,
    failures: state.failures,
    lastReport: state.lastReport ? cloneCanonical(state.lastReport) : null,
    systems: Object.values(state.systems)
      .map(system => cloneCanonical(system))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function createRunContractReport(system, config) {
  return {
    version: SYSTEM_CONTRACT_VERSION,
    runtimeVersion: CONTRACT_RUNTIME_VERSION,
    systemId: system.id,
    policy: config.policy,
    status: 'running',
    passed: true,
    checks: 0,
    warnings: 0,
    violations: 0,
    stages: {
      before: null,
      result: null,
      after: null,
    },
  };
}

function recordContractStage(state, systemState, runReport, stageReport) {
  const compact = compactContractReport(stageReport);
  runReport.stages[stageReport.stage] = compact;
  runReport.checks += stageReport.checked;
  runReport.warnings += stageReport.warnings;
  runReport.violations += stageReport.errors;
  state.checks += stageReport.checked;
  state.warnings += stageReport.warnings;
  state.violations += stageReport.errors;
  systemState.checks += stageReport.checked;
  systemState.warnings += stageReport.warnings;
  systemState.violations += stageReport.errors;
  systemState.lastStage = stageReport.stage;
  systemState.lastIssues = stageReport.issues.slice(0, 20).map(issue => ({ ...issue }));
  updateScheduleContractTotals(runReport, stageReport);
}

function enforceContractReport(system, report, config) {
  if (config.policy === 'error' && report.errors > 0) {
    throw createSystemContractError(system, report.stage, report);
  }
}

function ensureContractSystemState(state, system) {
  if (!state.systems[system.id]) {
    state.systems[system.id] = {
      id: system.id,
      phase: system.phase,
      runs: 0,
      checks: 0,
      warnings: 0,
      violations: 0,
      failures: 0,
      lastRunAtTick: null,
      lastStage: null,
      lastStatus: null,
      lastIssues: [],
      lastError: null,
      lastReport: null,
    };
  }
  const systemState = state.systems[system.id];
  systemState.phase = system.phase;
  return systemState;
}

function attachRunReport(scheduleReport, entry, runReport) {
  if (entry) entry.contracts = runReport;
  if (!scheduleReport) return;
  if (!scheduleReport.contracts) {
    scheduleReport.contracts = {
      systems: 0,
      checks: 0,
      warnings: 0,
      violations: 0,
      failures: 0,
    };
  }
  scheduleReport.contracts.systems += 1;
  Object.defineProperty(runReport, '__scheduleTotals', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: scheduleReport.contracts,
  });
}

function updateScheduleContractTotals(runReport, stageReport) {
  const totals = runReport.__scheduleTotals;
  if (!totals) return;
  totals.checks += stageReport.checked;
  totals.warnings += stageReport.warnings;
  totals.violations += stageReport.errors;
  if (runReport.policy === 'error' && stageReport.errors > 0) totals.failures += 1;
}

function findSystemEntry(report, systemId) {
  if (!Array.isArray(report?.systems)) return null;
  for (let index = report.systems.length - 1; index >= 0; index -= 1) {
    if (report.systems[index].id === systemId) return report.systems[index];
  }
  return null;
}

function contractPayload(context, result = undefined) {
  return {
    world: context.world,
    result,
    context,
    shared: context.shared,
    report: context.report,
  };
}

function contractConfigForRun(base, schedulerOptions) {
  return normalizeContractOptions({
    ...base,
    contractPolicy: schedulerOptions.contractPolicy ?? base.policy,
    contractMaxIssues: schedulerOptions.contractMaxIssues ?? base.maxIssues,
    contractIncludeValues: schedulerOptions.contractIncludeValues ?? base.includeValues,
  });
}

function compactRunContractReport(report) {
  if (!report) return null;
  return {
    version: report.version,
    runtimeVersion: report.runtimeVersion,
    systemId: report.systemId,
    policy: report.policy,
    status: report.status,
    passed: report.passed,
    checks: report.checks,
    warnings: report.warnings,
    violations: report.violations,
    stages: {
      before: compactContractReport(report.stages.before),
      result: compactContractReport(report.stages.result),
      after: compactContractReport(report.stages.after),
    },
  };
}

function serializeContractError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code || null,
    stage: error?.stage || null,
    contractId: error?.contractId || null,
  };
}

module.exports = {
  CONTRACT_RUNTIME_VERSION,
  instrumentSystemContracts,
  instrumentSystemContract,
  ensureSystemContractState,
  getSystemContractSummary,
  compactRunContractReport,
};
