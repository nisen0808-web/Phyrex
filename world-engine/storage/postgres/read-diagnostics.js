'use strict';
const { performance } = require('node:perf_hooks');

const FAILURE_KINDS = Object.freeze(['timeout', 'unavailable', 'migration_required', 'closed', 'corrupt_checkpoint', 'archived_checkpoint', 'invalid_input', 'database_error', 'unknown']);
const READ_PHASES = Object.freeze(['ready', 'head', 'cache', 'shared', 'payload', 'restore', 'commit']);
const COUNTERS = Object.freeze(['requests', 'completed', 'failed', 'missing', 'active', 'peakActive', 'cacheHits', 'sharedLoads', 'payloadLoads']);
const add = (a, b = 1) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
const elapsed = (now, start) => Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, now - start));
function failureKind(error) {
  const kinds = { WORLD_DB_TIMEOUT: 'timeout', WORLD_DB_UNAVAILABLE: 'unavailable', WORLD_DB_MIGRATION_REQUIRED: 'migration_required',
    WORLD_DB_CLOSED: 'closed', WORLD_DB_CORRUPT_RECORD: 'corrupt_checkpoint', WORLD_DB_CHECKPOINT_ARCHIVED: 'archived_checkpoint',
    WORLD_DB_INVALID_INPUT: 'invalid_input', WORLD_DB_SQL_ERROR: 'database_error' };
  return Object.hasOwn(kinds, error?.code) ? kinds[error.code] : 'unknown';
}

// Constant-size, process-local observations. No identifiers, payloads or errors
// are retained. The monotonic clock measures elapsed work, never world time.
function createReadDiagnostics(now = () => performance.now()) {
  const counts = Object.fromEntries(COUNTERS.map(key => [key, 0]));
  const duration = { lastMs: null, maxMs: 0, totalMs: 0 };
  let lastPayload = null, lastFailure = null;
  function begin() {
    counts.requests = add(counts.requests); counts.active = add(counts.active);
    counts.peakActive = Math.max(counts.peakActive, counts.active);
    const started = now(); let done = false, selected = false;
    return {
      source(value) {
        if (done || selected) return;
        const key = { cache: 'cacheHits', shared: 'sharedLoads', payload: 'payloadLoads' }[value];
        if (key) { counts[key] = add(counts[key]); selected = true; }
      },
      finish({ missing = false, error, phase = 'ready' } = {}) {
        if (done) return; done = true;
        const finished = now(), ms = elapsed(finished, started);
        counts.active = Math.max(0, counts.active - 1);
        duration.lastMs = ms; duration.maxMs = Math.max(duration.maxMs, ms); duration.totalMs = add(duration.totalMs, ms);
        if (error) {
          counts.failed = add(counts.failed);
          lastFailure = { kind: failureKind(error), phase: READ_PHASES.includes(phase) ? phase : 'ready', at: finished };
        } else { counts.completed = add(counts.completed); if (missing) counts.missing = add(counts.missing); }
      },
    };
  }
  function payload({ bytes, fetchMs, restoreMs }) { lastPayload = { bytes, fetchMs, restoreMs }; }
  function snapshot() {
    return { scope: 'adapter', ...counts, duration: { ...duration }, lastPayload: lastPayload && { ...lastPayload },
      lastFailure: lastFailure && { kind: lastFailure.kind, phase: lastFailure.phase, ageMs: elapsed(now(), lastFailure.at) } };
  }
  return Object.freeze({ begin, payload, snapshot });
}
module.exports = { createReadDiagnostics, FAILURE_KINDS, READ_PHASES, COUNTERS };
