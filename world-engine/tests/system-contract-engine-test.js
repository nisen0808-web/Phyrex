'use strict';

const assert = require('assert');
const { createWorld } = require('../core/world-engine');
const {
  CONTRACT_POLICIES,
  validateSchema,
  validateSystemContract,
  objectSchema,
  arraySchema,
} = require('../core/system-contract-engine');
const {
  createSystemRegistry,
  registerSystem,
  runSystemSchedule,
  getSchedulerSummary,
} = require('../core/system-scheduler-engine');
const { createSimulationPipelineRegistry } = require('../core/simulation-pipeline-engine');
const {
  applySimulationContracts,
  getSimulationContractCatalogSummary,
} = require('../core/simulation-contract-catalog-engine');

function main() {
  testSchemaValidation();
  testStrictContracts();
  testWarningContracts();
  testDisabledContracts();
  testSimulationCatalog();
  console.log('system contract engine test passed');
}

function testSchemaValidation() {
  const schema = objectSchema(
    ['id', 'values'],
    {
      id: { type: 'string', minLength: 2 },
      values: arraySchema('integer', { minItems: 1 }),
      mode: { type: 'string', enum: ['active', 'paused'], optional: true },
    },
    { additionalProperties: false },
  );
  const valid = [];
  validateSchema({ id: 'ok', values: [1, 2], mode: 'active' }, schema, '$value', valid, 'output');
  assert.deepStrictEqual(valid, []);

  const optional = [];
  validateSchema({ id: 'ok', values: [1] }, schema, '$value', optional, 'output');
  assert.deepStrictEqual(optional, [], 'undeclared optional properties should not become required');

  const invalid = [];
  validateSchema({ id: 'x', values: ['bad'], extra: true }, schema, '$value', invalid, 'output');
  assert.ok(invalid.some(item => item.code === 'string_too_short'));
  assert.ok(invalid.some(item => item.code === 'type_mismatch'));
  assert.ok(invalid.some(item => item.code === 'additional_property'));

  const oneOfValid = [];
  validateSchema('value', { oneOf: ['integer', 'string'] }, '$oneOf', oneOfValid, 'output');
  assert.deepStrictEqual(oneOfValid, []);
  const oneOfInvalid = [];
  validateSchema(true, { oneOf: ['integer', 'string'] }, '$oneOf', oneOfInvalid, 'output');
  assert.ok(oneOfInvalid.some(item => item.code === 'one_of_mismatch'));
  const oneOfAmbiguous = [];
  validateSchema(2, { oneOf: ['number', 'integer'] }, '$oneOf', oneOfAmbiguous, 'output');
  assert.ok(oneOfAmbiguous.some(item => item.code === 'one_of_ambiguous'));

  const context = { world: { tick: 3 }, shared: { ready: true } };
  const result = validateSystemContract({
    input: {
      paths: [
        { path: 'world.tick', schema: 'integer' },
        { path: 'shared.ready', schema: 'boolean' },
      ],
    },
    output: 'integer',
  }, 'input', context);
  assert.strictEqual(result.ok, true);
}

function testStrictContracts() {
  const registry = createSystemRegistry({ phases: ['core'] });
  registerSystem(registry, {
    id: 'contract.valid',
    phase: 'core',
    contract: {
      input: {
        paths: [{ path: 'world.resources', schema: 'object' }],
      },
      output: objectSchema(['value'], { value: 'integer' }),
      post: {
        paths: [{ path: 'world.resources.value', schema: 'integer' }],
      },
    },
    run(context) {
      context.world.resources.value = 7;
      return { value: 7 };
    },
  });
  const world = createWorld({ id: 'contract-valid', seed: 1 });
  const report = runSystemSchedule(world, registry, { contractPolicy: 'strict' });
  assert.strictEqual(report.completed, 1);
  assert.strictEqual(report.contractViolations, 0);
  assert.strictEqual(report.systems[0].contract.status, 'passed');
  assert.strictEqual(getSchedulerSummary(world).systems[0].lastContractStatus, 'passed');

  const invalidRegistry = createSystemRegistry({ phases: ['core'] });
  registerSystem(invalidRegistry, {
    id: 'contract.invalid-output',
    phase: 'core',
    contract: {
      output: objectSchema(['value'], { value: 'integer' }),
    },
    run: () => ({ value: 'not-an-integer' }),
  });
  const invalidWorld = createWorld({ id: 'contract-invalid', seed: 2 });
  assert.throws(
    () => runSystemSchedule(invalidWorld, invalidRegistry, { contractPolicy: 'strict' }),
    error => {
      assert.strictEqual(error.code, 'system_schedule_failed');
      assert.strictEqual(error.cause.code, 'system_contract_violation');
      assert.strictEqual(error.cause.stage, 'output');
      assert.ok(error.report.contractViolations >= 1);
      assert.strictEqual(error.report.systems[0].contract.status, 'failed');
      return true;
    },
  );
}

function testWarningContracts() {
  const registry = createSystemRegistry({ phases: ['core'] });
  registerSystem(registry, {
    id: 'contract.warn',
    phase: 'core',
    contract: { output: 'integer' },
    run(context) {
      context.world.resources.ran = true;
      return 'wrong';
    },
  });
  const world = createWorld({ id: 'contract-warn', seed: 3 });
  const report = runSystemSchedule(world, registry, { contractPolicy: CONTRACT_POLICIES.WARN });
  assert.strictEqual(report.completed, 1);
  assert.strictEqual(report.failed, 0);
  assert.strictEqual(report.contractViolations, 1);
  assert.strictEqual(report.systems[0].contract.status, 'warned');
  assert.strictEqual(world.resources.ran, true);
  const summary = getSchedulerSummary(world);
  assert.strictEqual(summary.contractViolations, 1);
  assert.strictEqual(summary.systems[0].contractViolations, 1);
}

function testDisabledContracts() {
  const registry = createSystemRegistry({ phases: ['core'] });
  registerSystem(registry, {
    id: 'contract.off',
    phase: 'core',
    contract: { output: 'integer' },
    run: () => 'not-checked',
  });
  const world = createWorld({ id: 'contract-off', seed: 4 });
  const report = runSystemSchedule(world, registry, { contractPolicy: CONTRACT_POLICIES.OFF });
  assert.strictEqual(report.completed, 1);
  assert.strictEqual(report.contractViolations, 0);
  assert.strictEqual(report.systems[0].contract.status, 'disabled');
}

function testSimulationCatalog() {
  const registry = createSimulationPipelineRegistry();
  const applied = applySimulationContracts(registry);
  assert.strictEqual(applied.applied.length, 28);
  assert.deepStrictEqual(applied.missing, []);
  const summary = getSimulationContractCatalogSummary(registry);
  assert.strictEqual(summary.contracts, 28);
  assert.strictEqual(summary.declared.length, 28);
  assert.deepStrictEqual(summary.missing, []);
  assert.ok(registry.systems['population.lifecycle'].contract);
  assert.ok(registry.systems['finalize.report'].contract);
}

main();
