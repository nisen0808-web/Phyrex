'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
const { guardClientLease, createClientLeaseManager } = require('../storage/postgres/client-lease');
const { normalizePostgresConfig, safePostgresConfig } = require('../storage/postgres/config');
const { createPostgresDatabaseStore } = require('../storage/postgres/store');
const { createPostgresCommandApiAuditStore } = require('../storage/postgres/command-api-audit-store');
const { MIGRATIONS } = require('../storage/postgres/migrations');

const base = { connectionString: 'postgres://test:private@127.0.0.1/world_engine_test' };
const short = { connectionTimeoutMillis: 30, queryTimeoutMillis: 30, transactionTimeoutMillis: 120, closeTimeoutMillis: 30 };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fakeClient(query = async () => ({ rows: [] })) {
  const client = new EventEmitter();
  client.calls = []; client.releases = [];
  client.query = (...args) => { client.calls.push(args[0]); return query(...args); };
  client.release = broken => { client.releases.push(broken); };
  return client;
}
function poolFor(client) {
  return { connect: async () => client, end: async () => {} };
}
async function unavailable(promise) {
  await assert.rejects(promise, error => error.code === 'WORLD_DB_UNAVAILABLE' && !error.message.includes('private'));
}

async function configContracts() {
  const defaults = normalizePostgresConfig(base, {});
  assert.equal(defaults.queryTimeoutMillis, 30000);
  assert.equal(defaults.transactionTimeoutMillis, 300000);
  assert.equal(defaults.closeTimeoutMillis, 5000);
  const overridden = normalizePostgresConfig(base, { WORLD_ENGINE_DB_QUERY_TIMEOUT_MILLIS: '50',
    WORLD_ENGINE_DB_TRANSACTION_TIMEOUT_MILLIS: '500', WORLD_ENGINE_DB_CLOSE_TIMEOUT_MILLIS: '20' });
  assert.equal(overridden.queryTimeoutMillis, 50);
  assert.equal(overridden.transactionTimeoutMillis, 500);
  assert.equal(overridden.closeTimeoutMillis, 20);
  const safe = safePostgresConfig(overridden);
  assert.equal(safe.queryTimeoutMillis, 50); assert.equal(safe.transactionTimeoutMillis, 500); assert.equal(safe.closeTimeoutMillis, 20);
  assert.ok(!JSON.stringify(safe).includes('private'));
  for (const name of ['queryTimeoutMillis', 'transactionTimeoutMillis', 'closeTimeoutMillis']) {
    for (const invalid of [0, -1, '', NaN, Infinity, 3600001]) {
      assert.throws(() => normalizePostgresConfig({ ...base, [name]: invalid }, {}), { code: 'WORLD_DB_INVALID_CONFIG' });
    }
  }
}

async function queryExpiryAndLateOutcomes() {
  const reply = deferred(), raw = fakeClient(() => reply.promise);
  const lease = guardClientLease(raw, { queryTimeoutMillis: 20 });
  await unavailable(lease.query('COMMIT'));
  assert.deepEqual(raw.releases, [true]);
  lease.release(); lease.destroy(); assert.deepEqual(raw.releases, [true]);
  raw.emit('error', new Error('private late error'));
  reply.reject(new Error('private late rejection'));
  await delay(5);
  await unavailable(lease.query('ROLLBACK'));
  assert.deepEqual(raw.calls, ['COMMIT']);
  raw.emit('end'); assert.equal(raw.listenerCount('error'), 0);
}

async function totalBudgetIncludesNonSqlAwait() {
  const sink = deferred(), raw = fakeClient(), manager = createClientLeaseManager(poolFor(raw),
    { ...short, queryTimeoutMillis: 100, transactionTimeoutMillis: 25 });
  const operation = manager.withClient(async client => {
    await client.query('BEGIN'); await sink.promise; await client.query('COMMIT');
  });
  await unavailable(operation);
  assert.deepEqual(raw.releases, [true]);
  sink.resolve(); await delay(5);
  assert.deepEqual(raw.calls, ['BEGIN']);
  await manager.close();
}

async function totalBudgetDoesNotResetPerQuery() {
  const raw = fakeClient(async () => { await delay(12); return { rows: [] }; });
  const manager = createClientLeaseManager(poolFor(raw), { ...short, queryTimeoutMillis: 100, transactionTimeoutMillis: 28 });
  await unavailable(manager.withClient(async client => {
    for (let n = 0; n < 10; n++) await client.query('SELECT 1');
    await client.query('COMMIT');
  }));
  assert.ok(raw.calls.length < 10); assert.ok(!raw.calls.includes('COMMIT'));
  assert.deepEqual(raw.releases, [true]); await manager.close();
}

