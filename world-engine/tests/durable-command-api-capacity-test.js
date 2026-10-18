'use strict';
const assert = require('assert');
const http = require('http');
const net = require('net');
const { once } = require('events');
const { setImmediate: turn } = require('timers/promises');
const { createDurableCommandApiServer } = require('../core/durable-command-api-engine');
const { commandApiOptions } = require('../demo/durable-command-api-server');
const { fixture } = require('./helpers/service-fixture');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await turn(); }
  assert.fail('capacity operation did not settle');
}
function request(port, path, { method = 'GET', body, token = 'owner-secret-token' } = {}) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false, headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(text ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } : {}),
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(text);
  });
}
async function open(f, options = {}) {
  const api = await createDurableCommandApiServer({ ...f, rateLimitNow: () => 0,
    sourceRateLimit: 1000, closeStore: true, ...options });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening');
  return { api, port: api.server.address().port };
}
const stateRoute = '/durable/worlds/service-world/players/one/state';
const commandRoute = '/durable/worlds/service-world/players/one/commands';

async function main() {
  for (const value of [0, -1, 1.5, NaN, Infinity, 10001]) {
    const f = fixture();
    await assert.rejects(createDurableCommandApiServer({ ...f, rateLimitNow: () => 0,
      maxInFlightRequests: value }), /invalid_maxInFlightRequests/);
    assert.strictEqual(f.state.closes, 0, 'invalid capacity fails before taking store ownership');
  }
  assert.strictEqual(commandApiOptions({}, { WORLD_ENGINE_COMMAND_API_MAX_IN_FLIGHT_REQUESTS: '7' }).maxInFlightRequests, 7);

  // Retain two actual HTTP requests at authorization, then exercise overload.
  {
    const f = fixture(), gate = deferred(); let loads = 0;
    const original = f.store.loadWorld;
    f.store.loadWorld = async id => { loads++; await gate.promise; return original(id); };
    const { api, port } = await open(f, { maxInFlightRequests: 2, health: async () => true });
    const first = request(port, stateRoute), second = request(port, stateRoute);
    try {
      await until(() => loads === 2);
      const full = await request(port, commandRoute, { method: 'POST', body: { id: 'not-accepted', type: 'wait' } });
      assert.strictEqual(full.status, 503);
      assert.deepStrictEqual(full.body, { ok: false, error: 'service_unavailable' });
      assert.strictEqual(full.headers['retry-after'], '1');
      assert.strictEqual(full.headers.connection, 'close');
      assert.ok(full.headers['x-request-id']);
      assert.strictEqual(full.headers['cache-control'], 'no-store');
      assert.strictEqual(loads, 2); assert.strictEqual(f.state.enqueues, 0);
      assert.strictEqual(f.state.audits.length, 0, 'overload must not enqueue another audit');
      assert.strictEqual((await request(port, '/health/live')).status, 200);
      assert.strictEqual((await request(port, '/health/ready')).status, 503);
      assert.deepStrictEqual(api.requestStats(), { inFlight: 2, limit: 2, rejected: 2 });
      gate.resolve();
      assert.strictEqual((await first).status, 200); assert.strictEqual((await second).status, 200);
      await until(() => api.requestStats().inFlight === 0);
      const operations = await request(port, '/durable/worlds/service-world/admin/operations', { token: 'admin-secret-token' });
      assert.strictEqual(operations.body.data.requests.limit, 2);
      assert.strictEqual(operations.body.data.requests.rejected, 2);
      assert.strictEqual(operations.body.data.requests.inFlight, 1, 'diagnostic includes its own live request');
      assert.strictEqual(api.options.maxInFlightRequests, 2);
    } finally { gate.resolve(); await Promise.allSettled([first, second]); await api.close(); }
  }

  // A delivered result retains capacity until its independent audit finishes.
  {
    const f = fixture(), gate = deferred(), started = deferred(); let block = true, appends = 0;
    const rows = new Map();
    f.store.enqueueCommand = async input => {
      if (rows.has(input.id)) return { ...rows.get(input.id), idempotent: true };
      f.state.enqueues++;
      const row = { ...input, sequence: 1, status: 'pending' }; rows.set(input.id, row); return row;
    };
    f.auditStore.append = async row => { appends++; if (block) { started.resolve(); await gate.promise; } f.state.audits.push(row); };
    const { api, port } = await open(f, { maxInFlightRequests: 1 });
    try {
      const body = { id: 'same-command', type: 'wait' };
      assert.strictEqual((await request(port, commandRoute, { method: 'POST', body })).status, 202);
      await started.promise;
      assert.strictEqual((await request(port, commandRoute, { method: 'POST', body })).status, 503);
      assert.strictEqual(f.state.enqueues, 1); assert.strictEqual(appends, 1);
      block = false; gate.resolve(); await until(() => api.requestStats().inFlight === 0);
      const retry = await request(port, commandRoute, { method: 'POST', body });
      assert.strictEqual(retry.status, 202); assert.strictEqual(retry.body.data.idempotent, true);
      assert.strictEqual(f.state.enqueues, 1, 'same-ID recovery must not execute a second submission');
      await until(() => api.requestStats().inFlight === 0);
      f.auditStore.append = async () => { throw new Error('private database failure'); };
      assert.strictEqual((await request(port, stateRoute)).status, 200);
      await until(() => api.requestStats().inFlight === 0);
      assert.strictEqual(api.auditStats().failures, 1);
      assert.strictEqual((await request(port, stateRoute, { token: null })).status, 401);
      await until(() => api.requestStats().inFlight === 0);
    } finally { gate.resolve(); await api.close(); }
  }

  // Partial uploads reserve a slot and a disconnected uploader releases it.
  {
    const f = fixture(); const { api, port } = await open(f, { maxInFlightRequests: 1 });
    const socket = net.connect(port, '127.0.0.1');
    try {
      await once(socket, 'connect');
      socket.write('POST ' + commandRoute + ' HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{');
      await until(() => api.requestStats().inFlight === 1);
      assert.strictEqual((await request(port, stateRoute)).status, 503);
      socket.destroy(); await until(() => api.requestStats().inFlight === 0);
      assert.strictEqual((await request(port, stateRoute)).status, 200);
    } finally { socket.destroy(); await api.close(); }
  }

  // Source limits still apply to overload and liveness; no bypass via health.
  {
    const f = fixture(), gate = deferred(); let loads = 0;
    const original = f.store.loadWorld;
    f.store.loadWorld = async id => { loads++; await gate.promise; return original(id); };
    const { api, port } = await open(f, { maxInFlightRequests: 1, sourceRateLimit: 2, health: async () => true });
    const pending = request(port, stateRoute);
    try {
      await until(() => loads === 1);
      assert.strictEqual((await request(port, stateRoute)).status, 503);
      const limited = await request(port, '/health/live');
      assert.strictEqual(limited.status, 429); assert.strictEqual(limited.body.error, 'rate_limited');
      assert.strictEqual(api.requestStats().rejected, 1);
    } finally { gate.resolve(); await pending; await api.close(); }
  }
  console.log('durable command api capacity test passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
