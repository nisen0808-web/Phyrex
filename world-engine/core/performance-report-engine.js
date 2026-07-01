'use strict';

const PERFORMANCE_REPORT_VERSION = 1;

const DEFAULT_PERFORMANCE_REPORT_OPTIONS = {
  windowSize: 20,
  topSystemsLimit: 8,
  regressionThreshold: 0.08,
};

function createPerformanceTrendReport(world, options = {}) {
  const config = { ...DEFAULT_PERFORMANCE_REPORT_OPTIONS, ...(options || {}) };
  const samples = getPerformanceSamples(world).slice(-Math.max(1, Number(config.windowSize || 20)));
  const totals = samples.map(sample => Number(sample.totalLoad || 0));
  const maxSystems = samples.map(sample => Number(sample.maxSystemLoad || 0));
  const topSystems = aggregateTopSystems(samples, config.topSystemsLimit);
  const first = totals[0] || 0;
  const last = totals[totals.length - 1] || 0;
  const delta = round(last - first, 3);
  const ratio = first > 0 ? delta / first : 0;
  return {
    version: PERFORMANCE_REPORT_VERSION,
    tick: Number(world.tick || 0),
    sampleCount: samples.length,
    windowSize: Number(config.windowSize || 20),
    averageTotalLoad: round(average(totals), 3),
    maxTotalLoad: round(Math.max(0, ...totals), 3),
    averageMaxSystemLoad: round(average(maxSystems), 3),
    maxSystemLoad: round(Math.max(0, ...maxSystems), 3),
    warningCount: samples.reduce((sum, sample) => sum + Number(sample.warnings || 0), 0),
    violationCount: samples.reduce((sum, sample) => sum + Number(sample.violations || 0), 0),
    trend: {
      first: round(first, 3),
      last: round(last, 3),
      delta,
      ratio: round(ratio, 4),
      direction: inferTrendDirection(ratio, config.regressionThreshold),
    },
    topSystems,
  };
}

function createPerformancePressureScenarioReport(world, scenarios = [], options = {}) {
  const config = { ...DEFAULT_PERFORMANCE_REPORT_OPTIONS, ...(options || {}) };
  const normalized = scenarios.map((scenario, index) => normalizeScenario(world, scenario, index, config));
  const sorted = [...normalized].sort((left, right) => right.riskScore - left.riskScore || left.name.localeCompare(right.name));
  return {
    version: PERFORMANCE_REPORT_VERSION,
    tick: Number(world.tick || 0),
    scenarioCount: normalized.length,
    scenarios: normalized,
    highestRisk: sorted[0] || null,
    summary: {
      averageRiskScore: round(average(normalized.map(item => item.riskScore)), 3),
      violationScenarios: normalized.filter(item => item.violations > 0).length,
      warningScenarios: normalized.filter(item => item.warnings > 0).length,
      maxTotalLoad: round(Math.max(0, ...normalized.map(item => item.totalLoad)), 3),
    },
  };
}

function createPerformanceOperationsReport(world, scenarios = [], options = {}) {
  const trend = createPerformanceTrendReport(world, options);
  const pressure = createPerformancePressureScenarioReport(world, scenarios, options);
  return {
    version: PERFORMANCE_REPORT_VERSION,
    tick: Number(world.tick || 0),
    trend,
    pressure,
    recommendations: createRecommendations(trend, pressure),
  };
}

function getPerformanceSamples(world) {
  return Array.isArray(world.kernel?.performance?.samples) ? world.kernel.performance.samples : [];
}

function normalizeScenario(world, scenario = {}, index = 0, config = DEFAULT_PERFORMANCE_REPORT_OPTIONS) {
  const sample = scenario.sample || scenario;
  const totalLoad = Number(sample.totalLoad || 0) * Number(scenario.multiplier || 1);
  const maxSystemLoad = Number(sample.maxSystemLoad || Math.max(0, ...(sample.topSystems || []).map(item => Number(item.load || 0)))) * Number(scenario.multiplier || 1);
  const warnings = Number(sample.warnings || 0);
  const violations = Number(sample.violations || 0);
  const topSystems = (sample.topSystems || []).map(system => ({
    systemId: system.systemId,
    load: round(Number(system.load || 0) * Number(scenario.multiplier || 1), 3),
    budget: Number(system.budget || 0),
    utilization: system.budget ? round((Number(system.load || 0) * Number(scenario.multiplier || 1)) / Number(system.budget || 1), 3) : null,
  })).sort((left, right) => right.load - left.load).slice(0, Number(config.topSystemsLimit || 8));
  const budgetPressure = average(topSystems.map(system => system.utilization || 0));
  const riskScore = round(totalLoad * 0.01 + maxSystemLoad * 0.02 + warnings * 2 + violations * 8 + budgetPressure * 12, 3);
  return {
    name: scenario.name || sample.name || `scenario_${index + 1}`,
    totalLoad: round(totalLoad, 3),
    maxSystemLoad: round(maxSystemLoad, 3),
    warnings,
    violations,
    ok: violations === 0,
    riskScore,
    topSystems,
  };
}

function aggregateTopSystems(samples, limit = 8) {
  const bySystem = {};
  for (const sample of samples) {
    for (const system of sample.topSystems || []) {
      const id = system.systemId;
      if (!id) continue;
      if (!bySystem[id]) bySystem[id] = { systemId: id, appearances: 0, totalLoad: 0, maxLoad: 0, budget: system.budget || null };
      bySystem[id].appearances += 1;
      bySystem[id].totalLoad += Number(system.load || 0);
      bySystem[id].maxLoad = Math.max(bySystem[id].maxLoad, Number(system.load || 0));
      if (system.budget) bySystem[id].budget = system.budget;
    }
  }
  return Object.values(bySystem)
    .map(item => ({ ...item, averageLoad: round(item.totalLoad / Math.max(1, item.appearances), 3), maxLoad: round(item.maxLoad, 3), totalLoad: round(item.totalLoad, 3) }))
    .sort((left, right) => right.totalLoad - left.totalLoad || left.systemId.localeCompare(right.systemId))
    .slice(0, Number(limit || 8));
}

function createRecommendations(trend, pressure) {
  const out = [];
  if (trend.trend.direction === 'rising') out.push({ type: 'trend', priority: 'medium', message: 'performance load is rising across the sample window' });
  if (trend.violationCount > 0) out.push({ type: 'violation', priority: 'high', message: 'recent samples include performance budget violations' });
  if (pressure.summary.violationScenarios > 0) out.push({ type: 'pressure', priority: 'high', message: 'one or more pressure scenarios exceed budget' });
  if (!out.length) out.push({ type: 'status', priority: 'low', message: 'performance samples are within current deterministic budgets' });
  return out;
}

function inferTrendDirection(ratio, threshold) {
  if (ratio >= threshold) return 'rising';
  if (ratio <= -threshold) return 'falling';
  return 'stable';
}

function average(values) {
  const filtered = (values || []).filter(Number.isFinite);
  return filtered.length ? filtered.reduce((sum, value) => sum + value, 0) / filtered.length : 0;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

module.exports = {
  PERFORMANCE_REPORT_VERSION,
  DEFAULT_PERFORMANCE_REPORT_OPTIONS,
  createPerformanceTrendReport,
  createPerformancePressureScenarioReport,
  createPerformanceOperationsReport,
  getPerformanceSamples,
  aggregateTopSystems,
};
