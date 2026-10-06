'use strict';

const statuses = new Set(['starting', 'running', 'busy', 'retrying', 'blocked', 'idle', 'closing', 'closed', 'stopped']);
const failures = new Set(['heartbeat_stale', 'worker_failed', 'database_unavailable', 'revision_conflict', 'runtime_failed']);
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
module.exports = { serviceStatusView };
