'use strict';

const assert = require('assert');
const { createWorld } = require('../core/world-engine');
const {
  DETERMINISM_POLICIES,
  normalizeDeterminismPolicy,
  createDeterminismAuditRecord,
  runWithDeterminismAudit,
} = require('../core/determinism-audit-engine');
const {
  createSystemRegistry,
  registerSystem,
  runSystemSchedule,
  getSchedulerSummary,
} = require('../core/system-scheduler-engine');

function main() {
  testDirectAudit();
  testSchedulerAudit();
  testCompatibilityPolicy();
  testStrictPolicy();
  testExplicitStrictSystem();
  console.log('determinism audit engine test passed');
}

function testDirectAudit() {
  assert.strictEqual(normalizeDeterminismPolicy(), 'audit');
  assert.throws(() => normalizeDeterminismPolicy('unknown'), /Unsupported determinism policy/);
  const world = createWorld({ id: 'direct-audit', seed: 'direct-audit' });
  const audit = createDeterminismAuditRecord('direct', 'audit');
  const value = runWithDeterminismAudit(world, 'direct', () => ({
    random: Math.random(),
    now: Date.now(),
  }), { policy: 'audit', audit });
  assert.strictEqual(typeof value.random, 'number');
  assert.strictEqual(typeof value.now, 'number');
  assert.strictEqual(audit.implicitRandomCalls, 1);
  assert.strictEqual(audit.implicitClockCalls, 1);
  assert.strictEqual(audit.totalRandomDraws, 1);
  assert.strictEqual(audit.totalClockReads, 1);
  assert.strictEqual(audit.explicitRandomDraws, 0);
  assert.strictEqual(audit.explicitClockReads, 0);
  assert.strictEqual(audit.warnings.length, 2);
}

function testSchedulerAudit() {
  const registry = createSystemRegistry({ phases: ['core'] });
  registerSystem(registry, {
    id: 'audit.mixed',
    phase: 'core',
    run(context) {
      return {
        explicitRandom: context.random.float('explicit'),
        implicitRandom: Math.random(),
        explicitClock: context.random.now('explicit'),
        implicitClock: Date.now(),
      };
    },
  });
  const world = createWorld({ id: 'scheduler-audit', seed: 'scheduler-audit' });
  const report = runSystemSchedule(world, registry, {
    determinismPolicy: DETERMINISM_POLICIES.AUDIT,
    recordResults: true,
  });
  const entry = report.systems[0];
  assert.strictEqual(entry.status, 'completed');
  assert.strictEqual(entry.determinism.implicitRandomCalls, 1);
  assert.strictEqual(entry.determinism.implicitClockCalls, 1);
  assert.strictEqual(entry.determinism.totalRandomDraws, 2);
  assert.strictEqual(entry.determinism.totalClockReads, 2);
  assert.strictEqual(entry.determinism.explicitRandomDraws, 1);
  assert.strictEqual(entry.determinism.explicitClockReads, 1);
  assert.strictEqual(entry.determinism.warnings.length, 2);
  assert.strictEqual(report.determinismWarnings, 2);
  assert.strictEqual(report.implicitRandomCalls, 1);
  assert.strictEqual(report.implicitClockCalls, 1);

  const summary = getSchedulerSummary(world);
  assert.strictEqual(summary.determinismWarnings, 2);
  assert.strictEqual(summary.implicitRandomCalls, 1);
  assert.strictEqual(summary.implicitClockCalls, 1);
  assert.strictEqual(summary.systems[0].determinismWarnings, 2);
}

function testCompatibilityPolicy() {
  const registry = createSystemRegistry({ phases: ['core'] });
  registerSystem(registry, {
    id: 'audit.compat',
    phase: 'core',
    run: () => [Math.random(), Date.now()],
  });
  const report = runSystemSchedule(
    createWorld({ id: 'compat-audit', seed: 'compat-audit' }),
    registry,
    { determinismPolicy: DETERMINISM_POLICIES.COMPAT },
  );
  assert.strictEqual(report.systems[0].determinism.implicitRandomCalls, 1);
  assert.strictEqual(report.systems[0].determinism.implicitClockCalls, 1);
  assert.strictEqual(report.systems[0].determinism.warnings.length, 0);
  assert.strictEqual(report.determinismWarnings, 0);
}

function testStrictPolicy() {
  const registry = createSystemRegistry({ phases: ['core'] });
  registerSystem(registry, {
    id: 'audit.strict-failure',
    phase: 'core',
    run: () => Math.random(),
  });
  const world = createWorld({ id: 'strict-audit', seed: 'strict-audit' });
  assert.throws(
    () => runSystemSchedule(world, registry, { determinismPolicy: DETERMINISM_POLICIES.STRICT }),
    error => {
      assert.strictEqual(error.code, 'system_schedule_failed');
      assert.strictEqual(error.cause.code, 'implicit_determinism_source');
      assert.strictEqual(error.cause.source, 'Math.random');
      const entry = error.report.systems[0];
      assert.strictEqual(entry.status, 'failed');
      assert.strictEqual(entry.determinism.implicitRandomCalls, 1);
      assert.strictEqual(entry.determinism.totalRandomDraws, 0);
      assert.strictEqual(error.report.determinismWarnings, 1);
      return true;
    },
  );
}

function testExplicitStrictSystem() {
  const registry = createSystemRegistry({ phases: ['core'] });
  registerSystem(registry, {
    id: 'audit.strict-explicit',
    phase: 'core',
    determinismPolicy: 'strict',
    run(context) {
      return {
        random: context.random.float('value'),
        now: context.random.now('time'),
      };
    },
  });
  const world = createWorld({ id: 'strict-explicit', seed: 'strict-explicit' });
  const report = runSystemSchedule(world, registry, { determinismPolicy: 'compat' });
  assert.strictEqual(report.completed, 1);
  assert.strictEqual(report.determinismWarnings, 0);
  assert.strictEqual(report.systems[0].determinism.policy, 'strict');
  assert.strictEqual(report.systems[0].determinism.implicitRandomCalls, 0);
  assert.strictEqual(report.systems[0].determinism.implicitClockCalls, 0);
  assert.strictEqual(report.systems[0].determinism.explicitRandomDraws, 1);
  assert.strictEqual(report.systems[0].determinism.explicitClockReads, 1);
}

main();
