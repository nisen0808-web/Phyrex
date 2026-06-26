'use strict';

const assert = require('assert');
const { createWorld } = require('../core/world-engine');
const {
  createSystemRegistry,
  registerSystem,
  runSystemSchedule,
} = require('../core/system-scheduler-engine');
const {
  CONTRACT_POLICIES,
  createSystemContract,
  attachSystemContract,
  attachRegistryContracts,
  analyzeContractCoverage,
  validateSchema,
  getSystemContractSummary,
  normalizeContractPolicy,
} = require('../core/system-contract-engine');

function main() {
  testSummaryInitializesSchedulerState();
  testValidContract();
  testOutputFailure();
  testWarningPolicy();
  testDisabledPolicy();
  testRegistryCoverage();
  testSchemaFeatures();
  console.log('system contract engine test passed');
}

function testSummaryInitializesSchedulerState() {
  const world = createWorld({ id: 'contract-summary-world', seed: 0 });
  delete world.kernel;
  const summary = getSystemContractSummary(world);
  assert.strictEqual(summary.version, 1);
  assert.strictEqual(world.kernel.version, 1, 'contract state should preserve scheduler version');
  assert.ok(world.kernel.contracts, 'contract state should live under scheduler state');

  const registry = createSystemRegistry({ phases: ['core'] });
  registerSystem(registry, {
    id: 'scheduler.after-summary',
    phase: 'core',
    run(context) {
      context.world.resources.afterSummary = true;
      return true;
    },
  });
  const report = runSystemSchedule(world, registry);
  assert.strictEqual(report.completed, 1, 'summary lookup must not make the world unrunnable');
  assert.strictEqual(world.resources.afterSummary, true);
}

function testValidContract() {
  const world = createWorld({ id: 'contract-valid-world', seed: 1 });
  const registry = createSystemRegistry({ phases: ['core'] });
  const system = registerSystem(registry, {
    id: 'contract.valid',
    phase: 'core',
    run(context) {
      context.world.resources.contractValue = 7;
      return { count: 7, labels: ['ok'] };
    },
  });
  attachSystemContract(system, createSystemContract({
    inputs: [
      { path: 'world.tick', schema: { type: 'integer', minimum: 0 } },
      { path: 'targetTick', schema: { type: 'integer', minimum: 1 } },
    ],
    output: {
      type: 'object',
      required: ['count', 'labels'],
      properties: {
        count: { type: 'integer', minimum: 1 },
        labels: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      },
    },
    postconditions: [
      { path: 'world.resources.contractValue', schema: { type: 'integer', const: 7 } },
    ],
  }));

  const report = runSystemSchedule(world, registry, {
    tick: 0,
    targetTick: 1,
    recordResults: true,
  });
  assert.strictEqual(report.completed, 1);
  assert.strictEqual(report.failed, 0);
  const entry = report.systems[0];
  assert.strictEqual(entry.contract.input.status, 'valid');
  assert.strictEqual(entry.contract.output.status, 'valid');
  assert.strictEqual(entry.contract.postconditions.status, 'valid');
  assert.deepStrictEqual(entry.result, { count: 7, labels: ['ok'] });

  const summary = getSystemContractSummary(world);
  assert.strictEqual(summary.validations, 3);
  assert.strictEqual(summary.violations, 0);
  assert.strictEqual(summary.systems[0].validations, 3);
}

function testOutputFailure() {
  const world = createWorld({ id: 'contract-failure-world', seed: 2 });
  const registry = createSystemRegistry({ phases: ['core'] });
  const system = registerSystem(registry, {
    id: 'contract.invalid-output',
    phase: 'core',
    run: () => ({ count: 'not-a-number' }),
  });
  attachSystemContract(system, {
    output: {
      type: 'object',
      required: ['count'],
      properties: { count: { type: 'integer' } },
    },
  });

  let thrown = null;
  try {
    runSystemSchedule(world, registry);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'invalid output should halt the schedule');
  assert.strictEqual(thrown.code, 'system_schedule_failed');
  assert.strictEqual(thrown.systemId, 'contract.invalid-output');
  assert.strictEqual(thrown.cause.code, 'system_contract_violation');
  assert.strictEqual(thrown.cause.stage, 'output');
  assert.strictEqual(thrown.cause.violations[0].path, '$result.count');
  assert.strictEqual(thrown.report.systems[0].contract.output.status, 'invalid');

  const summary = getSystemContractSummary(world);
  assert.strictEqual(summary.outputFailures, 1);
  assert.strictEqual(summary.failures, 1);
  assert.strictEqual(summary.violations, 1);
}

