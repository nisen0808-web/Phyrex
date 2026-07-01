'use strict';

const PERFORMANCE_BUDGET_VERSION = 1;

const DEFAULT_PERFORMANCE_BUDGET_OPTIONS = {
  maxTotalLoad: 18000,
  maxSystemLoad: 2600,
  maxSamples: 160,
  warningRatio: 0.8,
  sectionLoadScale: 1,
};

const DEFAULT_SYSTEM_BUDGETS = {
  'population.lifecycle': 2600,
  'population.families': 1400,
  'population.legacy': 1400,
  'social.contracts': 1600,
  'social.organizations': 1800,
  'economy.production': 2800,
  'economy.cities': 2200,
  'agency.identity': 1600,
  'agency.desire': 1800,
  'agency.opportunity': 2400,
  'agency.planning': 2400,
  'advance.world': 1200,
  'knowledge.information': 1800,
  'knowledge.memory': 2000,
  'civilization.culture': 1800,
  'civilization.religion': 1800,
  'civilization.core': 2200,
  'civilization.technology': 2200,
  'civilization.infrastructure': 2200,
  'civilization.governance': 2600,
  'civilization.processes': 2600,
  'civilization.emergence': 2200,
  'civilization.conflict': 2600,
  'finalize.players': 1400,
  'finalize.history': 1600,
  'finalize.narrative': 2200,
  'finalize.novel': 2200,
  'natural.world': 2600,
  'ecology.world': 2600,
  'world.consistency': 3000,
};

const SYSTEM_SECTION_PATHS = {
  'population.lifecycle': ['population'],
  'population.families': ['families'],
  'population.legacy': ['legacy'],
  'social.contracts': ['contracts'],
  'social.organizations': ['organizations'],
  'economy.production': ['economy'],
  'economy.cities': ['city'],
  'agency.identity': ['identities'],
  'agency.desire': ['desires'],
  'agency.opportunity': ['opportunities'],
  'agency.planning': ['plannedActions'],
  'knowledge.information': ['information'],
  'knowledge.memory': ['memory'],
  'civilization.culture': ['culture'],
  'civilization.religion': ['religion'],
  'civilization.core': ['civilization'],
  'civilization.technology': ['technology'],
  'civilization.infrastructure': ['infrastructure'],
  'civilization.governance': ['governance'],
  'civilization.processes': ['processes'],
  'civilization.emergence': ['emergence'],
  'civilization.conflict': ['conflicts'],
  'finalize.players': ['players'],
  'finalize.history': ['history'],
  'finalize.narrative': ['narrative'],
  'finalize.novel': ['novel'],
  'natural.world': ['natural'],
  'ecology.world': ['ecology'],
  'world.consistency': ['consistency'],
};

function ensurePerformanceBudgetState(world) {
  if (!world.kernel || typeof world.kernel !== 'object') world.kernel = {};
  if (!world.kernel.performance || typeof world.kernel.performance !== 'object') {
    world.kernel.performance = {
      version: PERFORMANCE_BUDGET_VERSION,
      samples: [],
      last: null,
      stats: { samples: 0, warnings: 0, violations: 0, maxTotalLoad: 0 },
    };
  }
  const state = world.kernel.performance;
  if (!Array.isArray(state.samples)) state.samples = [];
  if (!state.stats || typeof state.stats !== 'object') state.stats = { samples: 0, warnings: 0, violations: 0, maxTotalLoad: 0 };
  for (const key of ['samples', 'warnings', 'violations', 'maxTotalLoad']) if (state.stats[key] === undefined) state.stats[key] = 0;
  return state;
}

