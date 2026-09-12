'use strict';

const assert = require('assert');
const http = require('http');
const { createWorld } = require('../core/world-engine');
const { createPlayer } = require('../core/player-engine');
const { createAccount, createSession } = require('../core/account-session-engine');
const { createDurableCommandApiServer } = require('../core/durable-command-api-engine');

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function fixture() {
  const world = createWorld({ id: 'audit_world', seed: 'audit' });
  createPlayer(world, { id: 'player-1' });
  createAccount(world, { id: 'account-1', roles: ['player'], playerIds: ['player-1'] });
  createSession(world, 'account-1', { token: 'audit-token' });
  const commands = new Map();
  const store = {
    provider: 'postgres',
    async summary() { return {}; },
    async loadWorld(id) { return id === world.id ? { world: clone(world), worldId: id, revision: 1, tick: world.tick } : null; },
    async enqueueCommand(input) {
      const row = { id: input.id, worldId: input.worldId, playerId: input.playerId, sequence: commands.size + 1,
        status: 'pending', result: null, submittedAt: 'now', appliedAt: null };
      commands.set(input.id, row); return clone(row);
    },
    async getCommand(_worldId, id) { return commands.has(id) ? clone(commands.get(id)) : null; },
    async close() {},
  };
  const records = [];
  const auditStore = {
    provider: 'postgres',
    async summary() { return { records: records.length }; },
    async append(row) { records.push(clone(row)); return row; },
    async close() {},
  };
  return { world, store, auditStore, records };
}
async function listen(server) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); }); }
async function request(port, method, path, options = {}) {
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const headers = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode,
        headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}
async function main() {
  const f = fixture(); let nextId = 0;
  const api = await createDurableCommandApiServer({ store: f.store, auditStore: f.auditStore, rateLimitNow: () => 0,
    requestIdFactory: () => `req-${++nextId}` });
  const port = await listen(api.server);
  try {
    let response = await request(port, 'POST', '/durable/worlds/audit_world/players/player-1/commands', {
      token: 'audit-token', body: { id: 'cmd-1', type: 'wait' },
    });
    assert.strictEqual(response.status, 202);
    assert.strictEqual(response.headers['x-request-id'], 'req-1');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(f.records[0], {
      requestId: 'req-1', method: 'POST', route: 'submit', worldId: 'audit_world', accountId: 'account-1',
      playerId: 'player-1', commandId: 'cmd-1', statusCode: 202, errorCode: null,
    });

    response = await request(port, 'GET', '/durable/worlds/audit_world/commands/cmd-1');
    assert.strictEqual(response.status, 401);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(f.records[1].requestId, 'req-2');
    assert.strictEqual(f.records[1].statusCode, 401);
    assert.strictEqual(f.records[1].errorCode, 'auth_required');
    assert.strictEqual(f.records[1].accountId, null);
    assert.ok(!JSON.stringify(f.records).includes('audit-token'));
    assert.ok(!JSON.stringify(f.records).includes('type')); // raw command body is never audited

    const failingAudit = { provider: 'postgres', async summary() { return {}; }, async append() { throw new Error('audit offline'); }, async close() {} };
    const api2 = await createDurableCommandApiServer({ store: f.store, auditStore: failingAudit, rateLimitNow: () => 0,
      requestIdFactory: () => 'failed-audit' });
    const port2 = await listen(api2.server);
    const success = await request(port2, 'POST', '/durable/worlds/audit_world/players/player-1/commands', {
      token: 'audit-token', body: { id: 'cmd-2', type: 'wait' },
    });
    assert.strictEqual(success.status, 202);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(api2.auditStats().failures, 1);
    await api2.close();
    console.log('durable command audit test passed');
  } finally { await api.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
