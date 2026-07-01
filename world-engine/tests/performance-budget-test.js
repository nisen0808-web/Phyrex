'use strict';

const assert = require('assert');
const { createWorld } = require('../core/world-engine');
const {
  analyzePerformanceBudget,
  estimateValueLoad,
  getPerformanceBudgetSummary,
} = require('../core/performance-budget-engine');

function main() {
  testValueLoadEstimator();
  testPerformanceBudgetAnalysis();
  testPerformanceBudgetWarnings();
  console.log('performance budget test passed');
}

function testValueLoadEstimator() {
  assert.ok(estimateValueLoad(null) === 0);
  assert.ok(estimateValueLoad([1, 2, 3]) > estimateValueLoad(1));
  assert.ok(estimateValueLoad({ items: Array.from({ length: 8 }, (_, index) => ({ index })) }) > 10);
}

function testPerformanceBudgetAnalysis() {
  const world = createWorld({ id: 'performance-budget-world', seed: 'performance-budget-seed' });
  world.tick = 42;
  const report = {
    population: { births: [], deaths: [], updated: Array.from({ length: 5 }, (_, index) => ({ id: `entity_${index}` })) },
    economy: { produced: [{ resource: 'food', amount: 10 }], consumed: [], tradeFlows: { count: 1, volume: 12 }, markets: { global: { food: { price: 1 } } } },
    opportunities: { generated: [{ id: 'opp_1' }], claimed: [], expired: [] },
  };
  const schedule = {
    id: 'schedule_1',
    tick: 41,
    targetTick: 42,
    systems: [
      { id: 'population.lifecycle', phase: 'population', status: 'completed', resultDigest: 'abc' },
      { id: 'economy.production', phase: 'economy', status: 'completed', resultDigest: 'def' },
      { id: 'agency.opportunity', phase: 'agency', status: 'completed', resultDigest: 'ghi' },
    ],
  };
  const sample = analyzePerformanceBudget(world, report, schedule, { maxTotalLoad: 10000 });
  assert.strictEqual(sample.ok, true);
  assert.strictEqual(sample.systems.length, 3);
  assert.ok(sample.totalLoad > 0);
  assert.strictEqual(world.kernel.performance.samples.length, 1);
  const summary = getPerformanceBudgetSummary(world);
  assert.strictEqual(summary.samples, 1);
  assert.strictEqual(summary.violations, 0);
}

function testPerformanceBudgetWarnings() {
  const world = createWorld({ id: 'performance-budget-warning-world', seed: 'performance-budget-seed' });
  const report = {
    opportunities: { generated: Array.from({ length: 80 }, (_, index) => ({ id: `opp_${index}`, reward: { currency: index } })) },
  };
  const schedule = {
    id: 'schedule_2',
    tick: 1,
    targetTick: 2,
    systems: [
      { id: 'agency.opportunity', phase: 'agency', status: 'completed', resultDigest: 'digest' },
    ],
  };
  const sample = analyzePerformanceBudget(world, report, schedule, { systemBudgets: { 'agency.opportunity': 50 }, maxTotalLoad: 10000 });
  assert.strictEqual(sample.ok, false);
  assert.ok(sample.violations.some(item => item.type === 'system_over_budget'));
  assert.strictEqual(getPerformanceBudgetSummary(world).violations, 1);
}

main();
