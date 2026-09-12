'use strict';

const assert = require('assert');
const http = require('http');
const { createWorld } = require('../core/world-engine');
const { createPlayer } = require('../core/player-engine');
const { createAccount, createSession } = require('../core/account-session-engine');
const { createDurableCommandApiServer } = require('../core/durable-command-api-engine');
const { digest } = require('../storage/postgres/codec');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function fixture() {
  const world = createWorld({ id: 'rate_world', seed: 'rate' });
  createPlayer(world, { id: 'player-1' });
  createAccount(world, { id: 'account-1', roles: ['player'], playerIds: ['player-1'] });
  createSession(world, 'account-1', { token: 'rate-token' });
  const state = { world: clone(world), revision: 1, commands: new Map(), sequence: 1 };
  const store = {
    provider: 'postgres',
    async summary() { return { ready: true }; },
    async loadWorld(id) {
      return id === state.world.id
        ? { worldId: id, revision: state.revision, tick: state.world.tick, world: clone(state.world), metadata: {} }
        : null;
    },
    async enqueueCommand(input, options = {}) {
      assert.strictEqual(options.expectedWorldRevision, state.revision);
      const commandInput = clone(input.input); delete commandInput.id;
      const row = { id: input.id, worldId: input.worldId, playerId: input.playerId, sequence: state.sequence++,
        inputDigest: digest(commandInput), status: 'pending', result: null, submittedAt: null, appliedAt: null };
      state.commands.set(input.id, row); return clone(row);
    },
    async getCommand(worldId, commandId, options = {}) {
      assert.strictEqual(options.expectedWorldRevision, state.revision);
      const row = state.commands.get(commandId); return worldId === state.world.id && row ? clone(row) : null;
    },
    async close() {},
  };
  return { state, store };
}

function request(port, method, path, options = {}) {
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const headers = { ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (body !== null) req.end(body); else req.end();
  });
}

async function listen(api) {
  return new Promise(resolve => api.server.listen(0, '127.0.0.1', () => resolve(api.server.address().port)));
}

async function main() {
  {
    let now = 1000;
    const f = fixture();
    const api = await createDurableCommandApiServer({
      store: f.store,
      sourceRateLimit: 100,
      accountSubmitRateLimit: 1,
      accountReadRateLimit: 100,
      rateLimitWindowMs: 1000,
      rateLimitNow: () => now,
    });
    const port = await listen(api);
    try {
      let response = await request(port, 'POST', '/durable/worlds/rate_world/players/player-1/commands', {
        token: 'rate-token', body: { id: 'first', type: 'wait' },
      });
      assert.strictEqual(response.status, 202);
      response = await request(port, 'POST', '/durable/worlds/rate_world/players/player-1/commands', {
        token: 'rate-token', body: { id: 'second', type: 'wait' },
      });
      assert.strictEqual(response.status, 429); assert.strictEqual(response.body.error, 'rate_limited');
      assert.strictEqual(response.headers['retry-after'], '1');
      assert.strictEqual(f.state.commands.has('second'), false);
      now += 1000;
      response = await request(port, 'POST', '/durable/worlds/rate_world/players/player-1/commands', {
        token: 'rate-token', body: { id: 'third', type: 'wait' },
      });
      assert.strictEqual(response.status, 202);
      assert.strictEqual(api.rateLimitStats().trackedSubmitAccounts, 1);
    } finally { await api.close(); }
  }

  {
    const f = fixture();
    const api = await createDurableCommandApiServer({ store: f.store, sourceRateLimit: 2, accountSubmitRateLimit: 100, accountReadRateLimit: 100 });
    const port = await listen(api);
    try {
      const path = '/durable/worlds/rate_world/commands/missing';
      let response = await request(port, 'GET', path);
      assert.strictEqual(response.status, 401);
      response = await request(port, 'GET', path, { headers: { 'X-Forwarded-For': '203.0.113.10' } });
      assert.strictEqual(response.status, 401);
      response = await request(port, 'GET', path, { headers: { 'X-Forwarded-For': '198.51.100.99' } });
      assert.strictEqual(response.status, 429); assert.strictEqual(response.body.error, 'rate_limited');
      assert.ok(Number(response.headers['retry-after']) >= 1);
    } finally { await api.close(); }
  }

  console.log('durable command api rate limit test passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
