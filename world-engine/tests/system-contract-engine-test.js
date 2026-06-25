'use strict';

const assert = require('assert');
const { createWorld } = require('../core/world-engine');
const {
  normalizeSystemContracts,
  evaluateSystemContracts,
  assertSystemContracts,
  getPathValue,
  valueType,
} = require('../core/system-contract-engine');
const {
  instrumentSystemContracts,
  getSystemContractSummary,
} = require('../core/system-contract-runtime-engine');
const {
  createSystemRegistry,
  registerSystem,
  runSystemSchedule,
} = require('../core/system-scheduler-engine');

function main() {
  testContractEvaluation();
  testContractRuntimeSuccess();
  testContractRuntimeFailure();
  testWarningPolicy();
  console.log('system contract engine test passed');
}

function testContractEvaluation() {
  const system = {
    id: 'contract.sample',
    contracts: {
      before: [
        {
          id: 'world.tick',
          target: 'world',
          path: 'tick',
          type: 'integer',
          integer: true,
          min: 0,
        },
        {
          id: 'world.optional',
          target: 'world',
          path: 'optional.value',
          type: 'string',
          required: false,
        },
      ],
      result: [
        {
          id: 'result.items',
          target: 'result',
          path: 'items',
          type: 'array',
          minItems: 1,
        },
        {
          id: 'result.total',
          target: 'result',
          path: 'total',
          type: ['number', 'integer'],
          min: 0,
          predicate(value) {
            return value <= 100 || 'total must be at most 100';
          },
        },
      ],
      after: [context => (
        context.world.tick === context.context.targetTick
          ? true
          : {
            ok: false,
            code: 'tick_mismatch',
            message: 'world tick must match target tick',
          }
      )],
    },
  };

  const normalized = normalizeSystemContracts(system.contracts);
  assert.strictEqual(normalized.before.length, 2);
  assert.strictEqual(normalized.result.length, 2);
  assert.strictEqual(normalized.after.length, 1);
  assert.deepStrictEqual(getPathValue({ a: [{ b: 3 }] }, 'a[0].b'), { found: true, value: 3 });
  assert.strictEqual(valueType([]), 'array');
  assert.strictEqual(valueType(3), 'integer');
  assert.strictEqual(valueType(3.5), 'number');

  const world = { tick: 2 };
  const context = { world, targetTick: 3, shared: {} };
  const before = assertSystemContracts(system, 'before', { world, context });
  assert.strictEqual(before.passed, true);
  assert.strictEqual(before.checked, 2);

  const validResult = evaluateSystemContracts(system, 'result', {
    world,
    context,
    result: { items: ['a'], total: 10 },
  });
  assert.strictEqual(validResult.passed, true);

  const invalidResult = evaluateSystemContracts(system, 'result', {
    world,
    context,
    result: { items: [], total: 120 },
  });
  assert.strictEqual(invalidResult.passed, false);
  assert.strictEqual(invalidResult.errors, 2);
  assert.ok(invalidResult.issues.some(issue => issue.code === 'contract_min_items_violation'));
  assert.ok(invalidResult.issues.some(issue => issue.message === 'total must be at most 100'));

  assert.throws(
    () => assertSystemContracts(system, 'result', {
      world,
      context,
      result: { items: [], total: 120 },
    }),
    error => error.code === 'system_contract_failed'
      && error.systemId === 'contract.sample'
      && error.stage === 'result',
  );

  world.tick = 3;
  assert.strictEqual(assertSystemContracts(system, 'after', { world, context }).passed, true);
  world.tick = 4;
  const after = evaluateSystemContracts(system, 'after', { world, context });
  assert.strictEqual(after.errors, 1);
  assert.strictEqual(after.issues[0].code, 'tick_mismatch');
}

