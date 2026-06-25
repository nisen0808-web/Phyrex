'use strict';

const {
  ensureRandomState,
  randomFloat,
  deterministicNow,
} = require('./random-engine');

const DETERMINISM_AUDIT_VERSION = 1;
const DETERMINISM_POLICIES = {
  COMPAT: 'compat',
  AUDIT: 'audit',
  STRICT: 'strict',
};

function normalizeDeterminismPolicy(value, fallback = DETERMINISM_POLICIES.AUDIT) {
  const policy = String(value || fallback).trim().toLowerCase();
  if (!Object.values(DETERMINISM_POLICIES).includes(policy)) {
    throw new Error(`Unsupported determinism policy ${policy}`);
  }
  return policy;
}

function createDeterminismAuditRecord(namespace, policy = DETERMINISM_POLICIES.AUDIT) {
  return {
    version: DETERMINISM_AUDIT_VERSION,
    namespace: String(namespace || 'default'),
    policy: normalizeDeterminismPolicy(policy),
    implicitRandomCalls: 0,
    implicitClockCalls: 0,
    totalRandomDraws: 0,
    totalClockReads: 0,
    explicitRandomDraws: 0,
    explicitClockReads: 0,
    warnings: [],
  };
}

function runWithDeterminismAudit(world, namespace, callback, options = {}) {
  if (typeof callback !== 'function') throw new Error('runWithDeterminismAudit requires callback');
  const policy = normalizeDeterminismPolicy(options.policy);
  const audit = options.audit || createDeterminismAuditRecord(namespace, policy);
  audit.namespace = String(namespace || audit.namespace || 'default');
  audit.policy = policy;
  const stateBefore = ensureRandomState(world);
  const randomDrawsBefore = Number(stateBefore.draws || 0);
  const clockReadsBefore = Number(stateBefore.clock?.sequence || 0);
  const streamId = `compat:${audit.namespace}`;
  const originalRandom = Math.random;
  const originalNow = Date.now;

  Math.random = () => {
    audit.implicitRandomCalls += 1;
    notifyImplicitCall(audit, 'random', options);
    if (policy === DETERMINISM_POLICIES.STRICT) {
      throw createImplicitDeterminismError(audit.namespace, 'Math.random');
    }
    return randomFloat(world, streamId);
  };
  Date.now = () => {
    audit.implicitClockCalls += 1;
    notifyImplicitCall(audit, 'clock', options);
    if (policy === DETERMINISM_POLICIES.STRICT) {
      throw createImplicitDeterminismError(audit.namespace, 'Date.now');
    }
    return deterministicNow(world, streamId);
  };

  try {
    const result = callback();
    if (result && typeof result.then === 'function') {
      throw new Error('Deterministic system scope only supports synchronous callbacks');
    }
    return result;
  } finally {
    Math.random = originalRandom;
    Date.now = originalNow;
    finalizeDeterminismAudit(world, audit, randomDrawsBefore, clockReadsBefore);
  }
}

function finalizeDeterminismAudit(world, audit, randomDrawsBefore = 0, clockReadsBefore = 0) {
  const stateAfter = ensureRandomState(world);
  audit.totalRandomDraws = Math.max(0, Number(stateAfter.draws || 0) - Number(randomDrawsBefore || 0));
  audit.totalClockReads = Math.max(0, Number(stateAfter.clock?.sequence || 0) - Number(clockReadsBefore || 0));
  audit.explicitRandomDraws = Math.max(0, audit.totalRandomDraws - audit.implicitRandomCalls);
  audit.explicitClockReads = Math.max(0, audit.totalClockReads - audit.implicitClockCalls);
  audit.warnings = buildDeterminismWarnings(audit);
  return audit;
}

function buildDeterminismWarnings(audit) {
  if (audit.policy === DETERMINISM_POLICIES.COMPAT) return [];
  const warnings = [];
  if (audit.implicitRandomCalls > 0) {
    warnings.push({
      code: 'implicit_random_usage',
      source: 'Math.random',
      calls: audit.implicitRandomCalls,
      message: `${audit.namespace} used Math.random ${audit.implicitRandomCalls} time(s)`,
    });
  }
  if (audit.implicitClockCalls > 0) {
    warnings.push({
      code: 'implicit_clock_usage',
      source: 'Date.now',
      calls: audit.implicitClockCalls,
      message: `${audit.namespace} used Date.now ${audit.implicitClockCalls} time(s)`,
    });
  }
  return warnings;
}

function notifyImplicitCall(audit, kind, options) {
  if (typeof options.onImplicitCall !== 'function') return;
  options.onImplicitCall({
    namespace: audit.namespace,
    policy: audit.policy,
    kind,
    calls: kind === 'random' ? audit.implicitRandomCalls : audit.implicitClockCalls,
  });
}

function createImplicitDeterminismError(namespace, source) {
  const error = new Error(`System ${namespace} used forbidden implicit source ${source}`);
  error.name = 'ImplicitDeterminismError';
  error.code = 'implicit_determinism_source';
  error.namespace = namespace;
  error.source = source;
  return error;
}

function compactDeterminismAudit(audit) {
  if (!audit) return null;
  return {
    policy: audit.policy,
    implicitRandomCalls: Number(audit.implicitRandomCalls || 0),
    implicitClockCalls: Number(audit.implicitClockCalls || 0),
    totalRandomDraws: Number(audit.totalRandomDraws || 0),
    totalClockReads: Number(audit.totalClockReads || 0),
    explicitRandomDraws: Number(audit.explicitRandomDraws || 0),
    explicitClockReads: Number(audit.explicitClockReads || 0),
    warnings: (audit.warnings || []).map(warning => ({ ...warning })),
  };
}

module.exports = {
  DETERMINISM_AUDIT_VERSION,
  DETERMINISM_POLICIES,
  normalizeDeterminismPolicy,
  createDeterminismAuditRecord,
  runWithDeterminismAudit,
  finalizeDeterminismAudit,
  buildDeterminismWarnings,
  createImplicitDeterminismError,
  compactDeterminismAudit,
};
