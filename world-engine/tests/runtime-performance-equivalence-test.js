'use strict';
const assert = require('assert');
const { trimGlobalMemories, createMemory, reinforceMemory } = require('../core/memory-engine');
const { processDesireTick } = require('../core/desire-engine');
const { createEngineWorld } = require('../demo/engine-v1-world');
const { legacyTrimGlobalMemories, legacyProcessDesireTick } = require('./fixtures/performance-reference');
const integrity = require('../core/state-integrity-engine');
const legacyIntegrity = require('./fixtures/state-integrity-reference');
let seed = 81237;
const next = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
function memoryWorld() {
  const world = { tick: 10, memories: { byId: {}, byOwner: {}, indexes: { byType: {}, byScope: {}, byTag: {} },
    consumedWorldMemoryIds: [], stats: { created: 0, reinforced: 0, faded: 0, pruned: next(10) } } };
  for (let n = 0; n < 40; n++) {
    const id = n % 3 ? 'mem-' + n : String(n);
    const ownerId = 'owner-' + next(8), key = 'entity:' + ownerId;
    const row = { id, ownerType: 'entity', ownerId, importance: [0, 2, 5, 5, -1][next(5)],
      clarity: next(3), emotionalWeight: next(5) - 2, createdAt: next(4), lastReinforcedAt: next(3) };
    world.memories.byId[id] = row;
    (world.memories.byOwner[key] ||= []).push(id);
  }
  world.memories.byOwner['entity:missing'] = ['absent'];
  if (next(2)) world.memories.byOwner['entity:duplicate'] = Object.keys(world.memories.byId).slice(0, 4);
  return world;
}
const limits = [0, 1, 5, 20, 39, 40, 100, -1, 2.5, '7'];
for (let n = 0; n < 1000; n++) {
  const actual = memoryWorld(), expected = structuredClone(actual);
  for (let step = 0; step < 3; step++) {
    const global = limits[next(limits.length)], owner = limits[next(limits.length)];
    assert.deepStrictEqual(trimGlobalMemories(actual, global, owner), legacyTrimGlobalMemories(expected, global, owner), 'pruning order ' + n);
    assert.deepStrictEqual(actual, expected, 'retained state ' + n);
  }
}
// Non-finite legacy inputs retain the old sort fallback; normal runtime rejects
// them at its finite JSON boundary. Scores tied at the cutoff keep earlier IDs.
for (const unusual of [NaN, Infinity, -Infinity]) {
  const actual = memoryWorld(); actual.memories.byId[Object.keys(actual.memories.byId)[0]].importance = unusual;
  const expected = structuredClone(actual);
  assert.deepStrictEqual(trimGlobalMemories(actual, 39, 100), legacyTrimGlobalMemories(expected, 39, 100));
  assert.deepStrictEqual(actual, expected);
}
const tie = { tick: 1 };
for (let n = 0; n < 30; n++) createMemory(tie, { id: 'tie-' + n, ownerType: 'entity', ownerId: 'one',
  summary: 'same', importance: 10, maxMemoriesPerOwner: 100, maxGlobalMemories: 20 });
assert.deepStrictEqual(Object.keys(tie.memories.byId), Array.from({ length: 20 }, (_, n) => 'tie-' + n));
reinforceMemory(tie, 'tie-19', 100);
const expectedTie = structuredClone(tie);
assert.deepStrictEqual(trimGlobalMemories(tie, 5, 100), legacyTrimGlobalMemories(expectedTie, 5, 100));
assert.deepStrictEqual(tie, expectedTie);

// Compare against the old per-entity relationship scan, including self edges,
// exact floating-point summation order and mutations between invocations.
const actual = createEngineWorld({ seed: 'desire-performance-equivalence', population: 8 });
const ids = Object.keys(actual.entities);
actual.relationships = {};
for (let n = 0; n < 8; n++) {
  actual.relationships[ids[n] + '->' + ids[n]] = { affection: [1e16, 1, -1e16, 0.1][n % 4], fear: n / 7 };
  actual.relationships[ids[n] + '->' + ids[(n + 1) % 8]] = { affection: n / 3, trust: n / 7, hatred: n * 2 };
}
const expected = structuredClone(actual);
for (let tick = 1; tick <= 5; tick++) {
  actual.tick = expected.tick = tick;
  if (tick === 2) actual.entities[ids[3]].status = expected.entities[ids[3]].status = 'dead';
  actual.relationships[ids[0] + '->' + ids[1]].affection = expected.relationships[ids[0] + '->' + ids[1]].affection = tick / 11;
  assert.deepStrictEqual(processDesireTick(actual), legacyProcessDesireTick(expected));
  assert.deepStrictEqual(actual, expected);
}
const shared = { z: [1, undefined, NaN, -0], a: true };
const values = [null, false, 0, -0, 1.5, NaN, Infinity, -Infinity, undefined, 10n, Symbol('x'), () => {},
  Buffer.from([0, 128, 255]), new Date('2020-01-01T00:00:00Z'), new Set([3, 2, 1, undefined]),
  new Map([[2, shared], ['2', 1]]), { b: shared, a: shared },
  JSON.parse('{"__proto__":{"value":1},"constructor":2,"10":"ten","2":"two"}')];
for (let n = 0; n < 100; n++) values.push({ z: n / 3, nested: { x: n, b: [n, null, { c: -0 }] }, a: undefined });
for (const value of values) {
  for (const options of [{}, { excludePaths: ['nested.x', 'z'] }, { excludePaths: ['nested.*', /^a$/g] }]) {
    const a = structuredClone(options), b = structuredClone(options);
    assert.strictEqual(integrity.stableStringify(value, a), legacyIntegrity.stableStringify(value, b));
  }
}
for (const value of [{ a: shared }, new Set([shared]), new Map([['x', shared]])]) {
  value.cycle = value; // Object cycle path remains part of the public error.
  if (value instanceof Set) value.add(value);
  if (value instanceof Map) value.set('self', value);
  let a, b;
  try { integrity.stableStringify(value); } catch (error) { a = error.message; }
  try { legacyIntegrity.stableStringify(value); } catch (error) { b = error.message; }
  assert.ok(a); assert.strictEqual(a, b);
}
console.log('runtime performance equivalence passed: 3000 retention comparisons, relationship phases and canonical integrity');

