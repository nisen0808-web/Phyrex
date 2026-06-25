'use strict';

const assert = require('assert');
const { createWorld } = require('../core/world-engine');
const {
  validateSchema,
  normalizeSystemContract,
} = require('../core/system-contract-engine');
const {
  createSystemRegistry,
  registerSystem,
  runSystemSchedule,
  getSchedulerSummary,
  analyzeSystemRegistry,
  auditSystemContracts,
} = require('../core/system-scheduler-engine');

function main() {
  testSchemaValidation();
  testSuccessfulContract();
  testContractPolicies();
  testImplicitGlobalPolicies();
  testAtomicContractRollback();
  console.log('system contract engine test passed');
}

function testSchemaValidation() {
  const schema = {
    type: 'object',
    required: ['id', 'count', 'items'],
    properties: {
      id: { type: 'string', minLength: 3, pattern: /^[a-z_]+$/ },
      count: { type: 'integer', minimum: 0 },
      ratio: { type: ['integer', 'number'], minimum: 0, maximum: 1 },
      items: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['value'],
          properties: { value: { type: 'integer' } },
        },
      },
      mode: { oneOf: [{ const: 'active' }, { const: 'passive' }] },
    },
  };
  const valid = validateSchema({
    id: 'valid_id',
    count: 2,
    ratio: 0.5,
    items: [{ value: 1 }],
    mode: 'active',
  }, schema);
  assert.strictEqual(valid.ok, true);

  const invalid = validateSchema({
    id: 'X',
    count: -1,
    ratio: 2,
    items: [{}],
    mode: 'unknown',
  }, schema);
  assert.strictEqual(invalid.ok, false);
  assert.ok(invalid.issues.some(issue => issue.code === 'string_too_short'));
  assert.ok(invalid.issues.some(issue => issue.code === 'number_below_minimum'));
  assert.ok(invalid.issues.some(issue => issue.code === 'number_above_maximum'));
  assert.ok(invalid.issues.some(issue => issue.code === 'required_property_missing'));
  assert.ok(invalid.issues.some(issue => issue.code === 'one_of_mismatch'));

  const normalized = normalizeSystemContract({
    output: value => value === 1 || 'must equal one',
  });
  assert.strictEqual(normalized.output.kind, 'function');
}

function testSuccessfulContract() {
  const registry = createSystemRegistry({ phases: ['core'] });
  registerSystem(registry, {
    id: 'contract.success',
    phase: 'core',
    contract: {
      input: context => Number.isInteger(context.targetTick) || 'target tick required',
      output: {
        type: 'object',
        required: ['value'],
        properties: { value: { type: 'integer', minimum: 1, maximum: 10 } },
      },
      invariants: [{
        id: 'world_value_matches',
        check({ world, result }) {
          return world.resources.contractValue === result.value || 'world value mismatch';
        },
      }],
    },
    run(context) {
      const value = context.random.int(1, 10, 'value');
      context.world.resources.contractValue = value;
      return { value };
    },
  });

  const world = createWorld({ seed: 'contract-success' });
  const report = runSystemSchedule(world, registry, { recordResults: true });
  assert.strictEqual(report.completed, 1);
  assert.strictEqual(report.contractViolations, 0);
  assert.strictEqual(report.systems[0].contract.input.ok, true);
  assert.strictEqual(report.systems[0].contract.output.ok, true);
  assert.strictEqual(report.systems[0].contract.invariant.ok, true);
  assert.strictEqual(report.implicitRandomCalls, 0);

  const audit = auditSystemContracts(registry);
  assert.strictEqual(audit.systems, 1);
  assert.strictEqual(audit.contracted, 1);
  assert.strictEqual(audit.inputContracts, 1);
  assert.strictEqual(audit.outputContracts, 1);
  assert.strictEqual(audit.invariants, 1);
  assert.deepStrictEqual(audit.missing, []);
}

