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
  const world = createWorld({ id: 'audit_world', seed: 'audit' });
  createPlayer(world, { id: 'player-1' });
  createPlayer(world, { id: 'player-2' });
  createAccount(world, { id: 'account-1', roles: ['player'], playerIds: ['player-1'] });
  createAccount(world, { id: 'account-2', roles: ['player'], playerIds: ['player-2'] });
  createSession(world, 'account-1', { token: 'token-one' });
  createSession(world, 'account-2', { token: 'token-two' });
  const state = {
    world: clone(world), revision: 3, commands: new Map(), audits: [], nextSequence: 1,
    failAuditOutcome: null,
  };

  function appendAudit(input) {
    if (state.failAuditOutcome && input.outcome === state.failAuditOutcome) throw dbError('UNAVAILABLE');
    const row = { sequence: state.audits.length + 1, ...clone(input) };
    state.audits.push(row);
    return clone(row);
  }

  const store = {
    provider: 'postgres',
    async summary() { return { provider: 'postgres', ready: true }; },
    async loadWorld(id) {
      if (id !== state.world.id) return null;
      return { worldId: id, revision: state.revision, tick: state.world.tick, world: clone(state.world), metadata: {} };
    },
    async enqueueCommand(input, options = {}) {
      if (options.expectedWorldRevision !== state.revision) throw dbError('REVISION_CONFLICT');
      const commandInput = clone(input.input); delete commandInput.id;
      const inputDigest = digest(commandInput);
      const previous = state.commands.get(input.id);
      let row;
      let outcome;
      if (previous) {
        if (previous.playerId !== input.playerId || previous.inputDigest !== inputDigest) throw dbError('IDEMPOTENCY_CONFLICT');
        row = { ...clone(previous), idempotent: true };
        outcome = previous.status === 'applied' ? 'idempotent_applied' : 'idempotent_pending';
      } else {
        row = { id: input.id, worldId: input.worldId, playerId: input.playerId,
          sequence: state.nextSequence, inputDigest, status: 'pending', result: null,
          submittedAt: '2026-01-01T00:00:00.000Z', appliedAt: null, idempotent: false };
        outcome = 'enqueued';
      }
      if (options.audit) {
        appendAudit({
          worldId: input.worldId,
          accountId: options.audit.accountId,
          playerId: input.playerId,
          commandId: input.id,
          commandSequence: row.sequence,
          method: 'POST', route: 'command.submit',
          statusCode: row.status === 'applied' ? 200 : 202,
          outcome,
        });
      }
      if (!previous) {
        state.nextSequence += 1;
        state.commands.set(input.id, clone(row));
      }
      return clone(row);
    },
    async getCommand(worldId, commandId, options = {}) {
      if (options.expectedWorldRevision !== state.revision) throw dbError('REVISION_CONFLICT');
      const row = state.commands.get(commandId);
      return worldId === state.world.id && row ? clone(row) : null;
    },
    async appendCommandApiAudit(input) { return appendAudit(input); },
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

async function main() {
  const f = fixture();
  const api = await createDurableCommandApiServer({
    store: f.store,
    sourceRateLimit: 100,
    accountSubmitRateLimit: 100,
    accountReadRateLimit: 100,
    rateLimitNow: () => 0,
  });
  const port = await new Promise(resolve => api.server.listen(0, '127.0.0.1', () => resolve(api.server.address().port)));
  try {
    let response = await request(port, 'POST', '/durable/worlds/audit_world/players/player-1/commands', {
      body: { id: 'anonymous', type: 'wait', secret: 'must-not-audit' },
    });
    assert.strictEqual(response.status, 401);
    assert.strictEqual(f.state.audits.length, 0, 'anonymous failures must not create durable audit writes');

    response = await request(port, 'POST', '/durable/worlds/audit_world/players/player-1/commands', {
      token: 'token-one', body: { id: 'cmd-1', type: 'wait', secret: 'must-not-audit' },
    });
    assert.strictEqual(response.status, 202);
    assert.strictEqual(f.state.audits.length, 1);
    assert.deepStrictEqual(f.state.audits[0], {
      sequence: 1, worldId: 'audit_world', accountId: 'account-1', playerId: 'player-1',
      commandId: 'cmd-1', commandSequence: 1, method: 'POST', route: 'command.submit',
      statusCode: 202, outcome: 'enqueued',
    });
    assert.ok(!JSON.stringify(f.state.audits).includes('must-not-audit'));
    assert.ok(!JSON.stringify(f.state.audits).includes('token-one'));
    assert.ok(!JSON.stringify(f.state.audits).includes('inputDigest'));

    response = await request(port, 'POST', '/durable/worlds/audit_world/players/player-1/commands', {
      token: 'token-one', body: { id: 'cmd-1', type: 'wait', secret: 'must-not-audit' },
    });
    assert.strictEqual(response.status, 202);
    assert.strictEqual(f.state.audits.at(-1).outcome, 'idempotent_pending');

    response = await request(port, 'POST', '/durable/worlds/audit_world/players/player-1/commands', {
      token: 'token-one', body: { id: 'cmd-1', type: 'inspect' },
    });
    assert.strictEqual(response.status, 409);
    assert.strictEqual(f.state.audits.at(-1).outcome, 'command_id_conflict');
    assert.strictEqual(f.state.audits.at(-1).statusCode, 409);

    response = await request(port, 'GET', '/durable/worlds/audit_world/commands/cmd-1', { token: 'token-two' });
    assert.strictEqual(response.status, 403);
    assert.strictEqual(f.state.audits.at(-1).accountId, 'account-2');
    assert.strictEqual(f.state.audits.at(-1).outcome, 'command_forbidden');

    response = await request(port, 'GET', '/durable/worlds/audit_world/commands/cmd-1', { token: 'token-one' });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(f.state.audits.at(-1).outcome, 'read_pending');
    assert.strictEqual(f.state.audits.at(-1).commandSequence, 1);

    response = await request(port, 'GET', '/durable/worlds/audit_world/commands/missing', { token: 'token-one' });
    assert.strictEqual(response.status, 404);
    assert.strictEqual(f.state.audits.at(-1).outcome, 'command_not_found');

    response = await request(port, 'POST', '/durable/worlds/audit_world/players/missing/commands', {
      token: 'token-one', body: { id: 'missing-player-command', type: 'wait' },
    });
    assert.strictEqual(response.status, 404);
    assert.strictEqual(f.state.audits.at(-1).outcome, 'player_not_found');

    const row = f.state.commands.get('cmd-1');
    row.status = 'applied'; row.result = { status: 'completed', outcome: { ok: true } }; row.appliedAt = '2026-01-01T00:00:01.000Z';
    response = await request(port, 'GET', '/durable/worlds/audit_world/commands/cmd-1', { token: 'token-one' });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(f.state.audits.at(-1).outcome, 'read_applied');

    const beforeFailedAudit = f.state.audits.length;
    f.state.failAuditOutcome = 'read_applied';
    response = await request(port, 'GET', '/durable/worlds/audit_world/commands/cmd-1', { token: 'token-one' });
    assert.strictEqual(response.status, 503, 'successful command data must not be returned when required audit write fails');
    assert.strictEqual(response.body.error, 'service_unavailable');
    assert.strictEqual(f.state.audits.length, beforeFailedAudit);
    f.state.failAuditOutcome = null;

    const beforeInvalidBody = f.state.audits.length;
    response = await request(port, 'POST', '/durable/worlds/audit_world/players/player-1/commands', {
      token: 'token-one', body: { id: 'missing-type' },
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(f.state.audits.length, beforeInvalidBody, 'pre-auth command validation does not create durable audit writes');

    console.log('durable command api audit test passed');
  } finally {
    await api.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
