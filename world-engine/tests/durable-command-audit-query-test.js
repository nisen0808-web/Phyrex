'use strict';

const assert = require('assert');
const http = require('http');
const { createWorld } = require('../core/world-engine');
const { createAccount, createSession } = require('../core/account-session-engine');
const { createDurableCommandApiServer } = require('../core/durable-command-api-engine');

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function dbError(code) { return Object.assign(new Error('secret SQL connection detail'), { code: 'WORLD_DB_' + code }); }
function fixture() {
  const world = createWorld({ id: 'audit_world', seed: 'audit-query' });
  for (const role of ['gm', 'admin', 'player']) {
    createAccount(world, { id: role, roles: [role] });
    createSession(world, role, { token: 'token-' + role });
  }
  const state = { world, revision: 1, loads: 0, lists: [], records: [], appends: [], next: 7, now: 0 };
  for (let sequence = 1; sequence <= 6; sequence += 1) {
    state.records.push({ sequence, requestId: 'seed-' + sequence, worldId: sequence === 6 ? 'other_world' : world.id,
      accountId: 'seed-account', playerId: 'seed-player', commandId: 'seed-command', method: 'POST', route: 'submit',
      statusCode: 202, errorCode: null, createdAt: '2026-01-01T00:00:00.000Z',
      authorization: 'must-not-escape', input: { private: true }, inputDigest: 'private-digest' });
  }
  const store = {
    provider: 'postgres',
    async summary() { return {}; },
    async loadWorld(id) {
      state.loads += 1;
      return id === state.world.id ? { world: clone(state.world), revision: state.revision } : null;
    },
    async enqueueCommand() { throw new Error('query must not enqueue'); },
    async getCommand() { return { id: 'cmd', worldId: world.id, playerId: 'seed-player', sequence: 1, status: 'pending' }; },
    async close() {},
  };
  const auditStore = {
    provider: 'postgres',
    async summary() { return {}; },
    async append(row) {
      state.appends.push(clone(row));
      if (state.appendError) throw state.appendError;
      state.records.push({ ...clone(row), sequence: state.next++, createdAt: '2026-01-01T00:00:00.000Z' });
    },
    async list(query, options) {
      state.lists.push({ query: clone(query), options: clone(options) });
      if (state.onList) await state.onList();
      if (options.expectedWorldRevision !== state.revision) throw dbError('REVISION_CONFLICT');
      return clone(state.records.filter(row => {
        if (query.beforeSequence !== undefined && row.sequence >= query.beforeSequence) return false;
        return ['worldId','accountId','playerId','commandId','method','route','statusCode']
          .every(key => query[key] === undefined || query[key] === row[key]);
      }).sort((a, b) => b.sequence - a.sequence).slice(0, query.limit));
    },
    async close() {},
  };
  return { state, store, auditStore };
}
async function request(port, path, token = 'token-gm', method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method,
      headers: token ? { Authorization: 'Bearer ' + token } : {} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject); req.end();
  });
}
async function usingApi(f, options, work) {
  const api = await createDurableCommandApiServer({ store: f.store, auditStore: f.auditStore,
    rateLimitNow: () => f.state.now, requestIdFactory: () => 'request-' + f.state.next, ...options });
  const port = await new Promise(resolve => api.server.listen(0, '127.0.0.1', () => resolve(api.server.address().port)));
  try { await work(port, api); } finally { await api.close(); }
}
const route = '/durable/worlds/audit_world/admin/audit';

