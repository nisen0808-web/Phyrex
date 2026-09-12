'use strict';

const assert = require('assert');
const http = require('http');
const { createWorld } = require('../core/world-engine');
const { createPlayer } = require('../core/player-engine');
const { createAccount, createSession } = require('../core/account-session-engine');
const { createDurableCommandApiServer } = require('../core/durable-command-api-engine');
const { digest } = require('../storage/postgres/codec');

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function dbError(code) { const error = new Error('private database detail'); error.code = `WORLD_DB_${code}`; return error; }

function fixture() {
  const world = createWorld({ id: 'api_world', seed: 'api' });
  createPlayer(world, { id: 'player-1', name: 'One' });
  createPlayer(world, { id: 'player-2', name: 'Two' });
  createAccount(world, { id: 'account-1', roles: ['player'], playerIds: ['player-1'] });
  createAccount(world, { id: 'account-2', roles: ['player'], playerIds: ['player-2'] });
  createAccount(world, { id: 'gm-account', roles: ['gm'] });
  createSession(world, 'account-1', { token: 'token-one' });
  createSession(world, 'account-2', { token: 'token-two' });
  createSession(world, 'gm-account', { token: 'token-gm' });
  const state = { world: clone(world), revision: 7, commands: new Map(), nextSequence: 1, closes: 0, raceRevoke: false };
  const store = {
    provider: 'postgres',
    async summary() { return { provider: 'postgres', ready: true }; },
    async loadWorld(id) {
      if (id !== state.world.id) return null;
      return { worldId: id, revision: state.revision, tick: state.world.tick, world: clone(state.world), metadata: {} };
    },
    async enqueueCommand(input, options = {}) {
      if (state.raceRevoke) {
        state.raceRevoke = false;
        state.world.accounts.byId['account-1'].playerIds = [];
        delete state.world.accounts.byPlayer['player-1'];
        state.revision += 1;
        throw dbError('REVISION_CONFLICT');
      }
      if (options.expectedWorldRevision !== state.revision) throw dbError('REVISION_CONFLICT');
      const inputCopy = clone(input.input); delete inputCopy.id;
      const inputDigest = digest(inputCopy);
      const previous = state.commands.get(input.id);
      if (previous) {
        if (previous.playerId !== input.playerId || previous.inputDigest !== inputDigest) throw dbError('IDEMPOTENCY_CONFLICT');
        return { ...clone(previous), idempotent: true };
      }
      const row = { id: input.id, worldId: input.worldId, playerId: input.playerId,
        sequence: state.nextSequence++, inputDigest, status: 'pending', result: null,
        submittedAt: '2026-01-01T00:00:00.000Z', appliedAt: null };
      state.commands.set(input.id, row);
      return clone(row);
    },
    async getCommand(worldId, commandId, options = {}) {
      if (worldId !== state.world.id) return null;
      if (options.expectedWorldRevision !== state.revision) throw dbError('REVISION_CONFLICT');
      const row = state.commands.get(commandId);
      return row ? clone(row) : null;
    },
    async close() { state.closes += 1; },
  };
  return { state, store };
}

async function request(port, method, path, options = {}) {
  const body = options.body === undefined ? null : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  const headers = { ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.json !== false && body !== null && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (body !== null) headers['Content-Length'] = Buffer.byteLength(body);
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
    if (body !== null) req.write(body);
    req.end();
  });
}

