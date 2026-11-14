'use strict';
const assert = require('node:assert/strict');
const { createReadDiagnostics } = require('../storage/postgres/read-diagnostics');
const { readDiagnosticsView } = require('../service/operational-status');
let clock = 0;
const metrics = createReadDiagnostics(() => clock);
assert.equal(metrics.snapshot().duration.lastMs, null);
const cold = metrics.begin(), shared = metrics.begin();
cold.source('payload'); shared.source('shared'); shared.source('shared');
assert.equal(metrics.snapshot().active, 2);
clock = 25; cold.finish(); clock = 30; shared.finish(); shared.finish();
metrics.payload({ bytes: 12345, fetchMs: 15.25, restoreMs: 3.5 });
const cache = metrics.begin(); cache.source('cache'); clock = 31; cache.finish();
const missing = metrics.begin(); clock = 32; missing.finish({ missing: true });
const timeout = metrics.begin(); timeout.source('payload'); clock = 42;
timeout.finish({ error: { code: 'WORLD_DB_TIMEOUT', message: 'secret-url', cause: 'secret-token' }, phase: 'payload' });
const recovered = metrics.begin(); recovered.source('payload'); clock = 45; recovered.finish();
const snapshot = metrics.snapshot();
assert.deepEqual([snapshot.requests, snapshot.completed, snapshot.failed, snapshot.missing, snapshot.active, snapshot.peakActive], [6, 5, 1, 1, 0, 2]);
assert.deepEqual([snapshot.cacheHits, snapshot.sharedLoads, snapshot.payloadLoads], [1, 1, 3]);
assert.deepEqual(snapshot.duration, { lastMs: 3, maxMs: 30, totalMs: 70 });
assert.deepEqual(snapshot.lastFailure, { kind: 'timeout', phase: 'payload', ageMs: 3 });
snapshot.duration.totalMs = -1; snapshot.lastPayload.bytes = -1; snapshot.lastFailure.kind = 'secret';
assert.equal(metrics.snapshot().lastPayload.bytes, 12345); assert.equal(metrics.snapshot().lastFailure.kind, 'timeout');
for (const [code, kind] of [['WORLD_DB_UNAVAILABLE','unavailable'],['WORLD_DB_MIGRATION_REQUIRED','migration_required'],['WORLD_DB_CORRUPT_RECORD','corrupt_checkpoint'],['WORLD_DB_CLOSED','closed'],['WORLD_DB_CHECKPOINT_ARCHIVED','archived_checkpoint'],['WORLD_DB_INVALID_INPUT','invalid_input'],['WORLD_DB_SQL_ERROR','database_error'],['secret-url','unknown'],['__proto__','unknown']]) {
  const read = metrics.begin(); clock++; read.finish({ error: { code, message: 'secret' }, phase: 'restore' });
  assert.equal(metrics.snapshot().lastFailure.kind, kind);
}
assert(!JSON.stringify(metrics.snapshot()).includes('secret'));
const hostile = readDiagnosticsView({ requests: Infinity, active: -1, token: 'secret-token',
  duration: { lastMs: 'secret', maxMs: NaN, totalMs: -10 },
  lastPayload: { bytes: -1, fetchMs: 'secret', restoreMs: Infinity, envelope: 'secret' },
  lastFailure: { kind: '__proto__', phase: 'secret-query', ageMs: Infinity, message: 'secret-url' } });
assert.equal(hostile.requests, null); assert.equal(hostile.active, null);
assert.deepEqual(hostile.lastFailure, { kind: 'unknown', phase: 'ready', ageMs: null });
assert(!JSON.stringify(hostile).includes('secret')); assert.equal(readDiagnosticsView(null), null);
assert.equal(createReadDiagnostics().snapshot().requests, 0, 'a new adapter starts new counters');
console.log('read diagnostics passed: concurrent accounting, timing, recovery history, detached snapshots and safe bounded fields');