async function main() {
  let groups = 0;
  const pass = name => { groups += 1; console.log('PASS ' + name); };
  const f = fixture();
  await usingApi(f, {}, async port => {
    for (const token of [null, 'invalid-token']) assert.strictEqual((await request(port, route, token)).status, 401);
    const forbidden = await request(port, route, 'token-player');
    assert.strictEqual(forbidden.status, 403);
    assert.strictEqual(forbidden.body.error, 'audit_forbidden');
    assert.strictEqual(f.state.lists.length, 0);
    assert.strictEqual((await request(port, '/durable/worlds/missing/admin/audit')).status, 404);
    assert.strictEqual((await request(port, route, 'token-gm', 'POST')).status, 405);
    for (const token of ['token-gm', 'token-admin']) assert.strictEqual((await request(port, route, token)).status, 200);
    pass('authentication, both privileged roles, player rejection and world/method boundaries');

    const before = f.state.lists.length;
    for (const query of ['limit=0','limit=1001','limit=1.5','limit=1e2','limit=-1','limit=','limit=%20',
      'limit=2&limit=3','beforeSequence=0','beforeSequence=-1','beforeSequence=9007199254740992',
      'statusCode=99','statusCode=600','statusCode=202.0','worldId=other_world','order=asc','afterSequence=1',
      'unknown=1','__proto__=x','constructor=x','method=get','method=INVALID','route=private',
      'accountId=','playerId=%20','commandId=%00','accountId=' + 'x'.repeat(201),'commandId=' + 'x'.repeat(257)]) {
      const result = await request(port, route + '?' + query);
      assert.strictEqual(result.status, 400, query);
      assert.strictEqual(result.body.error, 'invalid_audit_query', query);
    }
    assert.strictEqual(f.state.lists.length, before);
    const valid = await request(port, route + '?limit=1000&beforeSequence=9007199254740991');
    assert.strictEqual(valid.status, 200);
    assert.strictEqual(f.state.lists.at(-1).query.limit, 1000);
    pass('strict whitelist, duplicate rejection and numeric/text bounds before audit reads');

    const result = await request(port, route + '?accountId=seed-account&playerId=seed-player&commandId=seed-command&method=POST&route=submit&statusCode=202');
    assert.deepStrictEqual(result.body.data.records.map(row => row.sequence), [5,4,3,2,1]);
    assert.strictEqual(result.body.data.nextBeforeSequence, null);
    assert.strictEqual(f.state.lists.at(-1).query.worldId, 'audit_world');
    assert.strictEqual(f.state.lists.at(-1).query.limit, 100);
    assert.strictEqual(f.state.lists.at(-1).options.expectedWorldRevision, 1);
    assert.deepStrictEqual(Object.keys(result.body.data.records[0]).sort(),
      ['sequence','requestId','worldId','accountId','playerId','commandId','method','route','statusCode','errorCode','createdAt'].sort());
    assert.ok(!JSON.stringify(result.body).includes('must-not-escape'));
    assert.ok(!JSON.stringify(result.body).includes('private-digest'));
    assert.strictEqual(result.headers['cache-control'], 'no-store');
    assert.strictEqual(result.headers['access-control-allow-origin'], undefined);
    pass('world-scoped filters, explicit safe response fields and closed CORS');

    await new Promise(resolve => setImmediate(resolve));
    const own = f.state.appends.find(row => row.requestId === result.headers['x-request-id']);
    assert.strictEqual(own.route, 'audit');
    assert.strictEqual(own.accountId, 'gm');
    assert.strictEqual(own.statusCode, 200);
    assert.strictEqual(own.commandId, null, 'query filter is not the audited command identity');
    assert.ok(!result.body.data.records.some(row => row.requestId === own.requestId));
    assert.ok(!JSON.stringify(own).includes('seed-account'));
    pass('query audit is written afterwards without copying query strings');
  });

  const pages = fixture();
  await usingApi(pages, {}, async port => {
    const sequences = [];
    let cursor;
    do {
      const result = await request(port, route + '?limit=2' + (cursor ? '&beforeSequence=' + cursor : ''));
      assert.strictEqual(result.status, 200);
      assert.ok(!result.body.data.records.some(row => row.requestId === result.headers['x-request-id']));
      sequences.push(...result.body.data.records.map(row => row.sequence));
      cursor = result.body.data.nextBeforeSequence;
    } while (cursor);
    assert.deepStrictEqual(sequences, [5,4,3,2,1]);
    const empty = await request(port, route + '?beforeSequence=1');
    assert.deepStrictEqual(empty.body.data, { records: [], nextBeforeSequence: null });
    pass('descending exclusive pagination does not chase newly appended query audits');
  });

  const revoked = fixture();
  revoked.state.onList = () => { revoked.state.world.accounts.byId.gm.roles = ['player']; revoked.state.revision += 1; revoked.state.onList = null; };
  await usingApi(revoked, {}, async port => {
    const result = await request(port, route);
    assert.strictEqual(result.status, 403); assert.strictEqual(result.body.error, 'audit_forbidden');
    assert.strictEqual(revoked.state.loads, 2); assert.strictEqual(revoked.state.lists.length, 1);
    pass('concurrent privilege revocation forces reauthorization before returning rows');
  });

  const retry = fixture();
  retry.state.onList = () => { retry.state.revision += 1; retry.state.onList = null; };
  await usingApi(retry, { accountReadRateLimit: 1, rateLimitWindowMs: 10 }, async port => {
    assert.strictEqual((await request(port, route)).status, 200);
    assert.strictEqual(retry.state.lists.length, 2);
    const limited = await request(port, '/durable/worlds/audit_world/commands/cmd');
    assert.strictEqual(limited.status, 429); assert.strictEqual(limited.headers['retry-after'], '1');
    retry.state.now = 10;
    assert.strictEqual((await request(port, route)).status, 200);
    pass('reauthorization charges once and audit/status share account read quota');
  });

  const conflicts = fixture();
  conflicts.state.onList = () => { throw dbError('REVISION_CONFLICT'); };
  await usingApi(conflicts, { authorizationAttempts: 3 }, async port => {
    const result = await request(port, route);
    assert.strictEqual(result.status, 409); assert.strictEqual(result.body.error, 'world_revision_changed');
    assert.strictEqual(conflicts.state.lists.length, 3);
    conflicts.state.onList = () => { throw new Error('secret SQL connection detail'); };
    const failed = await request(port, route);
    assert.deepStrictEqual(failed.body, { ok: false, error: 'internal_error' });
    pass('bounded conflict retries and safe unknown-error mapping');
  });

  const source = fixture();
  await usingApi(source, { sourceRateLimit: 1 }, async port => {
    assert.strictEqual((await request(port, '/missing')).status, 404);
    assert.strictEqual((await request(port, route)).status, 429);
    assert.strictEqual(source.state.loads, 0); assert.strictEqual(source.state.lists.length, 0);
    pass('source limits apply before world loading or audit query');
  });

  const failure = fixture();
  failure.state.appendError = new Error('audit offline');
  await usingApi(failure, {}, async (port, api) => {
    const result = await request(port, route);
    assert.strictEqual(result.status, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(api.auditStats().failures, 1);
    assert.strictEqual(failure.state.appends.length, 1, 'failed audit append must not retry with a falsified HTTP 500');
    assert.strictEqual(failure.state.appends[0].statusCode, 200);
    pass('audit persistence failure leaves query result and audit outcome unchanged');
  });

  const compatibility = fixture();
  await usingApi(compatibility, { auditStore: undefined }, async port => {
    const result = await request(port, route);
    assert.deepStrictEqual(result.body, { ok: false, error: 'service_unavailable' });
    assert.strictEqual(result.status, 503);
    pass('non-durable compatibility adapter cannot impersonate an audit query store');
  });
  console.log('durable command audit query completed ' + groups + ' scenario groups: ' + groups + ' passed, 0 failed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
