'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { Pool } = require('pg');
const { createWorld } = require('../../core/world-engine');
const { createPlayer } = require('../../core/player-engine');
const { createAccount, createSession } = require('../../core/account-session-engine');
const { createPostgresDatabaseStore } = require('../../storage/postgres/store');
const { createPostgresCommandApiAuditStore } = require('../../storage/postgres/command-api-audit-store');
const { createDurableCommandApiServer } = require('../../core/durable-command-api-engine');

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
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  if (!connectionString) throw new Error('WORLD_ENGINE_TEST_DATABASE_URL is required; integration tests never silently skip');
  assert.ok(/_(ci|test)$/.test(new URL(connectionString).pathname));
  const schema = `test_command_audit_${crypto.randomBytes(8).toString('hex')}`, quoted = `"${schema}"`;
  const store = createPostgresDatabaseStore({ connectionString, schema });
  const auditStore = createPostgresCommandApiAuditStore({ connectionString, schema });
  const raw = new Pool({ connectionString, max: 2 });
  let api = null, groups = 0;
  const pass = name => { groups += 1; console.log(`PASS ${name}`); };
  try {
    const migration = await store.migrate();
    assert.strictEqual(migration.version, 3);
    assert.strictEqual((await auditStore.summary()).records, 0);
    pass('migration 3 creates a separately queryable durable command API audit store');

    const first = await auditStore.append({ requestId: 'manual-1', worldId: 'w', accountId: 'a', playerId: 'p', commandId: 'c',
      method: 'POST', route: 'submit', statusCode: 202 });
    const retry = await auditStore.append({ requestId: 'manual-1', worldId: 'w', accountId: 'a', playerId: 'p', commandId: 'c',
      method: 'POST', route: 'submit', statusCode: 202 });
    assert.strictEqual(first.sequence, retry.sequence); assert.strictEqual(retry.idempotent, true);
    await assert.rejects(auditStore.append({ requestId: 'manual-1', worldId: 'w', method: 'GET', route: 'status', statusCode: 200 }),
      error => error.code === 'WORLD_DB_IDEMPOTENCY_CONFLICT');
    assert.strictEqual((await auditStore.list({ accountId: 'a' })).length, 1);
    pass('audit append is idempotent by request ID and bounded filters are parameterized');

    const world = createWorld({ id: 'audit_world', seed: 'audit-world' });
    createPlayer(world, { id: 'player-1' });
    createAccount(world, { id: 'account-1', roles: ['player'], playerIds: ['player-1'] });
    createSession(world, 'account-1', { token: 'postgres-audit-token' });
    await store.saveWorld(world, { expectedRevision: 0, requestId: 'seed:audit-world' });
    let id = 0;
    api = await createDurableCommandApiServer({ store, auditStore, rateLimitNow: () => 0, requestIdFactory: () => `http-${++id}` });
    const port = await listen(api.server);
    let response = await request(port, 'POST', '/durable/worlds/audit_world/players/player-1/commands', {
      token: 'postgres-audit-token', body: { id: 'cmd-http', type: 'wait' },
    });
    assert.strictEqual(response.status, 202); assert.strictEqual(response.headers['x-request-id'], 'http-1');
    response = await request(port, 'GET', '/durable/worlds/audit_world/commands/cmd-http');
    assert.strictEqual(response.status, 401);
    for (let n = 0; n < 50 && (await auditStore.summary()).records < 3; n += 1) await new Promise(resolve => setTimeout(resolve, 5));
    const httpRows = await auditStore.list({ worldId: 'audit_world', order: 'asc' });
    assert.strictEqual(httpRows.length, 2);
    assert.deepStrictEqual(httpRows.map(row => [row.requestId,row.accountId,row.commandId,row.statusCode,row.errorCode]), [
      ['http-1','account-1','cmd-http',202,null],
      ['http-2',null,'cmd-http',401,'auth_required'],
    ]);
    pass('authenticated and rejected HTTP requests persist subject, command and outcome without raw credentials');

    const columns = (await raw.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='command_api_audit' ORDER BY column_name`, [schema])).rows.map(r => r.column_name);
    for (const forbidden of ['token','authorization','input','input_digest','body','connection_string']) assert.ok(!columns.includes(forbidden));
    const serialized = JSON.stringify(await auditStore.list({ limit: 20 }));
    assert.ok(!serialized.includes('postgres-audit-token'));
    assert.ok(!serialized.includes('type')); // command body is not copied into audit rows
    pass('audit schema and returned rows exclude bearer tokens, command bodies and database credentials');

    console.log(`postgres command audit completed ${groups} scenario groups: ${groups} passed, 0 failed`);
  } finally {
    if (api) await api.close();
    await Promise.all([store.close(), auditStore.close()]);
    await raw.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await raw.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
