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
const { MIGRATIONS } = require('../../storage/postgres/migrations');

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

function listen(server) {
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
  const schema = `test_command_api_audit_${crypto.randomBytes(8).toString('hex')}`;
  const quoted = `"${schema}"`;
  const store = createPostgresDatabaseStore({ connectionString, schema });
  const raw = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
  let api = null, limitedApi = null, runtime = null;
  let groups = 0;
  const pass = name => { groups += 1; console.log(`PASS ${name}`); };
  try {
    const migrated = await store.migrate();
    assert.strictEqual(migrated.version, MIGRATIONS.length);
    assert.strictEqual(MIGRATIONS.length, 3);
    assert.strictEqual((await store.summary()).commandApiAudits, 0);
    pass('Migration 3 creates the durable command API audit ledger');

    const world = createWorld({ id: 'audit_sql_world', seed: 'audit-sql' });
    createPlayer(world, { id: 'player-1' });
    createPlayer(world, { id: 'player-2' });
    createAccount(world, { id: 'account-1', roles: ['player'], playerIds: ['player-1'] });
    createAccount(world, { id: 'account-2', roles: ['player'], playerIds: ['player-2'] });
    createAccount(world, { id: 'gm-account', roles: ['gm'] });
    createSession(world, 'account-1', { token: 'audit-token-one' });
    createSession(world, 'account-2', { token: 'audit-token-two' });
    createSession(world, 'gm-account', { token: 'audit-token-gm' });
    await store.saveWorld(world, { expectedRevision: 0, requestId: 'seed:audit-sql-world' });
    api = await createDurableCommandApiServer({ store, rateLimitNow: () => 0 });
    const port = await listen(api.server);

    let response = await request(port, 'POST', '/durable/worlds/audit_sql_world/players/player-1/commands', {
      token: 'audit-token-one', body: { id: 'submit-1', type: 'wait', note: 'raw-secret-must-not-audit' },
    });
    assert.strictEqual(response.status, 202);
    const command = await store.getCommand('audit_sql_world', 'submit-1');
    let audits = await store.listCommandApiAudits({ worldId: 'audit_sql_world', commandId: 'submit-1', order: 'asc' });
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(audits[0].accountId, 'account-1');
    assert.strictEqual(audits[0].playerId, 'player-1');
    assert.strictEqual(audits[0].commandSequence, command.sequence);
    assert.strictEqual(audits[0].statusCode, 202);
    assert.strictEqual(audits[0].outcome, 'enqueued');
    const serialized = JSON.stringify(audits);
    for (const forbidden of ['audit-token-one', 'raw-secret-must-not-audit', 'inputDigest', '127.0.0.1', connectionString]) {
      assert.ok(!serialized.includes(forbidden));
    }
    pass('successful POST persists only safe audit metadata with the durable command sequence');

    response = await request(port, 'POST', '/durable/worlds/audit_sql_world/players/player-1/commands', {
      token: 'audit-token-one', body: { id: 'submit-1', type: 'wait', note: 'raw-secret-must-not-audit' },
    });
    assert.strictEqual(response.status, 202);
    response = await request(port, 'POST', '/durable/worlds/audit_sql_world/players/player-1/commands', {
      token: 'audit-token-one', body: { id: 'submit-1', type: 'inspect' },
    });
    assert.strictEqual(response.status, 409);
    audits = await store.listCommandApiAudits({ worldId: 'audit_sql_world', commandId: 'submit-1', order: 'asc' });
    assert.deepStrictEqual(audits.map(row => row.outcome), ['enqueued', 'idempotent_pending', 'command_id_conflict']);
    assert.strictEqual((await store.listCommands({ worldId: 'audit_sql_world', playerId: 'player-1' })).length, 1);
    pass('idempotent retry and command-ID conflict each produce bounded durable audit rows without duplicating the command');

    response = await request(port, 'GET', '/durable/worlds/audit_sql_world/commands/submit-1', { token: 'audit-token-one' });
    assert.strictEqual(response.status, 200); assert.strictEqual(response.body.data.status, 'pending');
    response = await request(port, 'GET', '/durable/worlds/audit_sql_world/commands/submit-1', { token: 'audit-token-two' });
    assert.strictEqual(response.status, 403);
    response = await request(port, 'GET', '/durable/worlds/audit_sql_world/commands/missing', { token: 'audit-token-gm' });
    assert.strictEqual(response.status, 404);
    const reads = await store.listCommandApiAudits({ worldId: 'audit_sql_world', route: 'command.status', order: 'asc' });
    assert.deepStrictEqual(reads.map(row => row.outcome), ['read_pending', 'command_forbidden', 'command_not_found']);
    assert.deepStrictEqual(reads.map(row => row.accountId), ['account-1', 'account-2', 'gm-account']);
    pass('successful and authenticated denied GET operations are audited before response with the acting account');

    runtime = await createDurableWorldRuntime({ worldId: 'audit_sql_world', store });
    assert.strictEqual((await runtime.step()).commands, 1);
    response = await request(port, 'GET', '/durable/worlds/audit_sql_world/commands/submit-1', { token: 'audit-token-one' });
    assert.strictEqual(response.status, 200); assert.strictEqual(response.body.data.status, 'applied');
    response = await request(port, 'POST', '/durable/worlds/audit_sql_world/players/player-1/commands', {
      token: 'audit-token-one', body: { id: 'submit-1', type: 'wait', note: 'raw-secret-must-not-audit' },
    });
    assert.strictEqual(response.status, 200); assert.strictEqual(response.body.data.idempotent, true);
    audits = await store.listCommandApiAudits({ worldId: 'audit_sql_world', commandId: 'submit-1', order: 'asc' });
    assert.ok(audits.some(row => row.outcome === 'read_applied'));
    assert.strictEqual(audits.at(-1).outcome, 'idempotent_applied');
    pass('applied command reads and terminal idempotent reposts remain durably attributable without replay');

    await raw.query(`CREATE FUNCTION ${quoted}.reject_submit_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.command_id='rollback-command' AND NEW.outcome='enqueued' THEN RAISE EXCEPTION 'intentional audit rejection'; END IF; RETURN NEW; END $$`);
    await raw.query(`CREATE TRIGGER reject_submit_audit BEFORE INSERT ON ${quoted}.command_api_audit FOR EACH ROW EXECUTE FUNCTION ${quoted}.reject_submit_audit()`);
    const beforeRollback = await store.summary();
    response = await request(port, 'POST', '/durable/worlds/audit_sql_world/players/player-1/commands', {
      token: 'audit-token-one', body: { id: 'rollback-command', type: 'wait' },
    });
    assert.strictEqual(response.status, 500); assert.strictEqual(response.body.error, 'internal_error');
    assert.strictEqual(await store.getCommand('audit_sql_world', 'rollback-command'), null);
    const afterRollback = await store.summary();
    assert.strictEqual(afterRollback.commands, beforeRollback.commands);
    assert.strictEqual(afterRollback.commandApiAudits, beforeRollback.commandApiAudits);
    await raw.query(`DROP TRIGGER reject_submit_audit ON ${quoted}.command_api_audit`);
    pass('POST audit failure rolls back command ingress and audit atomically');

    const beforeReadFailure = (await store.listCommandApiAudits({ worldId: 'audit_sql_world' })).length;
    await raw.query(`CREATE FUNCTION ${quoted}.reject_read_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.command_id='submit-1' AND NEW.outcome='read_applied' THEN RAISE EXCEPTION 'intentional read audit rejection'; END IF; RETURN NEW; END $$`);
    await raw.query(`CREATE TRIGGER reject_read_audit BEFORE INSERT ON ${quoted}.command_api_audit FOR EACH ROW EXECUTE FUNCTION ${quoted}.reject_read_audit()`);
    response = await request(port, 'GET', '/durable/worlds/audit_sql_world/commands/submit-1', { token: 'audit-token-one' });
    assert.strictEqual(response.status, 500); assert.strictEqual(response.body.error, 'internal_error');
    assert.strictEqual(response.body.data, undefined);
    assert.strictEqual((await store.listCommandApiAudits({ worldId: 'audit_sql_world' })).length, beforeReadFailure);
    await raw.query(`DROP TRIGGER reject_read_audit ON ${quoted}.command_api_audit`);
    pass('GET does not release command data when its required durable audit write fails');

    const beforeAnonymous = (await store.summary()).commandApiAudits;
    limitedApi = await createDurableCommandApiServer({
      store, sourceRateLimit: 1, accountSubmitRateLimit: 100, accountReadRateLimit: 100, rateLimitNow: () => 0,
    });
    const limitedPort = await listen(limitedApi.server);
    response = await request(limitedPort, 'GET', '/durable/worlds/audit_sql_world/commands/submit-1');
    assert.strictEqual(response.status, 401);
    response = await request(limitedPort, 'GET', '/durable/worlds/audit_sql_world/commands/submit-1');
    assert.strictEqual(response.status, 429);
    assert.strictEqual((await store.summary()).commandApiAudits, beforeAnonymous);
    pass('anonymous and source-rate-limited traffic cannot amplify durable audit writes');

    const direct = await store.appendCommandApiAudit({
      worldId: 'audit_sql_world', accountId: 'gm-account', method: 'GET', route: 'command.status',
      statusCode: 404, outcome: 'manual_probe', token: 'not-stored', sourceIp: '203.0.113.2', input: { secret: true },
    });
    assert.strictEqual(direct.outcome, 'manual_probe');
    const filtered = await store.listCommandApiAudits({ worldId: 'audit_sql_world', accountId: 'gm-account', statusCode: 404, order: 'asc', limit: 10 });
    assert.ok(filtered.some(row => row.outcome === 'manual_probe'));
    const finalSummary = await store.summary();
    assert.strictEqual(finalSummary.commandApiAudits, (await store.listCommandApiAudits({ worldId: 'audit_sql_world', limit: 1000 })).length);
    await assert.rejects(store.listCommandApiAudits({ worldId: 'audit_sql_world', limit: 0 }));
    await assert.rejects(store.listCommandApiAudits({ worldId: 'audit_sql_world', route: 'bad' }));
    const finalSerialized = JSON.stringify(await store.listCommandApiAudits({ worldId: 'audit_sql_world', limit: 1000 }));
    for (const forbidden of ['not-stored', '203.0.113.2', '"secret"', 'inputDigest']) assert.ok(!finalSerialized.includes(forbidden));
    pass('audit listing is bounded/filterable and never stores ignored sensitive fields');

    console.log(`postgres command api audit completed ${groups} scenario groups: ${groups} passed, 0 failed`);
  } finally {
    if (limitedApi) await limitedApi.close().catch(() => {});
    if (api) await api.close().catch(() => {});
    if (runtime) await runtime.close({ flush: false }).catch(() => {});
    await store.close().catch(() => {});
    await raw.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => {});
    await raw.end().catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
