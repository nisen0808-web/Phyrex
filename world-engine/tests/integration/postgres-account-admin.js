'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');
const { createWorld } = require('../../core/world-engine');
const { createPlayer } = require('../../core/player-engine');
const { createAccount, createSession, validateSession } = require('../../core/account-session-engine');
const { createPostgresDatabaseStore } = require('../../storage/postgres/store');
const { createPostgresCommandApiAuditStore } = require('../../storage/postgres/command-api-audit-store');
const { createDurableCommandApiServer } = require('../../core/durable-command-api-engine');
const { createDurableWorldRuntime } = require('../../runtime/durable-world-runtime');
const { administerAccount } = require('../../runtime/durable-account-admin');
const { main: cli } = require('../../demo/account-admin-cli');
const { exportBackupFile, readBackupFile } = require('../../storage/postgres/backup');
const { digest } = require('../../storage/postgres/codec');

function request(port, method, route, token, body) {
  return new Promise((resolve, reject) => {
    const text = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: route,
      headers: { Authorization: `Bearer ${token}`, ...(text ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject); req.end(text);
  });
}
async function main() {
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  if (!connectionString || !/_(ci|test)$/.test(new URL(connectionString).pathname)) throw new Error('Isolated test database required; no silent skip');
  const schema = `test_admin_${crypto.randomBytes(7).toString('hex')}`, q = `"${schema}"`;
  const store = createPostgresDatabaseStore({ connectionString, schema });
  const restored = createPostgresDatabaseStore({ connectionString, schema: `${schema}_restored` });
  const audit = createPostgresCommandApiAuditStore({ connectionString, schema });
  const raw = new Pool({ connectionString, max: 3 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-account-admin-'));
  const env = { WORLD_ENGINE_DATABASE_URL: connectionString, WORLD_ENGINE_DB_SCHEMA: schema };
  const oldToken = 'old_account_'.repeat(6), newToken = 'new_account_'.repeat(6);
  let api, runtime, serial = 0, groups = 0;
  const worldId = 'admin-world';
  const pass = label => { groups++; console.log(`PASS ${label}`); };
  const make = async (operation, requestId = `operation-${++serial}`) => ({ worldId, requestId,
    expectedRevision: (await store.loadWorld(worldId)).revision, operation });
  const run = async operation => administerAccount(store, await make(operation));
  try {
    await store.migrate(); await restored.migrate();
    const world = createWorld({ id: worldId, seed: 'durable-admin' });
    createPlayer(world, { id: 'p', controlMode: 'observer' });
    createAccount(world, { id: 'old', playerIds: ['p'] }); createAccount(world, { id: 'new' });
    createSession(world, 'old', { token: oldToken }); createSession(world, 'new', { token: newToken });
    await store.saveWorld(world, { requestId: 'seed', expectedRevision: 0 });
    runtime = await createDurableWorldRuntime({ worldId, store }); await runtime.step(1); await runtime.close(); runtime = null;
    const configHash = (await store.loadWorld(worldId)).metadata.durableRuntime.configHash;
    const tokenFile = path.join(directory, 'operator-token');
    await cli(['token.create', '--output', tokenFile], env);
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    let revision = (await store.loadWorld(worldId)).revision;
    await cli(['account.create', '--world-id', worldId, '--account-id', 'operator', '--roles', 'admin', '--request-id', 'create-operator', '--expected-revision', String(revision)], env);
    const issueArgs = ['session.issue', '--world-id', worldId, '--account-id', 'operator', '--request-id', 'issue-operator', '--expected-revision', String(revision + 1), '--token-file', tokenFile];
    const issued = await cli(issueArgs, env);
    assert.strictEqual((await cli(issueArgs, env)).sessionId, issued.sessionId);
    const inspected = await cli(['inspect', '--world-id', worldId, '--account-id', 'operator'], env);
    assert.strictEqual(inspected.account.sessions.length, 1);
    assert.strictEqual(inspected.account.sessions[0].tokenPrefix, undefined);
    assert.ok(validateSession((await store.loadWorld(worldId)).world, token));
    assert.strictEqual((await store.loadWorld(worldId)).metadata.durableRuntime.configHash, configHash);
    pass('CLI creates persistent accounts and hash-only sessions while preserving runtime configuration');

    api = await createDurableCommandApiServer({ store, auditStore: audit, rateLimitNow: () => 0 });
    await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
    const port = api.server.address().port, commandRoute = `/durable/worlds/${worldId}/players/p/commands`;
    const submit = (auth, id) => request(port, 'POST', commandRoute, auth, { id, type: 'wait' });
    assert.strictEqual((await submit(oldToken, 'before-transfer')).status, 202);
    await run({ type: 'player.link', accountId: 'new', playerId: 'p' });
    assert.strictEqual((await submit(oldToken, 'after-transfer-old')).status, 403);
    assert.strictEqual((await submit(newToken, 'after-transfer-new')).status, 202);
    await run({ type: 'player.unlink', accountId: 'new', playerId: 'p' });
    assert.strictEqual((await submit(newToken, 'after-unlink')).status, 403);
    await run({ type: 'player.link', accountId: 'new', playerId: 'p' });
    pass('committed player transfers and unlinking revoke prior HTTP command ownership');

    const auditRoute = `/durable/worlds/${worldId}/admin/audit`;
    assert.strictEqual((await request(port, 'GET', auditRoute, token)).status, 200);
    await run({ type: 'account.roles', accountId: 'operator', roles: ['player'] });
    assert.strictEqual((await request(port, 'GET', auditRoute, token)).status, 403);
    await run({ type: 'account.roles', accountId: 'operator', roles: ['gm'] });
    assert.strictEqual((await request(port, 'GET', auditRoute, token)).status, 200);
    await run({ type: 'account.status', accountId: 'operator', status: 'suspended' });
    assert.strictEqual((await request(port, 'GET', auditRoute, token)).status, 401);
    await run({ type: 'account.status', accountId: 'operator', status: 'active' });
    assert.strictEqual((await request(port, 'GET', auditRoute, token)).status, 401);
    assert.strictEqual((await cli(issueArgs, env)).sessionId, issued.sessionId);
    assert.strictEqual(validateSession((await store.loadWorld(worldId)).world, token), null);
    await assert.rejects(run({ type: 'session.issue', accountId: 'operator', token }), e => e.code === 'WORLD_ADMIN_TOKEN_REUSED');
    pass('role/status changes take effect on authenticated HTTP reads and reactivation cannot revive a revoked session');

    const freshToken = 'fresh_operator_'.repeat(6);
    const issueRequest = await make({ type: 'session.issue', accountId: 'operator', token: freshToken });
    const attempts = []; let lost = false;
    const flaky = { ...store, saveWorld: async (candidate, options) => {
      attempts.push(digest({ candidate, options })); const saved = await store.saveWorld(candidate, options);
      if (!lost) { lost = true; throw Object.assign(new Error('injected lost acknowledgement'), { code: 'WORLD_DB_UNAVAILABLE' }); }
      return saved;
    } };
    const recovered = await administerAccount(flaky, issueRequest);
    assert.strictEqual(attempts.length, 2); assert.strictEqual(attempts[0], attempts[1]); assert.strictEqual(recovered.idempotent, true);
    await run({ type: 'session.revoke', accountId: 'operator', sessionId: recovered.sessionId });
    assert.strictEqual(validateSession((await store.loadWorld(worldId)).world, freshToken), null);
    assert.strictEqual((await administerAccount(store, issueRequest)).sessionId, recovered.sessionId);
    assert.strictEqual(validateSession((await store.loadWorld(worldId)).world, freshToken), null);
    pass('lost SQL acknowledgement retries one captured session and historical retries cannot undo revocation');

    const concurrentToken = 'concurrent_operator_'.repeat(5);
    const concurrentRequest = await make({ type: 'session.issue', accountId: 'operator', token: concurrentToken });
    let readers = 0, release; const barrier = new Promise(resolve => { release = resolve; });
    const concurrentStore = { ...store, loadWorld: async id => { const saved = await store.loadWorld(id); if (++readers === 2) release(); await barrier; return saved; } };
    const both = await Promise.all([administerAccount(concurrentStore, concurrentRequest), administerAccount(concurrentStore, concurrentRequest)]);
    assert.strictEqual(both[0].sessionId, both[1].sessionId);
    assert.strictEqual(both[0].revision, both[1].revision);
    const live = (await store.loadWorld(worldId)).world;
    assert.strictEqual(Object.values(live.accounts.sessions).filter(row => row.id === both[0].sessionId).length, 1);
    await assert.rejects(administerAccount(store, { ...concurrentRequest, operation: { ...concurrentRequest.operation, ttlTicks: 999 } }), e => e.code === 'WORLD_ADMIN_IDEMPOTENCY_CONFLICT');
    pass('concurrent duplicate session issuance converges on one durable receipt and rejects changed operations');

    runtime = await createDurableWorldRuntime({ worldId, store });
    const stale = await make({ type: 'account.roles', accountId: 'old', roles: ['admin'] });
    await run({ type: 'session.revoke-all', accountId: 'operator' });
    const fenced = await store.loadWorld(worldId);
    await assert.rejects(administerAccount(store, stale), e => e.code === 'WORLD_ADMIN_REVISION_CONFLICT');
    await assert.rejects(runtime.step(1), e => e.code === 'WORLD_DB_REVISION_CONFLICT');
    assert.strictEqual((await store.loadWorld(worldId)).revision, fenced.revision);
    await runtime.close({ flush: false }); runtime = null;
    runtime = await createDurableWorldRuntime({ worldId, store }); await runtime.step(1); await runtime.close(); runtime = null;
    assert.strictEqual(validateSession((await store.loadWorld(worldId)).world, concurrentToken), null);
    pass('administration and live runtime share revision fencing; restart preserves revoked permissions and runtime config');

    const faultRequest = await make({ type: 'account.create', accountId: 'rollback-account' });
    const before = await store.summary();
    await raw.query(`CREATE FUNCTION ${q}.fail_admin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='account.administration' THEN RAISE EXCEPTION 'injected failure' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`);
    await raw.query(`CREATE TRIGGER fail_admin BEFORE INSERT ON ${q}.world_events FOR EACH ROW EXECUTE FUNCTION ${q}.fail_admin()`);
    await assert.rejects(administerAccount(store, faultRequest), e => e.sqlState === '40001');
    assert.strictEqual((await store.summary()).records, before.records);
    assert.strictEqual((await store.loadWorld(worldId)).world.accounts.byId['rollback-account'], undefined);
    await raw.query(`DROP TRIGGER fail_admin ON ${q}.world_events`);
    await administerAccount(store, faultRequest);
    pass('SQL failure rolls back account mutation and its event; retry after recovery commits once');

    await api.close(); api = null;
    revision = (await store.loadWorld(worldId)).revision;
    await store.compactCheckpoints(worldId, { keep: 1, maxRecords: 1000, expectedRevision: revision, apply: true });
    const file = path.join(directory, 'restored.ndjson'); await exportBackupFile(store, file);
    await restored.restoreSnapshot(readBackupFile(file));
    assert.strictEqual((await administerAccount(restored, issueRequest)).sessionId, recovered.sessionId);
    assert.strictEqual(validateSession((await restored.loadWorld(worldId)).world, freshToken), null);
    assert.strictEqual(digest((await restored.loadWorld(worldId)).world), digest((await store.loadWorld(worldId)).world));
    const backupText = fs.readFileSync(file, 'utf8');
    for (const secret of [oldToken, newToken, token, freshToken, concurrentToken]) assert.strictEqual(backupText.includes(secret), false);
    const events = await store.listEvents({ worldId, limit: 1000 });
    assert.ok(events.some(row => row.type === 'account.administration'));
    assert.strictEqual(JSON.stringify(events).includes('tokenHash'), false);
    pass('archived operation receipts and full restoration preserve revocation without raw token persistence');
    console.log(`postgres account admin completed ${groups} scenario groups: ${groups} passed, 0 failed`);
  } finally {
    if (api) await api.close(); if (runtime) await runtime.close({ flush: false }).catch(() => {});
    await audit.close(); await store.close(); await restored.close();
    await raw.query(`DROP SCHEMA IF EXISTS ${q} CASCADE`); await raw.query(`DROP SCHEMA IF EXISTS "${schema}_restored" CASCADE`); await raw.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