function testContractPolicies() {
  const warnRegistry = createSystemRegistry({ phases: ['core'] });
  registerSystem(warnRegistry, {
    id: 'contract.warn',
    phase: 'core',
    contract: {
      output: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { const: true } },
      },
    },
    run: () => ({ ok: false }),
  });
  const warnWorld = createWorld({ seed: 1 });
  const warnReport = runSystemSchedule(warnWorld, warnRegistry, { contractPolicy: 'warn' });
  assert.strictEqual(warnReport.completed, 1);
  assert.strictEqual(warnReport.contractWarnings, 1);
  assert.strictEqual(warnReport.systems[0].contract.issues[0].code, 'const_mismatch');
  assert.strictEqual(getSchedulerSummary(warnWorld).contractWarnings, 1);

  const errorRegistry = createSystemRegistry({ phases: ['core'] });
  registerSystem(errorRegistry, {
    id: 'contract.error',
    phase: 'core',
    contract: { output: { type: 'array' } },
    run: () => ({ invalid: true }),
  });
  const errorWorld = createWorld({ seed: 2 });
  assert.throws(
    () => runSystemSchedule(errorWorld, errorRegistry),
    error => error.code === 'system_schedule_failed'
      && error.systemId === 'contract.error'
      && error.cause?.code === 'system_contract_violation',
  );
  const errorSummary = getSchedulerSummary(errorWorld);
  assert.strictEqual(errorSummary.failures, 1);
  assert.strictEqual(errorSummary.contractViolations, 1);
}

function testImplicitGlobalPolicies() {
  const trackedRegistry = createSystemRegistry({ phases: ['core'] });
  registerSystem(trackedRegistry, {
    id: 'purity.tracked',
    phase: 'core',
    run: () => ({ random: Math.random(), now: Date.now() }),
  });
  const left = createWorld({ seed: 'implicit-track' });
  const right = createWorld({ seed: 'implicit-track' });
  const leftReport = runSystemSchedule(left, trackedRegistry, { recordResults: true });
  const rightReport = runSystemSchedule(right, trackedRegistry, { recordResults: true });
  assert.deepStrictEqual(leftReport.systems[0].result, rightReport.systems[0].result);
  assert.strictEqual(leftReport.implicitRandomCalls, 1);
  assert.strictEqual(leftReport.implicitNowCalls, 1);
  assert.strictEqual(leftReport.systems[0].implicitGlobals.randomCalls, 1);
  assert.strictEqual(leftReport.systems[0].implicitGlobals.nowCalls, 1);

  const warningWorld = createWorld({ seed: 'implicit-warning' });
  const warningReport = runSystemSchedule(warningWorld, trackedRegistry, { implicitGlobalPolicy: 'warn' });
  assert.strictEqual(warningReport.implicitGlobalWarnings, 2);
  assert.strictEqual(getSchedulerSummary(warningWorld).implicitGlobalWarnings, 2);

  const strictWorld = createWorld({ seed: 'implicit-error' });
  assert.throws(
    () => runSystemSchedule(strictWorld, trackedRegistry, { implicitGlobalPolicy: 'error' }),
    error => error.code === 'system_schedule_failed'
      && error.cause?.code === 'implicit_deterministic_global',
  );

  const allowedRegistry = createSystemRegistry({ phases: ['core'] });
  registerSystem(allowedRegistry, {
    id: 'purity.allowed',
    phase: 'core',
    determinism: {
      allowMathRandom: true,
      allowDateNow: true,
      reason: 'Compatibility test',
    },
    run: () => [Math.random(), Date.now()],
  });
  const allowedReport = runSystemSchedule(
    createWorld({ seed: 'implicit-allowed' }),
    allowedRegistry,
    { implicitGlobalPolicy: 'error' },
  );
  assert.strictEqual(allowedReport.completed, 1);
  assert.strictEqual(allowedReport.implicitRandomCalls, 1);
  assert.strictEqual(allowedReport.implicitNowCalls, 1);

  const analysis = analyzeSystemRegistry(trackedRegistry);
  const purityWarning = analysis.warnings.find(warning => warning.type === 'implicit_global_reference');
  assert.deepStrictEqual(purityWarning.globals, ['Math.random', 'Date.now']);
  assert.strictEqual(analyzeSystemRegistry(allowedRegistry).warnings.length, 0);
}

function testAtomicContractRollback() {
  const registry = createSystemRegistry({ phases: ['core'] });
  registerSystem(registry, {
    id: 'contract.rollback',
    phase: 'core',
    contract: { output: { const: true } },
    run(context) {
      context.world.resources.currency = 999;
      return false;
    },
  });
  const world = createWorld({ seed: 3 });
  world.resources.currency = 10;
  assert.throws(() => runSystemSchedule(world, registry, { atomic: true }), /contract failed/);
  assert.strictEqual(world.resources.currency, 10);
}

main();
