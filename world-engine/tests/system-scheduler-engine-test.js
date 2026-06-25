'use strict';

const assert = require('assert');
const { createWorld } = require('../core/world-engine');
const {
  createSystemRegistry,
  registerSystem,
  resolveSystemOrder,
  runSystemSchedule,
  getSchedulerSummary,
} = require('../core/system-scheduler-engine');

function main() {
  const world = createWorld({ id: 'scheduler_world', seed: 77, tick: 2 });
  world.resources.order = [];
  const registry = createSystemRegistry({
    phases: ['before', 'simulation', 'after'],
    errorPolicy: 'continue',
    rollbackOnError: true,
    trace: true,
  });

  registerSystem(registry, {
    id: 'prepare',
    phase: 'before',
    run: ({ world: current }) => {
      current.resources.order.push('prepare');
      return { prepared: true };
    },
  });
  registerSystem(registry, {
    id: 'economy',
    phase: 'simulation',
    after: ['prepare'],
    order: 20,
    randomStream: 'economy',
    run: context => {
      context.world.resources.order.push('economy');
      context.world.resources.marketRoll = context.randomInt(1, 100);
      context.state.lastRoll = context.world.resources.marketRoll;
      return { roll: context.world.resources.marketRoll };
    },
  });
  registerSystem(registry, {
    id: 'population',
    phase: 'simulation',
    after: ['prepare'],
    before: ['economy'],
    order: 10,
    run: ({ world: current, chance }) => {
      current.resources.order.push('population');
      current.resources.birth = chance(0.5);
      return { birth: current.resources.birth };
    },
  });
  registerSystem(registry, {
    id: 'periodic',
    phase: 'after',
    after: ['economy'],
    every: 2,
    run: ({ world: current }) => {
      current.resources.order.push('periodic');
      return true;
    },
  });
  registerSystem(registry, {
    id: 'skipped',
    phase: 'after',
    every: 3,
    run: ({ world: current }) => current.resources.order.push('skipped'),
  });

  const order = resolveSystemOrder(registry).map(system => system.id);
  assert.deepStrictEqual(order, ['prepare', 'population', 'economy', 'periodic', 'skipped']);

  const report = runSystemSchedule(world, registry, { tick: 2 });
  assert.deepStrictEqual(world.resources.order, ['prepare', 'population', 'economy', 'periodic']);
  assert.deepStrictEqual(report.completed.map(item => item.id), ['prepare', 'population', 'economy', 'periodic']);
  assert.deepStrictEqual(report.skipped.map(item => item.id), ['skipped']);
  assert.strictEqual(report.failed.length, 0);
  assert.ok(Number.isInteger(world.resources.marketRoll));
  assert.ok(world.resources.marketRoll >= 1 && world.resources.marketRoll <= 100);

  const schedulerSummary = getSchedulerSummary(world);
  assert.strictEqual(schedulerSummary.runs, 1);
  assert.strictEqual(schedulerSummary.systems.economy.runs, 1);
  assert.strictEqual(schedulerSummary.systems.skipped.skips, 1);
  assert.strictEqual(schedulerSummary.systems.economy.data.lastRoll, world.resources.marketRoll);

  const twin = createWorld({ id: 'scheduler_world', seed: 77, tick: 2 });
  twin.resources.order = [];
  const twinRegistry = cloneRegistryDefinition();
  const twinReport = runSystemSchedule(twin, twinRegistry, { tick: 2 });
  assert.deepStrictEqual(twin.resources, world.resources, 'scheduler context RNG must be deterministic');
  assert.deepStrictEqual(twinReport.completed.map(item => item.result), report.completed.map(item => item.result));

  const rollbackWorld = createWorld({ id: 'rollback_world', seed: 5 });
  rollbackWorld.resources.value = 1;
  const rollbackRegistry = createSystemRegistry({ errorPolicy: 'continue', rollbackOnError: true });
  registerSystem(rollbackRegistry, {
    id: 'broken',
    run: ({ world: current }) => {
      current.resources.value = 999;
      current.resources.leaked = true;
      throw new Error('intentional failure');
    },
  });
  registerSystem(rollbackRegistry, {
    id: 'observer',
    after: ['broken'],
    run: ({ world: current }) => {
      current.resources.observed = current.resources.value;
      return current.resources.value;
    },
  });
  const rollbackReport = runSystemSchedule(rollbackWorld, rollbackRegistry);
  assert.strictEqual(rollbackReport.failed.length, 1);
  assert.strictEqual(rollbackReport.failed[0].rolledBack, true);
  assert.strictEqual(rollbackWorld.resources.value, 1, 'failed system mutation must be rolled back');
  assert.strictEqual(rollbackWorld.resources.leaked, undefined);
  assert.strictEqual(rollbackWorld.resources.observed, 1, 'later systems must see restored state');

  const cycleRegistry = createSystemRegistry();
  registerSystem(cycleRegistry, { id: 'a', after: ['b'], run: () => null });
  registerSystem(cycleRegistry, { id: 'b', after: ['a'], run: () => null });
  assert.throws(() => resolveSystemOrder(cycleRegistry), error => error.code === 'system_dependency_cycle');

  const missingRegistry = createSystemRegistry();
  registerSystem(missingRegistry, { id: 'a', after: ['missing'], run: () => null });
  assert.throws(() => resolveSystemOrder(missingRegistry), error => error.code === 'system_dependency_missing');

  console.log('system scheduler engine test passed');
}

function cloneRegistryDefinition() {
  const registry = createSystemRegistry({
    phases: ['before', 'simulation', 'after'],
    errorPolicy: 'continue',
    rollbackOnError: true,
    trace: true,
  });
  registerSystem(registry, {
    id: 'prepare',
    phase: 'before',
    run: ({ world }) => {
      world.resources.order.push('prepare');
      return { prepared: true };
    },
  });
  registerSystem(registry, {
    id: 'economy',
    phase: 'simulation',
    after: ['prepare'],
    order: 20,
    randomStream: 'economy',
    run: context => {
      context.world.resources.order.push('economy');
      context.world.resources.marketRoll = context.randomInt(1, 100);
      context.state.lastRoll = context.world.resources.marketRoll;
      return { roll: context.world.resources.marketRoll };
    },
  });
  registerSystem(registry, {
    id: 'population',
    phase: 'simulation',
    after: ['prepare'],
    before: ['economy'],
    order: 10,
    run: ({ world, chance }) => {
      world.resources.order.push('population');
      world.resources.birth = chance(0.5);
      return { birth: world.resources.birth };
    },
  });
  registerSystem(registry, {
    id: 'periodic',
    phase: 'after',
    after: ['economy'],
    every: 2,
    run: ({ world }) => {
      world.resources.order.push('periodic');
      return true;
    },
  });
  registerSystem(registry, {
    id: 'skipped',
    phase: 'after',
    every: 3,
    run: ({ world }) => world.resources.order.push('skipped'),
  });
  return registry;
}

main();
