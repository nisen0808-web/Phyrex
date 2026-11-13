'use strict';
const { FAILURE_KINDS, READ_PHASES, COUNTERS } = require('../storage/postgres/read-diagnostics');

const statuses = new Set(['starting', 'running', 'busy', 'retrying', 'blocked', 'idle', 'closing', 'closed', 'stopped']);
const failures = new Set(['heartbeat_stale', 'worker_failed', 'database_unavailable', 'revision_conflict', 'runtime_failed']);
const rejections = new Set([...failures, 'runtime_not_ready', 'service_stopping']);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Host telemetry is an independent observation, not the authorized SQL snapshot.
// Never pass through an error message, connection string, config or worker data.
function serviceStatusView(value) {
  if (!value || typeof value !== 'object' || !value.runtime) return null;
  const runtime = value.runtime;
  return {
    stopping: value.stopping === true,
    ready: value.stopping !== true && runtime.ready === true,
    intervalMs: count(value.intervalMs),
    admission: { rejected: count(value.admission?.rejected),
      lastRejection: value.admission?.lastRejection ? {
        reason: rejections.has(value.admission.lastRejection.reason) ? value.admission.lastRejection.reason : 'runtime_failed',
        authenticated: value.admission.lastRejection.authenticated === true,
        heartbeatAgeMs: count(value.admission.lastRejection.heartbeatAgeMs),
        revision: count(value.admission.lastRejection.revision), tick: count(value.admission.lastRejection.tick),
      } : null },
    runtime: {
      status: statuses.has(runtime.status) ? runtime.status : 'unknown',
      ready: runtime.ready === true,
      revision: count(runtime.revision), tick: count(runtime.tick),
      heartbeatAgeMs: count(runtime.heartbeatAgeMs), heartbeatTimeoutMs: count(runtime.heartbeatTimeoutMs),
      failures: count(runtime.failures),
      failureKind: failures.has(runtime.failureKind) ? runtime.failureKind : runtime.failureKind ? 'runtime_failed' : null,
    },
  };
}
function readDiagnosticsView(value) {
  if (!value || typeof value !== 'object') return null;
  const ms = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? Math.round(value * 1000) / 1000 : null;
  return { scope: 'adapter', ...Object.fromEntries(COUNTERS.map(key => [key, count(value[key])])),
    duration: { lastMs: ms(value.duration?.lastMs), maxMs: ms(value.duration?.maxMs), totalMs: ms(value.duration?.totalMs) },
    lastPayload: value.lastPayload ? { bytes: count(value.lastPayload.bytes), fetchMs: ms(value.lastPayload.fetchMs), restoreMs: ms(value.lastPayload.restoreMs) } : null,
    lastFailure: value.lastFailure ? { kind: FAILURE_KINDS.includes(value.lastFailure.kind) ? value.lastFailure.kind : 'unknown',
      phase: READ_PHASES.includes(value.lastFailure.phase) ? value.lastFailure.phase : 'ready', ageMs: ms(value.lastFailure.ageMs) } : null,
  };
}
module.exports = { serviceStatusView, readDiagnosticsView };
