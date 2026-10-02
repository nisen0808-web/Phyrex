'use strict';
const assert = require('assert');
const { createDurableCommandApiServer } = require('../core/durable-command-api-engine');
const { fixture, request } = require('./helpers/service-fixture');
async function main() {
  const f = fixture(); let racePlayer = false, raceAdmin = false;
  const conflict = () => Object.assign(new Error('private'), { code: 'WORLD_DB_REVISION_CONFLICT' });
  const store = { ...f.store,
    async listCommandReceipts(query, options) {
      if (racePlayer) { racePlayer = false; f.state.world.accounts.byId.owner.playerIds = []; f.state.revision++; }
      if (options.expectedWorldRevision !== f.state.revision) throw conflict();
      assert.strictEqual(query.worldId, 'service-world'); assert.strictEqual(query.playerId, 'one');
      return { revision: f.state.revision, records: [{ id: 'receipt', worldId: query.worldId, playerId: query.playerId,
        sequence: 17, status: query.status || 'pending', input: 'secret-input', result: 'secret-result', inputDigest: 'secret-digest' }] };
    },
    async getCommandQueue(worldId, options) {
      if (raceAdmin) { raceAdmin = false; f.state.world.accounts.byId.operator.roles = ['player']; f.state.revision++; }
      if (options.expectedWorldRevision !== f.state.revision) throw conflict();
      return { worldId, revision: f.state.revision, pending: 2, pendingIsLowerBound: false, worldCapacityAvailable: true,
        oldestPendingSequence: 17, limits: { maxPendingCommands: 10, maxPendingPerPlayer: 3 }, secret: 'private' };
    },
    async enqueueCommand() { throw Object.assign(new Error('private SQL'), { code: 'WORLD_DB_QUEUE_FULL' }); },
  };
  const api = await createDurableCommandApiServer({ store, auditStore: f.auditStore, rateLimitNow: () => 0 });
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
  const port = api.server.address().port, base = '/durable/worlds/service-world';
  try {
    const page = await request(port, `${base}/players/one/commands?limit=1&status=pending`);
    assert.strictEqual(page.status, 200); assert.strictEqual(page.body.data.nextBeforeSequence, 17);
    assert.ok(!JSON.stringify(page.body).includes('secret'));
    assert.strictEqual((await request(port, `${base}/players/one/commands`, { token: null })).status, 401);
    assert.strictEqual((await request(port, `${base}/players/two/commands`)).status, 403);
    for (const query of ['limit=0', 'limit=101', 'limit=1&limit=2', 'beforeSequence=-1', 'beforeSequence=9007199254740992', 'status=failed', 'playerId=two', 'input=true']) {
      const bad = await request(port, `${base}/players/one/commands?${query}`); assert.strictEqual(bad.status, 400, query);
    }
    const queue = await request(port, `${base}/admin/queue`, { token: 'admin-secret-token' });
    assert.strictEqual(queue.status, 200); assert.ok(!JSON.stringify(queue.body).includes('private'));
    assert.strictEqual((await request(port, `${base}/admin/queue`)).status, 403);
    assert.strictEqual((await request(port, `${base}/admin/queue?include=all`, { token: 'admin-secret-token' })).status, 400);
    assert.strictEqual((await request(port, `${base}/admin/queue`, { method: 'POST', token: 'admin-secret-token' })).status, 405);
    const full = await request(port, `${base}/players/one/commands`, { method: 'POST', body: { id: 'overflow', type: 'wait' } });
    assert.deepStrictEqual(full.body, { ok: false, error: 'command_queue_full' }); assert.strictEqual(full.status, 429); assert.strictEqual(full.headers.get('retry-after'), '1');
    racePlayer = true;
    assert.strictEqual((await request(port, `${base}/players/one/commands`)).status, 403);
    raceAdmin = true;
    assert.strictEqual((await request(port, `${base}/admin/queue`, { token: 'admin-secret-token' })).status, 403);
  } finally { await api.close(); }
  assert.ok(f.state.audits.some(row => row.route === 'history' && row.statusCode === 200));
  assert.ok(f.state.audits.some(row => row.route === 'queue' && row.statusCode === 403));
  assert.ok(f.state.audits.some(row => row.errorCode === 'command_queue_full'));
  const limited = await createDurableCommandApiServer({ store, rateLimitNow: () => 0, accountReadRateLimit: 1 });
  // Restore permissions in a new committed fixture state for the shared read bucket.
  f.state.world.accounts.byId.owner.playerIds = ['one'];
  await new Promise(resolve => limited.server.listen(0, '127.0.0.1', resolve));
  try {
    assert.strictEqual((await request(limited.server.address().port, `${base}/players/one/commands`)).status, 200);
    assert.strictEqual((await request(limited.server.address().port, `${base}/players/one/state`)).status, 429);
  } finally { await limited.close(); }
  console.log('durable command history test passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
