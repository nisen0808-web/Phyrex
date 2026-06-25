'use strict';

const assert = require('assert');
const { createWorld } = require('../core/world-engine');
const {
  createSystemRegistry,
  registerSystem,
  resolveSystemOrder,
  runSystemSchedule,
  getSchedulerSummary,
  analyzeSystemRegistry,
} = require('../core/system-scheduler-engine');

function main() {
  const registry = createSystemRegistry({ phases: ['pre', 'core', 'post'] });
  const execution = [];

  registerSystem(registry, {
    id: 'core.second',
    phase: 'core',
    after: ['core.first'],
    writes: ['state.beta'],
    run: context => {
      execution.push('core.second');
      context.world.resources.beta = context.random.int(1, 100, 'value');
      return { beta: context.world.resources.beta };
    },
  });
  registerSystem(registry, {
    id: 'pre.prepare',
    phase: 'pre',
    priority: 10,
    writes: ['state.prepare'],
    run: context => {
      execution.push('pre.prepare');
      context.world.resources.prepare = true;
      return { prepared: true };
    },
  });
  registerSystem(registry, {
    id: 'core.first',
    phase: 'core',
    priority: 5,
    writes: ['state.alpha'],
    run: context => {
      execution.push('core.first');
      context.world.resources.alpha = context.random.int(1, 100, 'value');
      return { alpha: context.world.resources.alpha };
    },
  });
  registerSystem(registry, {
    id: 'post.periodic',
    phase: 'post',
    everyTicks: 2,
    offsetTicks: 0,
    writes: ['state.periodic'],
    run: context => {
      execution.push('post.periodic');
      context.world.resources.periodic = Number(context.world.resources.periodic || 0) + 1;
      return { periodic: context.world.resources.periodic };
    },
  });

  assert.deepStrictEqual(
    resolveSystemOrder(registry).map(system => system.id),
    ['pre.prepare', 'core.first', 'core.second', 'post.periodic'],
    'scheduler should respect phase and dependency order',
  );

  const world = createWorld({ id: 'scheduler-world', seed: 88 });
  const first = runSystemSchedule(world, registry, {
    tick: 0,
    targetTick: 1,
    recordResults: true,
  });
  assert.deepStrictEqual(execution, ['pre.prepare', 'core.first', 'core.second']);
  assert.strictEqual(first.completed, 3);
  assert.strictEqual(first.skipped, 1);
  assert.strictEqual(first.failed, 0);
  assert.strictEqual(world.resources.periodic, undefined);

  execution.length = 0;
  const second = runSystemSchedule(world, registry, {
    tick: 1,
    targetTick: 2,
  });
  assert.deepStrictEqual(execution, ['pre.prepare', 'core.first', 'core.second', 'post.periodic']);
  assert.strictEqual(second.completed, 4);
  assert.strictEqual(world.resources.periodic, 1);

  const summary = getSchedulerSummary(world);
  assert.strictEqual(summary.runs, 2);
  assert.strictEqual(summary.failures, 0);
  assert.strictEqual(summary.systems.find(system => system.id === 'core.first').runs, 2);
  assert.strictEqual(summary.systems.find(system => system.id === 'post.periodic').skips, 1);

  testIndependentSystemStreams();
  testAtomicRollback();
  testContinueAfterFailure();
  testCycleDetection();
  testRegistryAnalysis();

  console.log('system scheduler engine test passed');
}

function testIndependentSystemStreams() {
  const baseRegistry = createSystemRegistry({ phases: ['core'] });
  let baseValue;
  registerSystem(baseRegistry, {
    id: 'system.alpha',
    phase: 'core',
    run: context => {
      baseValue = [context.random.float('sample'), Math.random()];
      return baseValue;
    },
  });

  const extendedRegistry = createSystemRegistry({ phases: ['core'] });
  registerSystem(extendedRegistry, {
    id: 'system.unrelated',
    phase: 'core',
    priority: 100,
    run: context => [context.random.float('sample'), Math.random(), Math.random()],
  });
  let extendedValue;
  registerSystem(extendedRegistry, {
    id: 'system.alpha',
    phase: 'core',
    run: context => {
      extendedValue = [context.random.float('sample'), Math.random()];
      return extendedValue;
    },
  });

  runSystemSchedule(createWorld({ seed: 'stream-isolation' }), baseRegistry);
  runSystemSchedule(createWorld({ seed: 'stream-isolation' }), extendedRegistry);
  assert.deepStrictEqual(
    extendedValue,
    baseValue,
    'system-specific streams should not change when unrelated systems draw randomness',
  );
}

function testAtomicRollback() {
  const registry = createSystemRegistry({ phases: ['core'] });
  registerSystem(registry, {
    id: 'system.fail',
    phase: 'core',
    run: context => {
      context.world.resources.currency = 999;
      throw new Error('expected failure');
    },
  });
  const world = createWorld({ seed: 1 });
  world.resources.currency = 10;
  assert.throws(
    () => runSystemSchedule(world, registry, { atomic: true }),
    error => error.code === 'system_schedule_failed' && error.systemId === 'system.fail',
  );
  assert.strictEqual(world.resources.currency, 10, 'atomic failure should restore world state');
}

function testContinueAfterFailure() {
  const registry = createSystemRegistry({ phases: ['core'] });
  registerSystem(registry, {
    id: 'system.a-fail',
    phase: 'core',
    run: () => { throw new Error('continue test'); },
  });
  registerSystem(registry, {
    id: 'system.b-next',
    phase: 'core',
    run: context => {
      context.world.resources.afterFailure = true;
      return true;
    },
  });
  const world = createWorld({ seed: 2 });
  const report = runSystemSchedule(world, registry, { failurePolicy: 'continue' });
  assert.strictEqual(report.failed, 1);
  assert.strictEqual(report.completed, 1);
  assert.strictEqual(world.resources.afterFailure, true);
  assert.strictEqual(getSchedulerSummary(world).failures, 1);
}

function testCycleDetection() {
  const registry = createSystemRegistry({ phases: ['core'] });
  registerSystem(registry, { id: 'cycle.a', phase: 'core', after: ['cycle.b'], run: () => null });
  registerSystem(registry, { id: 'cycle.b', phase: 'core', after: ['cycle.a'], run: () => null });
  assert.throws(() => resolveSystemOrder(registry), /dependency cycle/);
}

function testRegistryAnalysis() {
  const registry = createSystemRegistry({ phases: ['core'] });
  registerSystem(registry, {
    id: 'writer.a',
    phase: 'core',
    writes: ['economy.markets'],
    run: () => null,
  });
  registerSystem(registry, {
    id: 'writer.b',
    phase: 'core',
    writes: ['economy.markets.global'],
    run: () => null,
  });
  const analysis = analyzeSystemRegistry(registry);
  assert.deepStrictEqual(analysis.order, ['writer.a', 'writer.b']);
  assert.strictEqual(analysis.warnings.length, 1);
  assert.strictEqual(analysis.warnings[0].type, 'unordered_write_conflict');
}

main();
