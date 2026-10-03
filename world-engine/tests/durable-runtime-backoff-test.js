'use strict';
const assert = require('assert');
const { createWorld } = require('../core/world-engine');
const { createDurableWorldRuntime } = require('../core/durable-runtime-engine');
const { detachedJson } = require('../storage/postgres/codec');

async function main() {
  let world = createWorld({ id: 'backoff' }), revision = 1, readingFails = true, savingFails = false, advances = 0;
  const unavailable = () => { const error = new Error('private'); error.code = 'WORLD_DB_UNAVAILABLE'; throw error; };
  const store = { provider: 'postgres', async close() {},
    async loadWorld() { return { world: detachedJson(world), worldId: world.id, tick: world.tick, revision }; },
    async listPendingCommands() { if (readingFails) unavailable(); return []; },
    async saveWorld(candidate, options) {
      if (savingFails) unavailable();
      world = detachedJson(candidate); revision++;
      return { worldId: world.id, tick: world.tick, revision, id: options.requestId };
    },
  };
  const runtime = await createDurableWorldRuntime({ worldId: world.id, store, intervalMs: 10,
    retryDelayMs: 100, maxRetryDelayMs: 250, maxCommitAttempts: 5, simulationId: 'backoff-test',
    advance: (candidate, ticks) => { advances++; candidate.tick += ticks; } });
  assert.strictEqual(runtime.summary().nextDelayMs, 10);
  for (const delay of [100, 200, 250]) {
    await assert.rejects(runtime.step());
    assert.strictEqual(runtime.summary().nextDelayMs, delay);
    assert.strictEqual(runtime.summary().pending, null);
  }
  assert.strictEqual(advances, 0, 'read failures never simulate');
  readingFails = false;
  await runtime.step();
  assert.strictEqual(runtime.summary().nextDelayMs, 10);
  savingFails = true;
  for (const delay of [100, 200, 250]) {
    await assert.rejects(runtime.step());
    assert.strictEqual(runtime.summary().nextDelayMs, delay);
  }
  assert.strictEqual(advances, 2, 'commit retry reuses its only candidate');
  savingFails = false;
  await runtime.step();
  assert.strictEqual(runtime.summary().nextDelayMs, 10);
  assert.strictEqual(runtime.summary().tick, 2);
  await runtime.close();
  console.log('durable runtime backoff passed: read and commit backoff, cap, reset and no replay');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
