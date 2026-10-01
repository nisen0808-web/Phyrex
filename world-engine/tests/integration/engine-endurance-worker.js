'use strict';
const { Pool } = require('pg');
const { createPostgresDatabaseStore } = require('../../storage/postgres/store');
const { createDurableWorldRuntime } = require('../../runtime/durable-world-runtime');
const { digest } = require('../../storage/postgres/codec');

async function main() {
  const [schema, mode] = process.argv.slice(2);
  if (!/^test_endurance_[a-f0-9]+$/.test(schema) || !['normal', 'lost-ack', 'rollback'].includes(mode)) throw new Error('Invalid worker arguments');
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  if (!connectionString || !/_(ci|test)$/.test(new URL(connectionString).pathname)) throw new Error('Isolated test database required');
  const store = createPostgresDatabaseStore({ connectionString, schema });
  const raw = new Pool({ connectionString, max: 1 });
  let runtime, injected = false, observedFailure = false, retryRequestId = null;
  try {
    if (mode === 'rollback') {
      await raw.query(`CREATE FUNCTION "${schema}".endurance_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.type='runtime.batch_committed' THEN RAISE EXCEPTION 'injected retry' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`);
      await raw.query(`CREATE TRIGGER endurance_fail BEFORE INSERT ON "${schema}".world_events FOR EACH ROW EXECUTE FUNCTION "${schema}".endurance_fail()`);
    }
    const adapter = { ...store, saveWorld: async (...args) => {
      const result = await store.saveWorld(...args);
      if (mode === 'lost-ack' && !injected) {
        injected = true;
        const error = new Error('injected lost acknowledgement'); error.code = 'WORLD_DB_UNAVAILABLE'; throw error;
      }
      return result;
    } };
    runtime = await createDurableWorldRuntime({ worldId: 'engine-endurance', store: adapter });
    const startedAt = runtime.summary().tick;
    for (let n = 0; n < 25; n++) {
      const before = runtime.summary();
      try { await runtime.step(10); }
      catch (error) {
        if (observedFailure || mode === 'normal') throw error;
        if (mode === 'rollback' && error.sqlState !== '40001') throw error;
        if (mode === 'lost-ack' && error.code !== 'WORLD_DB_UNAVAILABLE') throw error;
        observedFailure = true;
        if (runtime.summary().tick !== before.tick) throw new Error('Unconfirmed state published');
        const stored = await store.loadWorld('engine-endurance');
        const expectedRevision = before.revision + (mode === 'lost-ack' ? 1 : 0);
        if (stored.revision !== expectedRevision) throw new Error('Unexpected rollback/commit boundary');
        retryRequestId = runtime.summary().pending.requestId;
        if (mode === 'rollback') await raw.query(`DROP TRIGGER endurance_fail ON "${schema}".world_events`);
        const retry = await runtime.retry();
        if (retry.requestId !== retryRequestId || retry.idempotent !== (mode === 'lost-ack')) throw new Error('Retry changed its candidate');
      }
    }
    const result = { startedAt, mode, observedFailure, retryRequestId, summary: runtime.summary(), digest: digest(runtime.getWorld()) };
    await runtime.close();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    if (runtime) await runtime.close({ flush: false }).catch(() => {});
    await store.close(); await raw.end();
  }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
