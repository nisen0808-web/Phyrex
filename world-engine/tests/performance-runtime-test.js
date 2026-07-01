'use strict';

const assert = require('assert');
const { createWorld } = require('../core/world-engine');
const {
  createDeterministicSimulationKernel,
  initializeDeterministicSimulation,
} = require('../core/deterministic-simulation-engine');
const {
  runDeterministicSimulationTickWithPerformance,
  attachPerformanceBudgetToKernelReport,
  createSyntheticScheduleReport,
  inferPhaseFromSystemId,
  getPerformanceBudgetSummary,
} = require('../core/performance-runtime-engine');

function main() {
  testSyntheticScheduleReport();
  testAttachPerformanceBudgetToKernelReport();
  testRuntimeWrapper();
  console.log('performance runtime test passed');
}

function testSyntheticScheduleReport() {
  const report = { tick: 5, kernel: { scheduleId: 'schedule_1', order: ['population.lifecycle', 'economy.production', 'finalize.history'] } };
  const schedule = createSyntheticScheduleReport(report);
  assert.strictEqual(schedule.systems.length, 3);
  assert.strictEqual(schedule.systems[0].phase, 'population');
  assert.strictEqual(inferPhaseFromSystemId('civilization.governance'), 'civilization');
}

function testAttachPerformanceBudgetToKernelReport() {
  const world = createWorld({ id: 'runtime-performance-attach', seed: 'runtime-performance-seed' });
  const report = {
    tick: 10,
    population: { births: [], deaths: [], updated: [{ id: 'entity_1' }] },
    economy: { produced: [], consumed: [], markets: {} },
    kernel: { scheduleId: 'schedule_2', order: ['population.lifecycle', 'economy.production'] },
  };
  const performance = attachPerformanceBudgetToKernelReport(world, report, { maxTotalLoad: 10000 });
  assert.ok(performance.totalLoad > 0);
  assert.strictEqual(report.kernel.performance, performance);
  assert.strictEqual(getPerformanceBudgetSummary(world).samples, 1);
}

function testRuntimeWrapper() {
  const world = createWorld({ id: 'runtime-performance-wrapper', seed: 'runtime-performance-seed' });
  const kernel = createDeterministicSimulationKernel({ contractPolicy: 'error' });
  initializeDeterministicSimulation(world, deterministicOptions());
  const report = runDeterministicSimulationTickWithPerformance(world, { simulation: deterministicOptions(), performance: { maxTotalLoad: 100000 } }, kernel);
  assert.strictEqual(report.kernel.contracts.violations, 0);
  assert.ok(report.kernel.performance.totalLoad >= 0);
  assert.ok(Array.isArray(report.kernel.performance.topSystems));
  assert.ok(getPerformanceBudgetSummary(world).samples >= 1);
}

function deterministicOptions() {
  return { ...disabledOptions(), autoHistory: true };
}

function disabledOptions() {
  return { seedIndustries: false, autoNatural: false, autoEcology: false, autoConsistency: false, autoPlanActions: false, autoPopulation: false, autoFamilies: false, autoLegacy: false, autoContracts: false, autoOrganizations: false, autoEconomy: false, autoCity: false, autoIdentity: false, autoDesire: false, autoOpportunity: false, autoInformation: false, autoMemory: false, autoCulture: false, autoReligion: false, autoCivilization: false, autoTechnology: false, autoInfrastructure: false, autoGovernance: false, autoProcess: false, autoEmergence: false, autoConflict: false, autoPlayers: false, autoNarrative: false, autoNovel: false };
}

main();
