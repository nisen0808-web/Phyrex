'use strict';
const assert = require('assert');
const net = require('net');
const { createDurableCommandApiServer } = require('../core/durable-command-api-engine');
const { createEngineService } = require('../service/engine-service');
const { parseArgs } = require('../demo/engine-serve-cli');
const { fixture, request } = require('./helpers/service-fixture');
async function main() {
  const f = fixture(); let ready = true, runtimeCloses = 0;
  const factories = {
    createApi: options => createDurableCommandApiServer({ ...options, ...f, closeStore: true }),
    createRuntime: async () => ({ isReady: () => ready, summary: () => ({ ready }), async close() {
      assert.strictEqual(f.state.closes, 1, 'drain HTTP/audit first'); runtimeCloses++;
    } }),
  };
  const service = await createEngineService({ worldId: f.state.world.id, port: 0 }, factories);
  const port = service.address().port, command = '/durable/worlds/service-world/players/one/commands';
  try {
    assert.strictEqual((await request(port, '/health/live', { token: null })).status, 200);
    assert.deepStrictEqual((await request(port, '/health/ready', { token: null })).body, { ok: true, status: 'ok' });
    assert.strictEqual(f.state.audits.length, 0, 'successful probes must not grow durable audit');
    assert.strictEqual((await request(port, command, { method: 'POST', body: { id: 'first', type: 'wait' } })).status, 202);
    ready = false;
    assert.strictEqual((await request(port, '/health/ready')).status, 503);
    assert.strictEqual((await request(port, command, { method: 'POST', body: { id: 'blocked', type: 'wait' } })).status, 503);
    assert.strictEqual(f.state.enqueues, 1);
    assert.strictEqual((await request(port, '/durable/worlds/other/players/one/state')).status, 404);
    assert.strictEqual((await request(port, '/durable/worlds/service-world/players/one/state')).status, 200, 'committed reads remain available when writer blocked');
    ready = true; f.state.dbReady = false;
    assert.strictEqual((await request(port, '/health/ready')).status, 503);
    assert.strictEqual((await request(port, '/health/live')).status, 200);
    f.state.dbReady = true;
    assert.strictEqual((await request(port, '/health/ready')).status, 200);
  } finally {
    const close = service.close(); assert.strictEqual(service.close(), close); await close;
    assert.strictEqual(runtimeCloses, 1); assert.strictEqual(await service.isReady(), false);
  }
  const busy = net.createServer(); await new Promise(resolve => busy.listen(0, '127.0.0.1', resolve));
  const collision = fixture(); let created = 0;
  try {
    await assert.rejects(createEngineService({ worldId: 'service-world', port: busy.address().port }, {
      createApi: options => createDurableCommandApiServer({ ...options, ...collision, closeStore: true }),
      createRuntime: async () => { created++; throw new Error('must not start'); },
    }), { code: 'EADDRINUSE' });
    assert.strictEqual(created, 0); assert.strictEqual(collision.state.closes, 1);
  } finally { await new Promise(resolve => busy.close(resolve)); }
  const failed = fixture(); let address;
  await assert.rejects(createEngineService({ worldId: 'service-world', port: 0 }, {
    createApi: async options => { const api = await createDurableCommandApiServer({ ...options, ...failed, closeStore: true });
      api.server.once('listening', () => { address = api.server.address(); }); return api; },
    createRuntime: async () => { throw new Error('startup failed'); },
  }), /startup failed/);
  assert.strictEqual(failed.state.closes, 1);
  const reuse = net.createServer(); await new Promise((resolve, reject) => { reuse.once('error', reject); reuse.listen(address.port, address.address, resolve); });
  await new Promise(resolve => reuse.close(resolve));
  for (const args of [[], ['--world-id'], ['--world-id', 'x', '--world-id', 'y'], ['--world-id', 'x', '--port', 'oops']]) assert.throws(() => parseArgs(args));
  assert.deepStrictEqual(parseArgs(['--world-id', 'x', '--port', '0']), { worldId: 'x', port: 0 });
  console.log('engine service lifecycle test passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
