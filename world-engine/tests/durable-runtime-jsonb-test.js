'use strict';
// Emulates the storage-order transformation, not SQL transaction semantics.
const assert = require('assert');
const { createWorld } = require('../core/world-engine');
const { buildDemoWorld } = require('../demo/run-demo');
const { decayRelationships } = require('../core/relationship-engine');
const { processEvents } = require('../core/event-engine');
const { createDurableWorldRuntime, advanceDeterministicBatch } = require('../core/durable-runtime-engine');
const { repairLoadedWorld } = require('../core/persistence-engine');
const { captureCheckpoint, restoreSave, detachedJson, digest } = require('../storage/postgres/codec');

function jsonbOrder(value) {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value)
    .sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(key => [key, jsonbOrder(value[key])]));
  return value;
}
function roundTrip(world, revision = 1, options = {}) {
  const checkpoint = captureCheckpoint(world, { requestId: 'roundtrip', expectedRevision: revision - 1, ...options });
  return restoreSave({ request_id: checkpoint.requestId, world_id: world.id, revision: String(revision), sequence: String(revision),
    tick: String(world.tick), save_schema: 1, saved_at: '2020-01-01T00:00:00Z',
    payload_digest: checkpoint.checksum, envelope: jsonbOrder(checkpoint.envelope) });
}
async function main() {
  let groups = 0;
  for (const initial of [createWorld({ id: 'empty', seed: 'empty' }), buildDemoWorld()]) {
    let saved = roundTrip(initial);
    const store = { provider: 'postgres', loadWorld: async () => detachedJson(saved), close: async () => {},
      saveWorld: async (world, options) => { saved = roundTrip(world, saved.revision + 1, options); return saved; } };
    const options = { store, worldId: initial.id };
    const direct = detachedJson(saved.world);
    for (let i = 0; i < 2; i += 1) { advanceDeterministicBatch(direct, 2); repairLoadedWorld(direct); }
    const first = await createDurableWorldRuntime(options); await first.step(2); await first.close();
    const second = await createDurableWorldRuntime(options); await second.step(2); await second.close();
    assert.strictEqual(digest(second.getWorld()), digest(direct));
    assert.strictEqual(digest(saved.world), digest(direct));
    groups += 1; console.log(`PASS JSONB key-order restart equality for ${Object.keys(initial.entities).length} entities`);
  }
  const initial = buildDemoWorld(), oneBatch = detachedJson(initial), twoBatches = detachedJson(initial);
  advanceDeterministicBatch(oneBatch, 4); repairLoadedWorld(oneBatch);
  advanceDeterministicBatch(twoBatches, 2); repairLoadedWorld(twoBatches);
  advanceDeterministicBatch(twoBatches, 2); repairLoadedWorld(twoBatches);
  assert.strictEqual(digest(oneBatch), digest(twoBatches));
  groups += 1; console.log('PASS canonical tick order is independent of checkpoint batch size');
  const loaded = roundTrip(createWorld({ id: 'options' }));
  const store = { provider: 'postgres', loadWorld: async () => loaded, saveWorld: async () => {}, close: async () => {} };
  await assert.rejects(createDurableWorldRuntime({ store, worldId: 'options', simulation: [] }), e => e.code === 'WORLD_RUNTIME_INVALID_SIMULATION_OPTIONS');
  const r = await createDurableWorldRuntime({ store, worldId: 'options', retryDelayMs: 60000 }); await r.close();
  groups += 1; console.log('PASS simulation config validation and valid long retry delay');
  const relationWorld = createWorld({ id: 'decay' });
  relationWorld.relationships['a->b'] = { affection: 10, hatred: -10 };
  processEvents(relationWorld);
  assert.strictEqual(relationWorld.relationships['a->b'].affection, 9.99);
  assert.strictEqual(relationWorld.relationships['a->b'].hatred, -9.99);
  assert.ok(Object.values(relationWorld.relationships['a->b']).every(Number.isFinite));
  decayRelationships(relationWorld, { rate: 0 });
  assert.strictEqual(relationWorld.relationships['a->b'].affection, 9.99);
  decayRelationships(relationWorld, 0.99);
  assert.strictEqual(relationWorld.relationships['a->b'].affection, 9);
  assert.throws(() => decayRelationships(relationWorld, { rate: NaN }));
  groups += 1; console.log('PASS relationship decay options produce finite persisted values');
  console.log(`durable JSONB ordering contracts completed ${groups} groups: ${groups} passed, 0 failed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
