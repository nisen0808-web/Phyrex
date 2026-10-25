'use strict';
// Real lease deadlines plus the production durable runtime, using an in-memory
// commit ledger and a controlled driver. Real SQL/transport is tested separately.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWorld } = require('../core/world-engine');
const { createDurableWorldRuntime } = require('../runtime/durable-world-runtime');
const { createClientLeaseManager } = require('../storage/postgres/client-lease');
const { detachedJson } = require('../storage/postgres/codec');

function fixture() {
  const initial = createWorld({ id: 'runtime-local-deadline', seed: 'local-deadline' });
  const ledger = { world: detachedJson(initial), revision: 1, records: [], attempts: [], releases: [],
    hangRead: false, loseCommit: false, simulations: 0, notices: 0 };
  const pool = { async connect() {
    const client = new EventEmitter();
    client.query = async sql => {
      if (sql === 'pending' && ledger.hangRead) return new Promise(() => {});
      if (sql === 'COMMIT' && client.commit) {
        client.commit();
        if (ledger.loseCommit) { ledger.loseCommit = false; return new Promise(() => {}); }
      }
      return { rows: [] };
    };
    client.release = broken => { ledger.releases.push(broken); if (broken) queueMicrotask(() => client.emit('end')); };
    return client;
  }, async end() {} };
  const manager = createClientLeaseManager(pool, { queryTimeoutMillis: 100, transactionTimeoutMillis: 2000,
    connectionTimeoutMillis: 1000, closeTimeoutMillis: 1000 });
  const store = { provider: 'postgres',
    async loadWorld() { return { world: detachedJson(ledger.world), worldId: initial.id,
      tick: ledger.world.tick, revision: ledger.revision }; },
    listPendingCommands() { return manager.withClient(async lease => { await lease.query('pending'); return []; }); },
    saveWorld(candidate, options) {
      const attempt = { world: detachedJson(candidate), options: detachedJson(options) };
      ledger.attempts.push(attempt);
      return manager.withClient(async lease => {
        await lease.query('BEGIN');
        const existing = ledger.records.find(row => row.id === options.requestId);
        if (existing) { await lease.query('COMMIT'); return { ...existing, idempotent: true }; }
        assert.equal(options.expectedRevision, ledger.revision, 'revision fence is preserved');
        // Attach the modeled database commit to the actual controlled client.
        // The next lease COMMIT really updates this ledger before its reply hangs.
        const commit = () => {
          ledger.world = detachedJson(candidate); ledger.revision++;
          ledger.records.push({ id: options.requestId, revision: ledger.revision,
            worldId: candidate.id, tick: candidate.tick });
        };
        pendingCommit = commit;
        await lease.query('COMMIT');
        return ledger.records.at(-1);
      });
    }, close: () => manager.close(),
  };
  // Route COMMIT into the ledger independently of the runtime's receipt path.
  let pendingCommit;
  const connect = pool.connect;
  pool.connect = async () => {
    const client = await connect();
    const query = client.query;
    client.query = sql => { if (sql === 'COMMIT' && pendingCommit) { client.commit = pendingCommit; pendingCommit = null; } return query(sql); };
    return client;
  };
  return { ledger, options: { worldId: initial.id, store, closeStore: true,
    simulationId: 'deadline-ledger', advance(world, ticks) { ledger.simulations++; world.tick += ticks; },
    onCommit() { ledger.notices++; } } };
}

async function main() {
  {
    const { ledger, options } = fixture();
    const runtime = await createDurableWorldRuntime(options);
    try {
      ledger.hangRead = true;
      await assert.rejects(runtime.step(), { code: 'WORLD_DB_UNAVAILABLE' });
      assert.equal(runtime.summary().busy, false); assert.equal(runtime.summary().failures, 1);
      assert.equal(runtime.summary().lastError, 'WORLD_DB_UNAVAILABLE');
      assert.equal(runtime.summary().pending, null); assert.equal(runtime.getWorld().tick, 0);
      assert.equal(ledger.simulations, 0); assert.ok(ledger.releases.includes(true));
      ledger.hangRead = false;
      await runtime.retry();
      assert.equal(runtime.summary().tick, 1); assert.equal(runtime.summary().revision, 2);
      assert.equal(runtime.summary().lastError, null);
    } finally { await runtime.close(); }
  }
  {
    const { ledger, options } = fixture();
    const runtime = await createDurableWorldRuntime(options);
    try {
      ledger.loseCommit = true;
      await assert.rejects(runtime.step(3), { code: 'WORLD_DB_UNAVAILABLE' });
      const requestId = runtime.summary().pending.requestId;
      assert.equal(ledger.world.tick, 3); assert.equal(ledger.revision, 2);
      assert.equal(runtime.getWorld().tick, 0); assert.equal(runtime.summary().revision, 1);
      const recovered = await runtime.step(9);
      assert.equal(recovered.idempotent, true); assert.equal(recovered.ticks, 3);
      assert.equal(recovered.requestId, requestId); assert.equal(ledger.simulations, 1);
      assert.equal(ledger.records.length, 1); assert.equal(ledger.notices, 1);
      assert.deepEqual(ledger.attempts[0], ledger.attempts[1], 'retry retains the frozen candidate and request');
      assert.equal(runtime.getWorld().tick, 3); assert.equal(runtime.summary().revision, 2);
    } finally { await runtime.close(); }
  }
  console.log('durable runtime local deadline passed: hung read leaves busy, lost commit reply preserves frozen candidate and publishes once (controlled ledger)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
