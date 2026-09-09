'use strict';
// Lifecycle contract tests use a controlled store, not a claim of SQL integration.
const assert = require('assert');
const { setTimeout: delay } = require('timers/promises');
const { createDurableWorldRuntime, advanceDeterministicBatch } = require('../core/durable-runtime-engine');
const { createWorld } = require('../core/world-engine');
const { repairLoadedWorld } = require('../core/persistence-engine');
const { detachedJson, digest } = require('../storage/postgres/codec');
const { randomFloat } = require('../core/random-engine');
const { nextWorldId } = require('../core/world-id-engine');
const { parseArgs } = require('../demo/durable-runtime-cli');

const code = name => error => error.code === name;
function fail(name) { const error = new Error('private payload must not be logged'); error.code = name; return error; }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const world = createWorld({ id: 'durable_world', seed: 'durable-seed' }); repairLoadedWorld(world);
  const ledger = { world: detachedJson(world), revision: 1, records: [], saves: [], closes: 0, metadata: {} };
  const store = {
    provider: 'postgres',
    async loadWorld(id) { return id === world.id ? { world: detachedJson(ledger.world), worldId: id,
      tick: ledger.world.tick, revision: ledger.revision, metadata: ledger.metadata } : null; },
    async saveWorld(candidate, options) {
      ledger.saves.push({ world: detachedJson(candidate), options: detachedJson(options) });
      const previous = ledger.records.find(r => r.id === options.requestId);
      if (previous) return { ...previous, idempotent: true };
      if (options.expectedRevision !== ledger.revision) throw fail('WORLD_DB_REVISION_CONFLICT');
      ledger.world = detachedJson(candidate); ledger.revision += 1; ledger.metadata = detachedJson(options.metadata);
      const result = { id: options.requestId, revision: ledger.revision, worldId: candidate.id, tick: candidate.tick };
      ledger.records.push(result); return result;
    },
    async close() { ledger.closes += 1; },
  };
  let simulations = 0;
  function advance(candidate, ticks) {
    simulations += 1;
    for (let n = 0; n < ticks; n += 1) {
      candidate.tick += 1; candidate.sample = randomFloat(candidate, 'runtime-test');
      candidate.event = nextWorldId(candidate, 'sample', 'runtime-test');
    }
  }
  return { world, ledger, store, advance, simulations: () => simulations,
    options: { store, worldId: world.id, advance, simulationId: 'controlled-v1' } };
}
async function main() {
  let groups = 0;
  const pass = name => { groups += 1; console.log(`PASS ${name}`); };
  {
    const f = fixture(), gate = deferred(), entered = deferred();
    const save = f.store.saveWorld;
    f.store.saveWorld = async (...args) => { entered.resolve(); await gate.promise; return save(...args); };
    const runtime = await createDurableWorldRuntime(f.options);
    const pending = runtime.step(2); await entered.promise;
    assert.strictEqual(runtime.getWorld().tick, 0); assert.strictEqual(runtime.summary().revision, 1);
    await assert.rejects(runtime.step(), code('WORLD_RUNTIME_BUSY'));
    const close = runtime.close(); assert.strictEqual(runtime.summary().status, 'closing');
    gate.resolve(); assert.strictEqual((await pending).tickAfter, 2); await close;
    assert.strictEqual(runtime.summary().tick, 2); await assert.rejects(runtime.step(), code('WORLD_RUNTIME_CLOSED'));
    pass('single-flight, commit-before-publication and close drains the in-flight transaction');
  }
  {
    const f = fixture(), save = f.store.saveWorld; let attempts = 0;
    f.store.saveWorld = async (...args) => { attempts += 1; if (attempts === 1) throw fail('WORLD_DB_UNAVAILABLE'); return save(...args); };
    const r = await createDurableWorldRuntime(f.options);
    await assert.rejects(r.step(3)); const request = r.summary().pending.requestId;
    assert.strictEqual(r.getWorld().tick, 0); r.getWorld().tick = 999;
    assert.strictEqual((await r.step(9)).ticks, 3); assert.strictEqual(f.simulations(), 1);
    assert.strictEqual(f.ledger.saves[0].options.requestId, request);
    assert.strictEqual(r.summary().tick, 3); assert.ok(!JSON.stringify(r.summary()).includes('private payload'));
    await r.close(); pass('retry keeps one candidate and does not consume extra ticks or randomness');
  }
  {
    const f = fixture(), save = f.store.saveWorld; let first = true, notices = 0;
    f.store.saveWorld = async (...args) => { const result = await save(...args); if (first) { first = false; throw fail('WORLD_DB_UNAVAILABLE'); } return result; };
    const r = await createDurableWorldRuntime({ ...f.options, onCommit: () => { notices += 1; throw new Error('observer failed'); } });
    await assert.rejects(r.step()); assert.strictEqual(r.getWorld().tick, 0); assert.strictEqual(f.ledger.world.tick, 1);
    assert.strictEqual((await r.retry()).idempotent, true); assert.strictEqual(f.ledger.records.length, 1);
    assert.deepStrictEqual(f.ledger.saves[0], f.ledger.saves[1]);
    assert.strictEqual(f.simulations(), 1); assert.strictEqual(notices, 1); assert.strictEqual(r.summary().observerErrors, 1);
    await r.close(); pass('lost commit acknowledgement is reconciled once; observer failure does not resave');
  }
  {
    const f = fixture(); f.store.saveWorld = async () => { throw fail('WORLD_DB_REVISION_CONFLICT'); };
    const r = await createDurableWorldRuntime(f.options);
    await assert.rejects(r.step()); assert.strictEqual(r.summary().status, 'blocked');
    await assert.rejects(r.step(), code('WORLD_RUNTIME_BLOCKED')); await assert.rejects(r.retry(), code('WORLD_RUNTIME_NOT_RETRYABLE'));
    await assert.rejects(r.close(), code('WORLD_RUNTIME_UNCONFIRMED_CHECKPOINT'));
    assert.strictEqual(r.getWorld().tick, 0); pass('revision conflict blocks further writes and is not hidden by shutdown');
  }
  {
    const f = fixture();
    const r = await createDurableWorldRuntime({ ...f.options, advance: world => { world.tick += 1; throw new Error('broken simulation'); } });
    const initial = digest(r.getWorld()); await assert.rejects(r.step());
    assert.strictEqual(digest(r.getWorld()), initial); assert.strictEqual(f.ledger.saves.length, 0);
    assert.strictEqual(r.summary().status, 'blocked'); await r.close(); pass('simulation failure discards isolated state before any database write');
  }
  {
    const f = fixture(); const r = await createDurableWorldRuntime({ ...f.options, advance: world => { world.tick += 1; world.bad = NaN; } });
    await assert.rejects(r.step()); assert.strictEqual(f.ledger.saves.length, 0); await r.close();
    await assert.rejects(createDurableWorldRuntime({ ...f.options, worldId: 'missing' }), code('WORLD_RUNTIME_MISSING_WORLD'));
    await assert.rejects(createDurableWorldRuntime({ ...f.options, store: { ...f.store, provider: 'jsonl' } }), code('WORLD_RUNTIME_TRANSACTIONAL_STORE_REQUIRED'));
    await assert.rejects(createDurableWorldRuntime({ ...f.options, ticksPerBatch: 0 }));
    pass('finite state, required world, SQL-only store and bounded options');
  }
  {
    const f = fixture(); const r = await createDurableWorldRuntime(f.options);
    await r.step(2); const expected = r.getWorld(); f.advance(expected, 1);
    await r.close(); const resumed = await createDurableWorldRuntime(f.options); await resumed.step();
    assert.strictEqual(digest(resumed.getWorld()), digest(expected)); await resumed.close();
    await assert.rejects(createDurableWorldRuntime({ ...f.options, simulation: { different: true } }), code('WORLD_RUNTIME_CONFIG_MISMATCH'));
    pass('restart continues committed random streams and ID counters, rejects changed simulation configuration');
  }
  {
    const f = fixture(); const save = f.store.saveWorld;
    f.store.saveWorld = async () => { throw fail('WORLD_DB_TIMEOUT'); };
    const r = await createDurableWorldRuntime({ ...f.options, intervalMs: 10, retryDelayMs: 10, maxCommitAttempts: 2 });
    r.start();
    for (let n = 0; n < 100 && r.summary().status !== 'blocked'; n += 1) await delay(10);
    assert.strictEqual(r.summary().status, 'blocked'); assert.strictEqual(r.summary().pending.attempts, 2);
    assert.strictEqual(f.simulations(), 1); assert.strictEqual(r.summary().running, false);
    f.store.saveWorld = save; await r.retry(); assert.strictEqual(r.summary().tick, 1); await r.close();
    pass('automatic retries are bounded and backpressured; manual recovery retains the batch');
  }
  {
    const f = fixture(); const save = f.store.saveWorld; let first = true;
    f.store.saveWorld = async (...args) => { if (first) { first = false; throw fail('WORLD_DB_UNAVAILABLE'); } return save(...args); };
    const r = await createDurableWorldRuntime({ ...f.options, closeStore: true });
    await assert.rejects(r.step()); await Promise.all([r.close(), r.close()]);
    assert.strictEqual(r.summary().tick, 1); assert.strictEqual(f.ledger.closes, 1); assert.strictEqual(f.simulations(), 1);
    pass('shutdown retries one pending checkpoint and closes an owned store once');
  }
  {
    const f = fixture(); f.store.saveWorld = async () => { throw fail('WORLD_DB_UNAVAILABLE'); };
    const r = await createDurableWorldRuntime({ ...f.options, closeStore: true }); await assert.rejects(r.step());
    await assert.rejects(r.close(), code('WORLD_RUNTIME_UNCONFIRMED_CHECKPOINT'));
    assert.strictEqual(r.summary().status, 'closed'); assert.ok(r.summary().pending); assert.strictEqual(f.ledger.closes, 1);
    pass('failed shutdown never labels an unconfirmed checkpoint as committed');
  }
  {
    const f = fixture(), notifications = [];
    const r = await createDurableWorldRuntime({ ...f.options, intervalMs: 10, onCommit: (result, world) => { notifications.push(result); world.tick = 99; } });
    r.start();
    for (let n = 0; n < 100 && !notifications.length; n += 1) await delay(10);
    r.pause(); const tick = r.summary().tick; await delay(30); assert.strictEqual(r.summary().tick, tick);
    assert.ok(tick >= 1 && tick < 99); await r.close(); pass('continuous timer, pause and detached observer state');
  }
  {
    const f = fixture(), r = await createDurableWorldRuntime({ store: f.store, worldId: f.world.id, simulation: { autoNovel: false } });
    const expected = r.getWorld(); advanceDeterministicBatch(expected, 2, { autoNovel: false }); repairLoadedWorld(expected);
    await r.step(2); assert.strictEqual(digest(r.getWorld()), digest(expected));
    assert.ok(r.getWorld().cultureBeliefFlow); assert.ok(r.getWorld().infoFlow);
    await r.close(); pass('default full deterministic kernel includes information and culture-belief flow');
  }
  assert.strictEqual(parseArgs(['--world-id', 'world', '--continuous']).continuous, true);
  assert.throws(() => parseArgs(['--continuous', '--batches', '2'])); assert.throws(() => parseArgs(['--password', 'secret']));
  pass('CLI rejects conflicting modes and unknown credential flags');
  console.log(`durable runtime contracts completed ${groups} groups: ${groups} passed, 0 failed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
