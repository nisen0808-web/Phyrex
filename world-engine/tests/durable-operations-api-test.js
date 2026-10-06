'use strict';
const assert = require('node:assert/strict');
const { createDurableCommandApiServer } = require('../core/durable-command-api-engine');
const { createEngineService } = require('../service/engine-service');
const { fixture, request } = require('./helpers/service-fixture');
const base = '/durable/worlds/service-world/admin/operations';
const admin = { token: 'admin-secret-token' };
async function main() {
  const f = fixture(); let ready = true, failAudit = false, reads = 0;
  const originalAppend = f.auditStore.append;
  f.auditStore.append = async row => { if (failAudit) throw new Error('secret-database-url'); return originalAppend(row); };
  const service = await createEngineService({ worldId: f.state.world.id, port: 0, intervalMs: 60000 }, {
    createApi: options => createDurableCommandApiServer({ ...options, ...f }),
    createRuntime: async () => ({ isReady: () => ready, async close() {}, summary: () => {
      reads++;
      return { ready, status: ready ? 'running' : 'blocked', revision: 1, tick: 0, heartbeatAgeMs: 10,
        heartbeatTimeoutMs: 30000, failures: ready ? 0 : 1, failureKind: ready ? null : 'revision_conflict',
        token: 'secret-token', config: 'secret-database-url', lastError: 'secret raw stack' };
    } }),
  });
  const port = service.address().port;
  try {
    assert.equal((await request(port, base, { token: null })).status, 401);
    const denied = await request(port, base); assert.equal(denied.status, 403); assert.equal(denied.body.error, 'operations_forbidden');
    assert.equal(reads, 0, 'unauthorized requests must never inspect host telemetry');
    assert.equal((await request(port, base + '?include=secrets', admin)).status, 400);
    assert.equal((await request(port, base, { ...admin, method: 'POST' })).status, 405);
    assert.equal((await request(port, base.replace('service-world', 'other'), admin)).status, 404);
    const before = JSON.stringify(f.state.world);
    const healthy = await request(port, base, admin);
    assert.equal(healthy.status, 200); assert.equal(healthy.headers.get('cache-control'), 'no-store');
    assert.equal(healthy.body.data.service.ready, true); assert.equal(healthy.body.data.service.intervalMs, 60000);
    assert.equal(healthy.body.data.service.runtime.heartbeatAgeMs, 10);
    assert.equal(healthy.body.data.revision, healthy.body.data.queue.revision);
    assert.equal(healthy.body.data.queue.pending, 0);
    assert.deepEqual(healthy.body.data.audit, { failures: 0, durable: true });
    assert.ok(!JSON.stringify(healthy.body).includes('secret'));
    assert.equal(JSON.stringify(f.state.world), before); assert.equal(f.state.enqueues, 0);
    ready = false;
    const blocked = await request(port, base, admin);
    assert.equal(blocked.status, 200, 'diagnostics remain readable when writer is blocked');
    assert.equal(blocked.body.data.service.ready, false);
    assert.equal(blocked.body.data.service.runtime.failureKind, 'revision_conflict');
    failAudit = true;
    await request(port, base, admin); await new Promise(resolve => setImmediate(resolve));
    failAudit = false;
    assert.ok((await request(port, base, admin)).body.data.audit.failures > 0);
    assert.ok(f.state.audits.some(row => row.route === 'operations' && row.statusCode === 403));
    assert.ok(f.state.audits.some(row => row.route === 'operations' && row.statusCode === 200));
    // Revocation racing the queue read must re-authorize before exposing telemetry.
    const queueRead = f.store.getCommandQueue;
    f.store.getCommandQueue = async (...args) => {
      f.state.world.accounts.byId.operator.roles = ['player']; f.state.revision++;
      return queueRead(...args);
    };
    const beforeReads = reads;
    assert.equal((await request(port, base, admin)).status, 403);
    assert.equal(reads, beforeReads);
  } finally { await service.close(); }
  for (const limitedBy of ['accountReadRateLimit', 'sourceRateLimit']) {
    const api = await createDurableCommandApiServer({ ...fixture(), rateLimitNow: () => 0, [limitedBy]: 1 });
    try {
      await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
      const reply = await request(api.server.address().port, base, admin);
      assert.equal(reply.status, 200); assert.equal(reply.body.data.service, null, 'standalone API must not invent worker health');
      const limited = await request(api.server.address().port, base, admin);
      assert.equal(limited.status, 429); assert.ok(limited.headers.get('retry-after'));
    } finally { await api.close(); }
  }
  const { serviceStatusView } = require('../service/operational-status');
  const sanitized = serviceStatusView({ stopping: 'secret', intervalMs: NaN, runtime: { status: 'secret-state',
    revision: Infinity, tick: -1, heartbeatAgeMs: 'secret', failures: {}, failureKind: 'secret-error' } });
  assert.equal(sanitized.runtime.status, 'unknown'); assert.equal(sanitized.runtime.revision, null);
  assert.equal(sanitized.runtime.tick, null); assert.equal(sanitized.runtime.failureKind, 'runtime_failed');
  assert.ok(!JSON.stringify(sanitized).includes('secret'));
  console.log('durable operations API passed: authorization, revision fence, redaction, blocked worker, audit failures and both rate limits');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