function testContractRuntimeSuccess() {
  const registry = createSystemRegistry({ phases: ['core'] });
  registerSystem(registry, {
    id: 'contract.success',
    phase: 'core',
    contracts: {
      before: {
        id: 'currency.input',
        target: 'world',
        path: 'resources.currency',
        type: 'integer',
        integer: true,
        min: 0,
      },
      result: {
        id: 'currency.output',
        target: 'result',
        path: 'currency',
        type: 'integer',
        integer: true,
        min: 1,
      },
      after: {
        id: 'currency.state',
        target: 'world',
        path: 'resources.currency',
        type: 'integer',
        integer: true,
        min: 1,
      },
    },
    run(context) {
      context.world.resources.currency += 5;
      return { currency: context.world.resources.currency };
    },
  });
  instrumentSystemContracts(registry, { contractPolicy: 'error' });

  const world = createWorld({ id: 'contract-runtime-success', seed: 1 });
  world.resources.currency = 10;
  const report = runSystemSchedule(world, registry, {
    tick: 0,
    targetTick: 1,
    contractPolicy: 'error',
  });
  assert.strictEqual(report.completed, 1);
  assert.strictEqual(report.failed, 0);
  assert.deepStrictEqual(report.contracts, {
    systems: 1,
    checks: 3,
    warnings: 0,
    violations: 0,
    failures: 0,
  });
  assert.strictEqual(report.systems[0].contracts.status, 'passed');
  assert.strictEqual(report.systems[0].contracts.stages.before.passed, true);
  assert.strictEqual(report.systems[0].contracts.stages.result.passed, true);
  assert.strictEqual(report.systems[0].contracts.stages.after.passed, true);

  const summary = getSystemContractSummary(world);
  assert.strictEqual(summary.runs, 1);
  assert.strictEqual(summary.checks, 3);
  assert.strictEqual(summary.violations, 0);
  assert.strictEqual(summary.failures, 0);
  assert.strictEqual(summary.systems[0].lastStatus, 'passed');
}

function testContractRuntimeFailure() {
  const registry = createSystemRegistry({ phases: ['core'] });
  registerSystem(registry, {
    id: 'contract.failure',
    phase: 'core',
    contracts: {
      result: {
        id: 'result.object',
        target: 'result',
        type: 'object',
      },
    },
    run() {
      return ['invalid'];
    },
  });
  instrumentSystemContracts(registry, { contractPolicy: 'error' });
  const world = createWorld({ id: 'contract-runtime-failure', seed: 2 });

  assert.throws(
    () => runSystemSchedule(world, registry, { contractPolicy: 'error' }),
    error => error.code === 'system_schedule_failed'
      && error.systemId === 'contract.failure'
      && error.cause?.code === 'system_contract_failed'
      && error.cause?.stage === 'result',
  );
  const summary = getSystemContractSummary(world);
  assert.strictEqual(summary.runs, 1);
  assert.strictEqual(summary.violations, 1);
  assert.strictEqual(summary.failures, 1);
  assert.strictEqual(summary.systems[0].lastStatus, 'failed');
}

function testWarningPolicy() {
  const registry = createSystemRegistry({ phases: ['core'] });
  registerSystem(registry, {
    id: 'contract.warning',
    phase: 'core',
    contracts: {
      before: {
        id: 'missing.warning',
        severity: 'warning',
        target: 'world',
        path: 'missing.path',
        type: 'object',
      },
      result: {
        id: 'result.error-as-warning',
        target: 'result',
        type: 'object',
      },
    },
    run() {
      return 'not-object';
    },
  });
  instrumentSystemContracts(registry, { contractPolicy: 'warn' });
  const world = createWorld({ id: 'contract-runtime-warning', seed: 3 });
  const report = runSystemSchedule(world, registry, { contractPolicy: 'warn' });
  assert.strictEqual(report.completed, 1, 'warn policy should not fail system execution');
  assert.strictEqual(report.contracts.warnings, 1);
  assert.strictEqual(report.contracts.violations, 1);
  assert.strictEqual(report.contracts.failures, 0);
  assert.strictEqual(report.systems[0].contracts.status, 'warning');
  const summary = getSystemContractSummary(world);
  assert.strictEqual(summary.warnings, 1);
  assert.strictEqual(summary.violations, 1);
  assert.strictEqual(summary.failures, 0);
}

main();
