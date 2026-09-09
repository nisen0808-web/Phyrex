'use strict';
// Independent runtime process; IPC is a test barrier, not a database mock.
const { createDurableWorldRuntime } = require('../../core/durable-runtime-engine');
async function main() {
  const [schema, worldId, ticks] = process.argv.slice(2);
  const runtime = await createDurableWorldRuntime({ worldId, database: {
    connectionString: process.env.WORLD_ENGINE_TEST_DATABASE_URL, schema,
  } });
  process.send({ type: 'ready', revision: runtime.summary().revision });
  await new Promise(resolve => process.once('message', resolve));
  try { await runtime.step(Number(ticks)); process.send({ type: 'committed', ...runtime.summary() }); }
  catch (error) { process.send({ type: 'failed', error: error.code, ...runtime.summary() }); process.exitCode = 2; }
  finally { await runtime.close({ flush: false }); }
  process.disconnect();
}
main().catch(error => { console.error(error.code || 'WORKER_FAILED'); process.exitCode = 1; if (process.connected) process.disconnect(); });