function analyzePerformanceBudget(world, simulationReport = {}, scheduleReport = {}, options = {}) {
  const state = ensurePerformanceBudgetState(world);
  const config = normalizePerformanceBudgetOptions(options);
  const systems = (scheduleReport.systems || []).map(entry => sampleSystemLoad(entry, simulationReport, config));
  const totalLoad = round(systems.reduce((sum, sample) => sum + sample.load, 0), 3);
  const warnings = [];
  const violations = [];

  for (const sample of systems) {
    if (sample.load > sample.budget) violations.push({ type: 'system_over_budget', systemId: sample.systemId, load: sample.load, budget: sample.budget });
    else if (sample.load >= sample.budget * config.warningRatio) warnings.push({ type: 'system_near_budget', systemId: sample.systemId, load: sample.load, budget: sample.budget });
  }
  if (totalLoad > config.maxTotalLoad) violations.push({ type: 'total_over_budget', load: totalLoad, budget: config.maxTotalLoad });
  else if (totalLoad >= config.maxTotalLoad * config.warningRatio) warnings.push({ type: 'total_near_budget', load: totalLoad, budget: config.maxTotalLoad });

  const sample = {
    version: PERFORMANCE_BUDGET_VERSION,
    tick: Number(world.tick || scheduleReport.targetTick || scheduleReport.tick || 0),
    scheduleId: scheduleReport.id || null,
    totalLoad,
    maxSystemLoad: round(Math.max(0, ...systems.map(item => item.load)), 3),
    systems,
    warnings,
    violations,
    ok: violations.length === 0,
  };

  state.samples.push(compactPerformanceSample(sample));
  while (state.samples.length > config.maxSamples) state.samples.shift();
  state.last = compactPerformanceSample(sample);
  state.stats.samples += 1;
  state.stats.warnings += warnings.length;
  state.stats.violations += violations.length;
  state.stats.maxTotalLoad = Math.max(Number(state.stats.maxTotalLoad || 0), totalLoad);
  return sample;
}

function sampleSystemLoad(scheduleEntry, report, config) {
  const section = getReportSection(report, SYSTEM_SECTION_PATHS[scheduleEntry.id] || []);
  const sectionLoad = estimateValueLoad(section, 0) * config.sectionLoadScale;
  const statusLoad = scheduleEntry.status === 'completed' ? 1 : scheduleEntry.status === 'skipped' ? 0.25 : 3;
  const digestLoad = scheduleEntry.resultDigest ? String(scheduleEntry.resultDigest).length * 0.5 : 0;
  const load = round(statusLoad + digestLoad + sectionLoad, 3);
  const budget = Number(config.systemBudgets[scheduleEntry.id] || config.maxSystemLoad);
  return {
    systemId: scheduleEntry.id,
    phase: scheduleEntry.phase,
    status: scheduleEntry.status,
    load,
    budget,
    section: SYSTEM_SECTION_PATHS[scheduleEntry.id]?.join('.') || null,
  };
}

function estimateValueLoad(value, depth = 0) {
  if (depth > 5) return 1;
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number' || typeof value === 'boolean') return 1;
  if (typeof value === 'string') return Math.min(40, value.length / 8);
  if (Array.isArray(value)) {
    return 2 + value.length * 2 + value.slice(0, 20).reduce((sum, item) => sum + estimateValueLoad(item, depth + 1), 0);
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    return 2 + entries.length * 1.5 + entries.slice(0, 30).reduce((sum, [, item]) => sum + estimateValueLoad(item, depth + 1), 0);
  }
  return 1;
}

function getPerformanceBudgetSummary(world) {
  const state = ensurePerformanceBudgetState(world);
  return {
    version: state.version,
    samples: state.stats.samples,
    warnings: state.stats.warnings,
    violations: state.stats.violations,
    maxTotalLoad: state.stats.maxTotalLoad,
    last: state.last ? { ...state.last } : null,
  };
}

function compactPerformanceSample(sample) {
  return {
    tick: sample.tick,
    scheduleId: sample.scheduleId,
    totalLoad: sample.totalLoad,
    maxSystemLoad: sample.maxSystemLoad,
    warnings: sample.warnings.length,
    violations: sample.violations.length,
    ok: sample.ok,
    topSystems: [...sample.systems].sort((left, right) => right.load - left.load).slice(0, 8).map(system => ({ systemId: system.systemId, load: system.load, budget: system.budget })),
  };
}

function normalizePerformanceBudgetOptions(options = {}) {
  return {
    ...DEFAULT_PERFORMANCE_BUDGET_OPTIONS,
    ...(options || {}),
    systemBudgets: { ...DEFAULT_SYSTEM_BUDGETS, ...(options.systemBudgets || {}) },
  };
}

function getReportSection(report, path) {
  let value = report;
  for (const key of path || []) {
    if (!value || typeof value !== 'object') return null;
    value = value[key];
  }
  return value;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

module.exports = {
  PERFORMANCE_BUDGET_VERSION,
  DEFAULT_PERFORMANCE_BUDGET_OPTIONS,
  DEFAULT_SYSTEM_BUDGETS,
  ensurePerformanceBudgetState,
  analyzePerformanceBudget,
  estimateValueLoad,
  getPerformanceBudgetSummary,
  normalizePerformanceBudgetOptions,
};