function testWarningPolicy() {
  const world = createWorld({ id: 'contract-warning-world', seed: 3 });
  const registry = createSystemRegistry({ phases: ['core'] });
  const system = registerSystem(registry, {
    id: 'contract.warning',
    phase: 'core',
    run: () => null,
  });
  attachSystemContract(system, {
    output: { type: 'object' },
  }, { policy: 'warn' });

  const report = runSystemSchedule(world, registry);
  assert.strictEqual(report.completed, 1, 'warning policy should allow execution to complete');
  assert.strictEqual(report.systems[0].contract.output.status, 'invalid');
  const summary = getSystemContractSummary(world);
  assert.strictEqual(summary.warnings, 1);
  assert.strictEqual(summary.failures, 0);
}

function testDisabledPolicy() {
  const world = createWorld({ id: 'contract-disabled-world', seed: 4 });
  const registry = createSystemRegistry({ phases: ['core'] });
  const system = registerSystem(registry, {
    id: 'contract.disabled',
    phase: 'core',
    run: () => 'anything',
  });
  attachSystemContract(system, { output: { type: 'object' } });
  const report = runSystemSchedule(world, registry, { contractPolicy: 'off' });
  assert.strictEqual(report.completed, 1);
  assert.strictEqual(report.systems[0].contract.input.status, 'disabled');
  assert.strictEqual(report.systems[0].contract.output.status, 'disabled');
  assert.strictEqual(getSystemContractSummary(world).validations, 0);
  assert.strictEqual(normalizeContractPolicy(CONTRACT_POLICIES.OFF), 'off');
  assert.throws(() => normalizeContractPolicy('invalid'), /Unsupported system contract policy/);
}

function testRegistryCoverage() {
  const registry = createSystemRegistry({ phases: ['core'] });
  registerSystem(registry, { id: 'covered', phase: 'core', run: () => ({ ok: true }) });
  registerSystem(registry, { id: 'uncovered', phase: 'core', run: () => null });
  const result = attachRegistryContracts(registry, {
    covered: { output: { type: 'object' } },
    missing: { output: { type: 'object' } },
  });
  assert.deepStrictEqual(result.attached, ['covered']);
  assert.deepStrictEqual(result.missingSystems, ['missing']);
  assert.deepStrictEqual(result.missingContracts, ['uncovered']);
  assert.strictEqual(result.coverage, 0.5);
  assert.deepStrictEqual(analyzeContractCoverage(registry), {
    systems: 2,
    contracted: 1,
    uncontracted: 1,
    coverage: 0.5,
    contractedIds: ['covered'],
    uncontractedIds: ['uncovered'],
  });
}

function testSchemaFeatures() {
  const violations = [];
  validateSchema({
    mode: 'active',
    scores: [1, 2, 3],
    nested: { id: 'abc' },
  }, {
    type: 'object',
    required: ['mode', 'scores', 'nested'],
    properties: {
      mode: { type: 'string', enum: ['active', 'paused'] },
      scores: { type: 'array', minItems: 2, items: { type: 'number', minimum: 0 } },
      nested: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', pattern: /^[a-z]+$/ } },
      },
    },
  }, '$value', violations, { stage: 'test' });
  assert.deepStrictEqual(violations, []);

  const invalid = [];
  validateSchema({ mode: 'bad', scores: [-1], nested: {} }, {
    type: 'object',
    required: ['mode', 'scores', 'nested'],
    properties: {
      mode: { type: 'string', enum: ['active'] },
      scores: { type: 'array', minItems: 2, items: { type: 'number', minimum: 0 } },
      nested: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, '$value', invalid, { stage: 'test' });
  assert.strictEqual(invalid.length, 4);
  assert.ok(invalid.some(item => item.code === 'enum_mismatch'));
  assert.ok(invalid.some(item => item.code === 'minItems_violation'));
  assert.ok(invalid.some(item => item.code === 'minimum_violation'));
  assert.ok(invalid.some(item => item.code === 'required_property_missing'));
}

main();