async function main() {
  const f = fixture();
  const api = await createDurableCommandApiServer({ store: f.store, maxBodyBytes: 1024, rateLimitNow: () => 0 });
  const port = await new Promise(resolve => api.server.listen(0, '127.0.0.1', () => resolve(api.server.address().port)));
  try {
    let response = await request(port, 'POST', '/durable/worlds/api_world/players/player-1/commands', { body: { id: 'cmd-1', type: 'wait' } });
    assert.strictEqual(response.status, 401); assert.strictEqual(response.body.error, 'auth_required');
    assert.strictEqual(response.headers['access-control-allow-origin'], undefined);
    assert.ok(response.headers['www-authenticate']);

    response = await request(port, 'POST', '/durable/worlds/api_world/players/player-2/commands', {
      token: 'token-one', body: { id: 'cmd-other', type: 'wait' },
    });
    assert.strictEqual(response.status, 403); assert.strictEqual(response.body.error, 'player_forbidden');

    response = await request(port, 'POST', '/durable/worlds/api_world/players/player-1/commands', {
      token: 'token-one', json: false, headers: { 'Content-Type': 'text/plain' }, body: '{"id":"bad","type":"wait"}',
    });
    assert.strictEqual(response.status, 415); assert.strictEqual(response.body.error, 'json_required');

    response = await request(port, 'POST', '/durable/worlds/api_world/players/player-1/commands', {
      token: 'token-one', body: { id: 'cmd-1', type: 'wait', ticks: 1 },
    });
    assert.strictEqual(response.status, 202); assert.strictEqual(response.body.data.status, 'pending');
    assert.strictEqual(response.body.data.inputDigest, undefined); assert.strictEqual(response.body.data.input, undefined);
    assert.strictEqual(response.body.data.idempotent, false);
    assert.strictEqual(f.state.world.commands, undefined, 'HTTP enqueue must not mutate committed world snapshot');

    const exact = await request(port, 'POST', '/durable/worlds/api_world/players/player-1/commands', {
      token: 'token-one', body: { id: 'cmd-1', type: 'wait', ticks: 1 },
    });
    assert.strictEqual(exact.status, 202); assert.strictEqual(exact.body.data.idempotent, true);

    const conflict = await request(port, 'POST', '/durable/worlds/api_world/players/player-1/commands', {
      token: 'token-one', body: { id: 'cmd-1', type: 'inspect' },
    });
    assert.strictEqual(conflict.status, 409); assert.strictEqual(conflict.body.error, 'command_id_conflict');
    assert.ok(!JSON.stringify(conflict.body).includes('private database detail'));

    response = await request(port, 'GET', '/durable/worlds/api_world/commands/cmd-1', { token: 'token-two' });
    assert.strictEqual(response.status, 403); assert.strictEqual(response.body.error, 'command_forbidden');

    response = await request(port, 'GET', '/durable/worlds/api_world/commands/cmd-1', { token: 'token-one' });
    assert.strictEqual(response.status, 200); assert.strictEqual(response.body.data.status, 'pending');

    const row = f.state.commands.get('cmd-1'); row.status = 'applied'; row.result = { status: 'completed', outcome: { ok: true } };
    row.appliedAt = '2026-01-01T00:00:01.000Z';
    response = await request(port, 'GET', '/durable/worlds/api_world/commands/cmd-1', { token: 'token-one' });
    assert.strictEqual(response.status, 200); assert.strictEqual(response.body.data.status, 'applied');
    assert.deepStrictEqual(response.body.data.result.outcome, { ok: true });

    response = await request(port, 'POST', '/durable/worlds/api_world/players/player-2/commands', {
      token: 'token-gm', body: { id: 'gm-command', type: 'wait' },
    });
    assert.strictEqual(response.status, 202);

    f.state.raceRevoke = true;
    response = await request(port, 'POST', '/durable/worlds/api_world/players/player-1/commands', {
      token: 'token-one', body: { id: 'stale-auth', type: 'wait' },
    });
    assert.strictEqual(response.status, 403); assert.strictEqual(response.body.error, 'player_forbidden');
    assert.strictEqual(f.state.commands.has('stale-auth'), false, 'stale authorization must never enqueue after revision change');

    response = await request(port, 'POST', '/durable/worlds/api_world/players/player-2/commands', {
      token: 'token-two', body: { id: 'large', type: 'wait', text: 'x'.repeat(2000) },
    });
    assert.strictEqual(response.status, 413); assert.strictEqual(response.body.error, 'request_body_too_large');

    response = await request(port, 'GET', '/durable/worlds/api_world/commands/missing', { token: 'token-gm' });
    assert.strictEqual(response.status, 404); assert.strictEqual(response.body.error, 'command_not_found');

    console.log('durable command api test passed');
  } finally {
    await api.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
