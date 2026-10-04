'use strict';
const assert = require('assert');
const http = require('http');
const { createDurableCommandApiServer } = require('../core/durable-command-api-engine');
const { fixture, request } = require('./helpers/service-fixture');
async function main() {
  const f = fixture();
  const before = JSON.stringify(f.state.world);
  const api = await createDurableCommandApiServer({ ...f, rateLimitNow: () => 0, shutdownTimeoutMs: 20 });
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
  const port = api.server.address().port, base = '/durable/worlds/service-world';
  try {
    const view = await request(port, `${base}/players/one/state`);
    assert.strictEqual(view.status, 200); assert.strictEqual(view.body.data.revision, 1);
    assert.strictEqual(view.body.data.character.id, 'character');
    assert.deepStrictEqual(view.body.data.location, { id: 'home', name: 'Home' });
    assert.strictEqual(view.headers.get('cache-control'), 'no-store');
    for (const secret of ['secret', '987654321', 'accounts', 'memory', 'preferences', 'controlledEntityIds']) assert.ok(!JSON.stringify(view.body).includes(secret));
    assert.strictEqual((await request(port, `${base}/players/two/state`)).status, 403);
    assert.strictEqual((await request(port, `${base}/players/one/state`, { token: null })).status, 401);
    assert.strictEqual((await request(port, `${base}/admin/summary`)).status, 403);
    const summary = await request(port, `${base}/admin/summary`, { token: 'admin-secret-token' });
    assert.strictEqual(summary.status, 200); assert.deepStrictEqual(summary.body.data.counts, { entities: 1, alive: 1, locations: 1, factions: 0, organizations: 0, players: 2 });
    assert.strictEqual((await request(port, `${base}/players/one/state?include=accounts`)).status, 400);
    assert.strictEqual((await request(port, `${base}/players/one/state`, { method: 'POST' })).status, 405);
    assert.strictEqual(JSON.stringify(f.state.world), before, 'reads must not mutate committed data');
    f.state.world.accounts.byId.owner.playerIds = []; f.state.revision++;
    assert.strictEqual((await request(port, `${base}/players/one/state`)).status, 403, 'every read authenticates a fresh checkpoint');
    // A partially uploaded body must settle when shutdown disconnects the socket.
    const partial = http.request({ host: '127.0.0.1', port, path: `${base}/players/one/commands`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 100 } });
    partial.on('error', () => {});
    partial.write('{');
    await new Promise(resolve => api.server.once('request', resolve));
    const same = api.close(); assert.strictEqual(api.close(), same);
    await same;
    assert.ok(f.state.audits.some(row => row.errorCode === 'request_aborted'));
    assert.ok(f.state.audits.some(row => row.route === 'state' && row.statusCode === 200));
    assert.ok(f.state.audits.some(row => row.route === 'summary' && row.statusCode === 403));
  } finally { await api.close(); }
  const limited = await createDurableCommandApiServer({ ...fixture(), rateLimitNow: () => 0, accountReadRateLimit: 1 });
  await new Promise(resolve => limited.server.listen(0, '127.0.0.1', resolve));
  try {
    assert.strictEqual((await request(limited.server.address().port, `${base}/players/one/state`)).status, 200);
    assert.strictEqual((await request(limited.server.address().port, `${base}/players/one/state`)).status, 429);
  } finally { await limited.close(); }
  for (const requestIdFactory of [() => { throw new Error('private failure'); }, () => 'bad\nheader']) {
    const invalid = await createDurableCommandApiServer({ ...fixture(), rateLimitNow: () => 0, requestIdFactory });
    await new Promise(resolve => invalid.server.listen(0, '127.0.0.1', resolve));
    try { assert.deepStrictEqual((await request(invalid.server.address().port, '/')).body, { ok: false, error: 'internal_error' }); }
    finally { await invalid.close(); }
  }
  console.log('durable state api test passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
