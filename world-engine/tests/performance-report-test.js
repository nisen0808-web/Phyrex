'use strict';

const assert = require('assert');
const { createWorld } = require('../core/world-engine');
const {
  createPerformanceTrendReport,
  createPerformancePressureScenarioReport,
  createPerformanceOperationsReport,
  aggregateTopSystems,
} = require('../core/performance-report-engine');

function main() {
  testTrendReport();
  testPressureScenarioReport();
  testOperationsReport();
  console.log('performance report test passed');
}

function testTrendReport() {
  const world = buildWorld();
  const trend = createPerformanceTrendReport(world, { windowSize: 4 });
  assert.strictEqual(trend.sampleCount, 4);
  assert.ok(trend.averageTotalLoad > 0);
  assert.strictEqual(trend.trend.direction, 'rising');
  assert.ok(trend.topSystems.some(system => system.systemId === 'economy.production'));
}

function testPressureScenarioReport() {
  const world = buildWorld();
  const scenarios = [
    { name: 'base', sample: world.kernel.performance.samples[0] },
    { name: 'heavy', sample: world.kernel.performance.samples[3], multiplier: 2 },
  ];
  const report = createPerformancePressureScenarioReport(world, scenarios);
  assert.strictEqual(report.scenarioCount, 2);
  assert.strictEqual(report.highestRisk.name, 'heavy');
  assert.ok(report.summary.maxTotalLoad >= report.scenarios[0].totalLoad);
}

function testOperationsReport() {
  const world = buildWorld();
  const operations = createPerformanceOperationsReport(world, [{ name: 'heavy', sample: world.kernel.performance.samples[3], multiplier: 2 }]);
  assert.ok(operations.trend.sampleCount >= 1);
  assert.ok(operations.pressure.scenarioCount === 1);
  assert.ok(operations.recommendations.length >= 1);
  const systems = aggregateTopSystems(world.kernel.performance.samples, 3);
  assert.ok(systems.length <= 3);
}

function buildWorld() {
  const world = createWorld({ id: 'performance-report-world', seed: 'performance-report-seed' });
  world.tick = 200;
  world.kernel = {
    performance: {
      samples: [
        sample(10, 100, 25, 0, 0),
        sample(11, 115, 30, 0, 0),
        sample(12, 135, 38, 1, 0),
        sample(13, 170, 50, 1, 1),
      ],
      last: null,
      stats: { samples: 4, warnings: 2, violations: 1, maxTotalLoad: 170 },
    },
  };
  return world;
}

function sample(tick, totalLoad, maxSystemLoad, warnings, violations) {
  return {
    tick,
    totalLoad,
    maxSystemLoad,
    warnings,
    violations,
    ok: violations === 0,
    topSystems: [
      { systemId: 'economy.production', load: maxSystemLoad, budget: 2800 },
      { systemId: 'agency.opportunity', load: maxSystemLoad * 0.75, budget: 2400 },
    ],
  };
}

main();
