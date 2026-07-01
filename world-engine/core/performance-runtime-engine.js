'use strict';

const {
  runDeterministicSimulationTick,
} = require('./deterministic-simulation-engine');
const {
  analyzePerformanceBudget,
  getPerformanceBudgetSummary,
} = require('./performance-budget-engine');

function runDeterministicSimulationTickWithPerformance(world, options = {}, kernel = null) {
  const report = runDeterministicSimulationTick(world, options, kernel);
  attachPerformanceBudgetToKernelReport(world, report, options.performance || {});
  return report;
}

function attachPerformanceBudgetToKernelReport(world, report, options = {}) {
  if (!report || typeof report !== 'object') return null;
  const schedule = createSyntheticScheduleReport(report);
  const sample = analyzePerformanceBudget(world, report, schedule, options);
  if (!report.kernel || typeof report.kernel !== 'object') report.kernel = {};
  report.kernel.performance = {
    ok: sample.ok,
    totalLoad: sample.totalLoad,
    maxSystemLoad: sample.maxSystemLoad,
    warnings: sample.warnings.length,
    violations: sample.violations.length,
    topSystems: [...sample.systems]
      .sort((left, right) => right.load - left.load)
      .slice(0, 8)
      .map(system => ({ systemId: system.systemId, load: system.load, budget: system.budget })),
  };
  return report.kernel.performance;
}

function createSyntheticScheduleReport(report = {}) {
  const kernel = report.kernel || {};
  const order = Array.isArray(kernel.order) ? kernel.order : [];
  return {
    id: kernel.scheduleId || null,
    tick: Number(report.tick || 0),
    targetTick: Number(report.tick || 0) + 1,
    systems: order.map(systemId => ({
      id: systemId,
      phase: inferPhaseFromSystemId(systemId),
      status: 'completed',
      resultDigest: null,
    })),
  };
}

function inferPhaseFromSystemId(systemId) {
  const id = String(systemId || '');
  if (id.startsWith('population.')) return 'population';
  if (id.startsWith('social.')) return 'social';
  if (id.startsWith('economy.')) return 'economy';
  if (id.startsWith('agency.')) return 'agency';
  if (id.startsWith('knowledge.')) return 'knowledge';
  if (id.startsWith('civilization.')) return 'civilization';
  if (id.startsWith('finalize.')) return 'finalize';
  if (id.startsWith('natural.')) return 'before';
  if (id.startsWith('ecology.')) return 'before';
  if (id.startsWith('world.')) return 'after';
  return 'unknown';
}

module.exports = {
  runDeterministicSimulationTickWithPerformance,
  attachPerformanceBudgetToKernelReport,
  createSyntheticScheduleReport,
  inferPhaseFromSystemId,
  getPerformanceBudgetSummary,
};