async function acquisitionExpiryDestroysLateClient() {
  const pending = deferred(), raw = fakeClient();
  const manager = createClientLeaseManager({ connect: () => pending.promise, end: async () => {} }, short);
  await unavailable(manager.withClient(client => client.query('BEGIN')));
  pending.resolve(raw); await delay(5);
  assert.deepEqual(raw.calls, []); assert.deepEqual(raw.releases, [true]);
  raw.emit('error', new Error('private late acquisition error')); raw.emit('end');
  await manager.close();
}

async function closeCancelsAcquisitionAndBoundsHungQuery() {
  const pending = deferred(), raw = fakeClient();
  const manager = createClientLeaseManager({ connect: () => pending.promise, end: async () => {} },
    { ...short, connectionTimeoutMillis: 500, transactionTimeoutMillis: 1000 });
  const operation = manager.withClient(client => client.query('BEGIN'));
  const rejected = unavailable(operation);
  await delay(1); await manager.close(); await rejected;
  pending.resolve(raw); await delay(5);
  assert.deepEqual(raw.calls, []); assert.deepEqual(raw.releases, [true]);
  await assert.rejects(manager.withClient(() => {}), { code: 'WORLD_DB_CLOSED' });

  const hung = deferred(), active = fakeClient(() => hung.promise), second = createClientLeaseManager(poolFor(active),
    { ...short, queryTimeoutMillis: 500, transactionTimeoutMillis: 1000 });
  const running = unavailable(second.withClient(client => client.query('SELECT 1')));
  await delay(1); await Promise.all([unavailable(second.close()), running]);
  assert.deepEqual(active.releases, [true]); hung.reject(new Error('private late close rejection')); await delay(1);
}

async function closeGracefullyDrainsLeasedWork() {
  const reply = deferred(), raw = fakeClient(sql => sql === 'SELECT 1' ? reply.promise : Promise.resolve({ rows: [] }));
  let ends = 0;
  const manager = createClientLeaseManager({ connect: async () => raw, end: async () => { ends++; } },
    { ...short, queryTimeoutMillis: 500, transactionTimeoutMillis: 1000, closeTimeoutMillis: 200 });
  const work = manager.withClient(async client => {
    await client.query('SELECT 1'); await client.query('COMMIT'); return 'drained';
  });
  await delay(1);
  const closed = manager.close();
  await assert.rejects(manager.withClient(() => {}), { code: 'WORLD_DB_CLOSED' });
  assert.equal(ends, 0, 'pool.end must wait even if a fake driver resolves it immediately');
  reply.resolve({ rows: [] });
  assert.equal(await work, 'drained'); await closed;
  assert.equal(ends, 1); assert.deepEqual(raw.releases, [false]);
  assert.equal(raw.listenerCount('error'), 0);
}

async function closeBoundsNonSqlWorkAndFencesLateCommit() {
  for (const delayedTimer of [false, true]) {
    const sink = deferred(), raw = fakeClient();
    const manager = createClientLeaseManager(poolFor(raw),
      { ...short, queryTimeoutMillis: 500, transactionTimeoutMillis: 1000, closeTimeoutMillis: 10 });
    const work = unavailable(manager.withClient(async client => {
      await client.query('BEGIN'); await sink.promise; await client.query('COMMIT');
    }));
    await delay(1);
    const closed = unavailable(manager.close());
    if (delayedTimer) {
      const until = performance.now() + 20; while (performance.now() < until) {}
      sink.resolve();
    }
    await Promise.all([work, closed]);
    sink.resolve(); await delay(1);
    assert.deepEqual(raw.calls, ['BEGIN']); assert.deepEqual(raw.releases, [true]);
  }
}

async function closeItselfIsBounded() {
  const lateEnd = deferred();
  const manager = createClientLeaseManager({ end: () => lateEnd.promise }, { ...short, closeTimeoutMillis: 20 });
  const first = manager.close(), second = manager.close();
  assert.equal(first, second); await unavailable(first);
  lateEnd.reject(new Error('private late end error')); await delay(5);
}

