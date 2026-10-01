'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { Pool } = require('pg');
const { createWorld } = require('../../core/world-engine');
const { createAccount, createSession } = require('../../core/account-session-engine');
const { createPostgresDatabaseStore } = require('../../storage/postgres/store');
const { createPostgresCommandApiAuditStore } = require('../../storage/postgres/command-api-audit-store');
const { createDurableCommandApiServer } = require('../../core/durable-command-api-engine');

async function request(port, path, token = 'query-token-gm') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: token ? { Authorization: 'Bearer ' + token } : {} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject); req.end();
  });
}
async function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
  });
}
async function until(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for audit persistence');
}
async function main() {
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  if (!connectionString) throw new Error('WORLD_ENGINE_TEST_DATABASE_URL is required; integration tests never silently skip');
  assert.ok(/_(ci|test)$/.test(new URL(connectionString).pathname), 'Integration tests require a named _ci or _test database');
  const schema = 'test_audit_query_' + crypto.randomBytes(8).toString('hex');
  const quoted = '"' + schema + '"';
  const store = createPostgresDatabaseStore({ connectionString, schema });
  const auditStore = createPostgresCommandApiAuditStore({ connectionString, schema });
  const raw = new Pool({ connectionString, max: 2 });
  const apis = [], extraStores = [];
  let groups = 0, requestNumber = 0, saveNumber = 0;
  const pass = name => { groups += 1; console.log('PASS ' + name); };
  const worldId = 'audit_query_world';
  const route = '/durable/worlds/' + worldId + '/admin/audit';
  async function changeWorld(edit) {
    const loaded = await store.loadWorld(worldId);
    edit(loaded.world);
    return store.saveWorld(loaded.world, { expectedRevision: loaded.revision, requestId: 'update-' + (++saveNumber) });
  }
  async function open(options = {}) {
    const api = await createDurableCommandApiServer({ store, auditStore, rateLimitNow: () => 0,
      requestIdFactory: () => 'query-request-' + (++requestNumber), ...options });
    apis.push(api);
    return { api, port: await listen(api.server) };
  }
  try {
    assert.strictEqual((await store.migrate()).version, require('../../storage/postgres/migrations').MIGRATIONS.length);
    const world = createWorld({ id: worldId, seed: 'audit-query' });
    for (const role of ['gm','admin','player']) {
      createAccount(world, { id: role, roles: [role] });
      createSession(world, role, { token: 'query-token-' + role });
    }
    await store.saveWorld(world, { expectedRevision: 0, requestId: 'seed-world' });
    await store.saveWorld(createWorld({ id: 'other_world', seed: 'other' }), { expectedRevision: 0, requestId: 'seed-other' });
    const base = { worldId, accountId: 'seed-account', playerId: 'seed-player', commandId: 'seed-command', method: 'POST', route: 'submit', statusCode: 202 };
    const seed = [];
    for (let n = 1; n <= 5; n += 1) seed.push(await auditStore.append({ ...base, requestId: 'seed-' + n }));
    await auditStore.append({ ...base, worldId: 'other_world', requestId: 'other-audit' });
    const fenced = await auditStore.list({ worldId, commandId: 'seed-command' }, { expectedWorldRevision: 1 });
    assert.deepStrictEqual(fenced.map(row => row.sequence), seed.map(row => row.sequence).reverse());
    await assert.rejects(auditStore.list({ worldId }, { expectedWorldRevision: 2 }), error => error.code === 'WORLD_DB_REVISION_CONFLICT');
    await assert.rejects(auditStore.list({ worldId: 'missing' }, { expectedWorldRevision: 1 }), error => error.code === 'WORLD_DB_MISSING_WORLD');
    await assert.rejects(auditStore.list({}, { expectedWorldRevision: 1 }), error => error.code === 'WORLD_DB_INVALID_INPUT');
    pass('migration 3 and revision-fenced world-scoped audit storage');

    const { port } = await open();
    assert.strictEqual((await request(port, route, null)).status, 401);
    const forbidden = await request(port, route, 'query-token-player');
    assert.strictEqual(forbidden.status, 403); assert.strictEqual(forbidden.body.error, 'audit_forbidden');
    for (const role of ['gm','admin']) {
      const result = await request(port, route, 'query-token-' + role);
      assert.strictEqual(result.status, 200);
      assert.ok(result.body.data.records.every(row => row.worldId === worldId));
    }
    assert.strictEqual((await request(port, '/durable/worlds/other_world/admin/audit')).status, 401);
    pass('HTTP authentication, both privileged roles and world isolation');

    const quotedAccount = "o'hara'; SELECT private_data --";
    await auditStore.append({ ...base, requestId: 'quoted-audit', accountId: quotedAccount, commandId: 'quoted-command' });
    const filtered = await request(port, route + '?accountId=' + encodeURIComponent(quotedAccount)
      + '&playerId=seed-player&commandId=quoted-command&method=POST&route=submit&statusCode=202');
    assert.strictEqual(filtered.status, 200);
    assert.strictEqual(filtered.body.data.records.length, 1);
    assert.strictEqual(filtered.body.data.records[0].requestId, 'quoted-audit');
    assert.strictEqual((await request(port, route + '?statusCode=599&commandId=quoted-command')).body.data.records.length, 0);
    assert.deepStrictEqual(Object.keys(filtered.body.data.records[0]).sort(),
      ['sequence','requestId','worldId','accountId','playerId','commandId','method','route','statusCode','errorCode','createdAt'].sort());
    pass('parameterized filter values and explicit redacted response fields');

    let page = await request(port, route + '?commandId=seed-command&limit=2');
    const sequences = page.body.data.records.map(row => row.sequence);
    await auditStore.append({ ...base, requestId: 'newer-than-first-page' });
    while (page.body.data.nextBeforeSequence !== null) {
      page = await request(port, route + '?commandId=seed-command&limit=2&beforeSequence=' + page.body.data.nextBeforeSequence);
      assert.strictEqual(page.status, 200);
      sequences.push(...page.body.data.records.map(row => row.sequence));
    }
    assert.deepStrictEqual(sequences, seed.map(row => row.sequence).reverse());
    assert.deepStrictEqual((await request(port, route + '?beforeSequence=1')).body.data, { records: [], nextBeforeSequence: null });
    pass('exclusive descending pagination excludes concurrent newer appends');

    const own = await request(port, route + '?limit=1000');
    const ownId = own.headers['x-request-id'];
    assert.ok(!own.body.data.records.some(row => row.requestId === ownId));
    let persisted;
    await until(async () => {
      persisted = (await auditStore.list({ worldId, route: 'audit' })).find(row => row.requestId === ownId);
      return Boolean(persisted);
    });
    assert.strictEqual(persisted.accountId, 'gm'); assert.strictEqual(persisted.statusCode, 200);
    assert.strictEqual(persisted.commandId, null);
    assert.ok(!JSON.stringify(own.body).includes('query-token'));
    assert.strictEqual(own.headers['cache-control'], 'no-store');
    pass('query excludes itself and later writes its own safe durable audit');

    let revocation = true, revokedReads = 0;
    const revokedStore = { ...auditStore, async list(query, options) {
      revokedReads += 1;
      if (revocation) { revocation = false; await changeWorld(w => { w.accounts.byId.gm.roles = ['player']; }); }
      return auditStore.list(query, options);
    } };
    const revokedApi = await open({ auditStore: revokedStore });
    const revoked = await request(revokedApi.port, route);
    assert.strictEqual(revoked.status, 403); assert.strictEqual(revoked.body.error, 'audit_forbidden');
    assert.strictEqual(revokedReads, 1);
    pass('real committed role revocation blocks a stale privileged query');

    let race = true, retryReads = 0;
    const retryStore = { ...auditStore, async list(query, options) {
      retryReads += 1;
      if (race) { race = false; await changeWorld(w => { w.tick += 1; }); }
      return auditStore.list(query, options);
    } };
    const retryApi = await open({ auditStore: retryStore, accountReadRateLimit: 1 });
    assert.strictEqual((await request(retryApi.port, route, 'query-token-admin')).status, 200);
    assert.strictEqual(retryReads, 2);
    const rateLimited = await request(retryApi.port, route, 'query-token-admin');
    assert.strictEqual(rateLimited.status, 429);
    assert.strictEqual(rateLimited.headers['retry-after'], '60');
    pass('real revision conflict retries once without double charging read quota');

    // Inject the checkpoint between two actual queries on the audit transaction.
    // Its repeatable-read snapshot must cover BOTH the revision and audit rows.
    const oldSnapshotRow = await auditStore.append({ ...base, requestId: 'snapshot-old', commandId: 'snapshot-command' });
    let snapshotHook = async () => {
      await changeWorld(w => { w.tick += 1; });
      await auditStore.append({ ...base, requestId: 'snapshot-new', commandId: 'snapshot-command' });
    };
    class SnapshotPool extends Pool {
      async connect() {
        const client = await super.connect();
        return {
          async query(sql, values) {
            const result = await client.query(sql, values);
            if (sql.startsWith('SELECT revision FROM ') && snapshotHook) {
              const hook = snapshotHook; snapshotHook = null; await hook();
            }
            return result;
          },
          release(broken) { client.release(broken); },
        };
      }
    }
    const snapshotStore = createPostgresCommandApiAuditStore({ connectionString, schema, Pool: SnapshotPool });
    extraStores.push(snapshotStore);
    const revisionBefore = (await store.loadWorld(worldId)).revision;
    const consistent = await snapshotStore.list({ worldId, commandId: 'snapshot-command' }, { expectedWorldRevision: revisionBefore });
    assert.deepStrictEqual(consistent.map(row => row.sequence), [oldSnapshotRow.sequence]);
    await assert.rejects(snapshotStore.list({ worldId }, { expectedWorldRevision: revisionBefore }), error => error.code === 'WORLD_DB_REVISION_CONFLICT');
    pass('revision fence and returned records use the same real SQL snapshot');

    for (const query of ['limit=1001','beforeSequence=9007199254740992','worldId=other_world','limit=1&limit=2','statusCode=600']) {
      const result = await request(port, route + '?' + query, 'query-token-admin');
      assert.strictEqual(result.status, 400);
      assert.strictEqual(result.body.error, 'invalid_audit_query');
    }
    const faultApi = await open({ auditStore: { ...auditStore, async list() {
      await raw.query('SELECT * FROM ' + quoted + '.deliberately_missing_query_relation');
    } } });
    const failed = await request(faultApi.port, route, 'query-token-admin');
    assert.strictEqual(failed.status, 500);
    assert.deepStrictEqual(failed.body, { ok: false, error: 'internal_error' });
    pass('invalid HTTP inputs and real SQL faults fail without leaking SQL details');

    await raw.query('CREATE FUNCTION ' + quoted + ".reject_query_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id LIKE 'query-fail-%' THEN RAISE EXCEPTION 'injected audit write failure'; END IF; RETURN NEW; END; $$");
    await raw.query('CREATE TRIGGER reject_query_audit BEFORE INSERT ON ' + quoted + '.command_api_audit FOR EACH ROW EXECUTE FUNCTION ' + quoted + '.reject_query_audit()');
    const failingApi = await open({ requestIdFactory: () => 'query-fail-' + (++requestNumber) });
    const success = await request(failingApi.port, route, 'query-token-admin');
    assert.strictEqual(success.status, 200);
    await until(() => failingApi.api.auditStats().failures === 1);
    const count = await raw.query('SELECT count(*) FROM ' + quoted + '.command_api_audit WHERE request_id=$1', [success.headers['x-request-id']]);
    assert.strictEqual(Number(count.rows[0].count), 0);
    assert.strictEqual((await store.loadWorld(worldId)).world.commands, undefined);
    pass('SQL audit write failure preserves a successful read-only response');

    console.log('postgres command audit query completed ' + groups + ' scenario groups: ' + groups + ' passed, 0 failed');
  } finally {
    for (const api of apis) await api.close();
    await Promise.all([store.close(), auditStore.close(), ...extraStores.map(s => s.close())]);
    await raw.query('DROP SCHEMA IF EXISTS ' + quoted + ' CASCADE');
    await raw.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
