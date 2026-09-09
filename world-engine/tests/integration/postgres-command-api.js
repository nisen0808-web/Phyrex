'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { Pool } = require('pg');
const { createWorld } = require('../../core/world-engine');
const { createPlayer } = require('../../core/player-engine');
const { createAccount, createSession } = require('../../core/account-session-engine');
const { createPostgresDatabaseStore } = require('../../storage/postgres/store');
const { createDurableWorldRuntime } = require('../../runtime/durable-world-runtime');
const { createDurableCommandApiServer } = require('../../core/durable-command-api-engine');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

async function request(port, method, path, options = {}) {
  const body = options.body === undefined ? null : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  const headers = { ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (body !== null && options.contentType !== false && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
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

async function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

async function main() {
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  if (!connectionString) throw new Error('WORLD_ENGINE_TEST_DATABASE_URL is required; integration tests never silently skip');
  assert.ok(/_(ci|test)$/.test(new URL(connectionString).pathname), 'Tests require an explicitly named _ci or _test database');
  const schema = `test_command_api_${crypto.randomBytes(8).toString('hex')}`;
  const quoted = `"${schema}"`;
  const store = createPostgresDatabaseStore({ connectionString, schema });
  const raw = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
  let api = null, raceApi = null, runtime = null;
  let groups = 0;
  const pass = name => { groups += 1; console.log(`PASS ${name}`); };
  try {
    await store.migrate();
    const world = createWorld({ id: 'command_api_world', seed: 'command-api' });
    createPlayer(world, { id: 'player-1', name: 'One' });
    createPlayer(world, { id: 'player-2', name: 'Two' });
    createAccount(world, { id: 'account-1', roles: ['player'], playerIds: ['player-1'] });
    createAccount(world, { id: 'account-2', roles: ['player'], playerIds: ['player-2'] });
    createAccount(world, { id: 'gm-account', roles: ['gm'] });
    createSession(world, 'account-1', { token: 'sql-token-one' });
    createSession(world, 'account-2', { token: 'sql-token-two' });
    createSession(world, 'gm-account', { token: 'sql-token-gm' });
    await store.saveWorld(world, { expectedRevision: 0, requestId: 'seed:command-api' });

    api = await createDurableCommandApiServer({ store, maxBodyBytes: 2048 });
    const port = await listen(api.server);

    let response = await request(port, 'POST', '/durable/worlds/command_api_world/players/player-1/commands', {
      body: { id: 'owner-command', type: 'wait', ticks: 1 },
    });
    assert.strictEqual(response.status, 401);
    assert.strictEqual(response.body.error, 'auth_required');
    assert.strictEqual(response.headers['access-control-allow-origin'], undefined);
    pass('bearer authentication is mandatory and CORS is not implicitly opened');

    response = await request(port, 'POST', '/durable/worlds/command_api_world/players/player-2/commands', {
      token: 'sql-token-one', body: { id: 'cross-player', type: 'wait' },
    });
    assert.strictEqual(response.status, 403);
    response = await request(port, 'POST', '/durable/worlds/command_api_world/players/player-2/commands', {
      token: 'sql-token-gm', body: { id: 'gm-command', type: 'wait' },
    });
    assert.strictEqual(response.status, 202);
    pass('player accounts are ownership-scoped while GM authorization may submit for another existing player');

    response = await request(port, 'POST', '/durable/worlds/command_api_world/players/player-1/commands', {
      token: 'sql-token-one', body: { id: 'owner-command', type: 'wait', ticks: 1 },
    });
    assert.strictEqual(response.status, 202);
    assert.strictEqual(response.body.data.status, 'pending');
    assert.strictEqual(response.body.data.input, undefined);
    assert.strictEqual(response.body.data.inputDigest, undefined);
    const duplicate = await request(port, 'POST', '/durable/worlds/command_api_world/players/player-1/commands', {
      token: 'sql-token-one', body: { id: 'owner-command', type: 'wait', ticks: 1 },
    });
    assert.strictEqual(duplicate.status, 202);
    assert.strictEqual(duplicate.body.data.idempotent, true);
    const collision = await request(port, 'POST', '/durable/worlds/command_api_world/players/player-1/commands', {
      token: 'sql-token-one', body: { id: 'owner-command', type: 'inspect' },
    });
    assert.strictEqual(collision.status, 409);
    assert.strictEqual(collision.body.error, 'command_id_conflict');
    pass('HTTP ingress preserves command idempotency and does not expose internal digests');

    response = await request(port, 'GET', '/durable/worlds/command_api_world/commands/owner-command', { token: 'sql-token-two' });
    assert.strictEqual(response.status, 403);
    response = await request(port, 'GET', '/durable/worlds/command_api_world/commands/owner-command', { token: 'sql-token-one' });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.data.status, 'pending');
    pass('command status polling enforces ownership from the latest committed world');

    const beforeRuntime = await store.loadWorld('command_api_world');
    assert.strictEqual(beforeRuntime.world.commands?.byId?.['owner-command'], undefined);
    runtime = await createDurableWorldRuntime({ worldId: 'command_api_world', store });
    const committed = await runtime.step();
    assert.strictEqual(committed.commands, 2);
    const afterRuntime = await store.loadWorld('command_api_world');
    assert.strictEqual(afterRuntime.world.commands.byId['owner-command'].status, 'completed');
    response = await request(port, 'GET', '/durable/worlds/command_api_world/commands/owner-command', { token: 'sql-token-one' });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.data.status, 'applied');
    assert.strictEqual(response.body.data.result.status, 'completed');
    pass('HTTP enqueue never mutates live world; durable runtime execution changes visibility only after SQL checkpoint commit');

    response = await request(port, 'POST', '/durable/worlds/command_api_world/players/player-1/commands', {
      token: 'sql-token-one', body: { id: 'owner-command', type: 'wait', ticks: 1 },
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.data.status, 'applied');
    assert.strictEqual(response.body.data.idempotent, true);
    pass('reposting an already applied identical command returns its durable terminal result without replay');

    const oldRevision = (await store.loadWorld('command_api_world')).revision;
    const advanced = await store.loadWorld('command_api_world');
    advanced.world.meta = { ...(advanced.world.meta || {}), revisionFenceProbe: true };
    await store.saveWorld(advanced.world, { expectedRevision: advanced.revision, requestId: 'revision-fence-probe' });
    await assert.rejects(store.enqueueCommand({ worldId: 'command_api_world', id: 'stale-direct', playerId: 'player-1', input: { type: 'wait' } },
      { expectedWorldRevision: oldRevision }), error => error.code === 'WORLD_DB_REVISION_CONFLICT');
    await assert.rejects(store.getCommand('command_api_world', 'owner-command', { expectedWorldRevision: oldRevision }),
      error => error.code === 'WORLD_DB_REVISION_CONFLICT');
    pass('PostgreSQL command ingress and reads reject stale authorization revisions');

    let injectRevocation = true;
    const racingStore = {
      ...store,
      async enqueueCommand(input, options) {
        if (injectRevocation) {
          injectRevocation = false;
          const latest = await store.loadWorld('command_api_world');
          latest.world.accounts.byId['account-1'].playerIds = [];
          delete latest.world.accounts.byPlayer['player-1'];
          await store.saveWorld(latest.world, { expectedRevision: latest.revision, requestId: 'revoke-player-ownership' });
        }
        return store.enqueueCommand(input, options);
      },
    };
    raceApi = await createDurableCommandApiServer({ store: racingStore });
    const racePort = await listen(raceApi.server);
    response = await request(racePort, 'POST', '/durable/worlds/command_api_world/players/player-1/commands', {
      token: 'sql-token-one', body: { id: 'stale-auth-command', type: 'wait' },
    });
    assert.strictEqual(response.status, 403);
    assert.strictEqual(response.body.error, 'player_forbidden');
    assert.strictEqual(await store.getCommand('command_api_world', 'stale-auth-command'), null);
    pass('authorization revision race reloads the new checkpoint and cannot enqueue after ownership revocation');

    response = await request(port, 'POST', '/durable/worlds/command_api_world/players/player-2/commands', {
      token: 'sql-token-two', contentType: false, headers: { 'Content-Type': 'text/plain' }, body: '{}',
    });
    assert.strictEqual(response.status, 415);
    response = await request(port, 'GET', '/durable/worlds/command_api_world/commands/does-not-exist', { token: 'sql-token-gm' });
    assert.strictEqual(response.status, 404);
    assert.ok(!JSON.stringify(response.body).includes(connectionString));
    pass('HTTP validation and error responses remain bounded and redact database connection details');

    console.log(`postgres command api completed ${groups} scenario groups: ${groups} passed, 0 failed`);
  } finally {
    if (raceApi) await raceApi.close().catch(() => {});
    if (api) await api.close().catch(() => {});
    if (runtime) await runtime.close({ flush: false }).catch(() => {});
    await store.close().catch(() => {});
    await raw.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => {});
    await raw.end().catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