async function deadlinesSurviveDelayedTimerCallbacks() {
  const spin = () => { const until = performance.now() + 15; while (performance.now() < until) {} };
  const raw = fakeClient(() => { spin(); return Promise.resolve({ rows: [] }); });
  const lease = guardClientLease(raw, { queryTimeoutMillis: 5 });
  await unavailable(lease.query('COMMIT'));
  assert.deepEqual(raw.releases, [true]);

  const transactionClient = fakeClient();
  const manager = createClientLeaseManager(poolFor(transactionClient), { ...short, transactionTimeoutMillis: 5 });
  await unavailable(manager.withClient(async client => {
    await client.query('BEGIN'); spin(); await client.query('COMMIT');
  }));
  assert.deepEqual(transactionClient.calls, ['BEGIN']);
  assert.deepEqual(transactionClient.releases, [true]); await manager.close();

  const lateClient = fakeClient();
  const acquiring = createClientLeaseManager({ connect: () => { spin(); return Promise.resolve(lateClient); }, end: async () => {} },
    { ...short, connectionTimeoutMillis: 5 });
  await unavailable(acquiring.withClient(client => client.query('BEGIN')));
  assert.deepEqual(lateClient.calls, []); assert.deepEqual(lateClient.releases, [true]); await acquiring.close();

  const closing = createClientLeaseManager({ end: () => { spin(); return Promise.resolve(); } }, { ...short, closeTimeoutMillis: 5 });
  await unavailable(closing.close());
}

async function storesBoundRollbackAndClose() {
  for (const create of [createPostgresDatabaseStore, createPostgresCommandApiAuditStore]) {
    const clients = [];
    class Pool extends EventEmitter {
      async connect() {
        const raw = fakeClient(async sql => {
          if (sql.startsWith('SELECT version')) return { rows: MIGRATIONS };
          if (sql.includes('count(*)')) throw Object.assign(new Error('private SQL'), { code: 'XX000' });
          if (sql === 'ROLLBACK') return new Promise(() => {});
          return { rows: [] };
        });
        clients.push(raw); return raw;
      }
      async end() {}
    }
    const store = create({ ...base, ...short, Pool });
    await assert.rejects(store.summary(), { code: 'WORLD_DB_SQL_ERROR' });
    assert.deepEqual(clients.at(-1).releases, [true]);
    await store.close();
  }
}

async function storesRecoverAmbiguousAuditCommit() {
  // The fake database commits the first audit insert, but loses COMMIT's reply.
  // A fresh lease retries the identical request and must return the same row.
  let row = null, commits = 0, inserts = 0, loseReply = false;
  const clients = [];
  class Pool extends EventEmitter {
    async connect() {
      const raw = fakeClient(async (sql, values) => {
        if (sql.startsWith('SELECT version')) return { rows: MIGRATIONS };
        if (sql.includes('command_api_audit_receipts')) return { rows: [] };
        if (sql.includes('INSERT INTO') && sql.includes('command_api_audit')) {
          if (row) return { rows: [] };
          inserts++; loseReply = true;
          row = { sequence: '1', request_id: values[0], world_id: values[1], account_id: values[2], player_id: values[3],
            command_id: values[4], method: values[5], route: values[6], status_code: values[7], error_code: values[8],
            created_at: new Date(0) };
          return { rows: [row] };
        }
        if (sql.startsWith('SELECT *') && sql.includes('command_api_audit')) return { rows: row ? [row] : [] };
        if (sql === 'COMMIT') {
          commits++;
          if (loseReply) { loseReply = false; return new Promise(() => {}); }
        }
        return { rows: [] };
      });
      clients.push(raw); return raw;
    }
    async end() {}
  }
  const store = createPostgresCommandApiAuditStore({ ...base, ...short, Pool });
  const input = { requestId: 'same-audit', method: 'POST', route: 'command', statusCode: 202 };
  await unavailable(store.append(input));
  assert.deepEqual(clients.at(-1).releases, [true]);
  const recovered = await store.append(input);
  assert.equal(recovered.sequence, 1); assert.equal(recovered.idempotent, true);
  assert.equal(inserts, 1); assert.equal(commits, 3);
  await store.close();
}

async function main() {
  const watchdog = setTimeout(() => { console.error('postgres deadline test did not complete'); process.exit(1); }, 10000);
  try {
    for (const test of [configContracts, queryExpiryAndLateOutcomes, totalBudgetIncludesNonSqlAwait,
      totalBudgetDoesNotResetPerQuery, acquisitionExpiryDestroysLateClient, closeCancelsAcquisitionAndBoundsHungQuery,
      closeGracefullyDrainsLeasedWork, closeBoundsNonSqlWorkAndFencesLateCommit,
      closeItselfIsBounded, deadlinesSurviveDelayedTimerCallbacks, storesBoundRollbackAndClose, storesRecoverAmbiguousAuditCommit]) {
      await test(); console.log(`PASS ${test.name}`);
    }
    console.log('postgres deadline test passed (12 scenario groups)');
  } finally { clearTimeout(watchdog); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
