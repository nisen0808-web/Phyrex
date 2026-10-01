'use strict';
const assert = require('assert');
const { canonicalWorldCopy, canonicalizeWorldInPlace } = require('../runtime/canonical-world');
const { canonicalJson, detachedJson } = require('../storage/postgres/codec');
const { createEnduranceWorld } = require('./fixtures/engine-endurance-world');
const { advanceDeterministicBatch } = require('../runtime/durable-world-runtime');
const { repairLoadedWorld } = require('../core/persistence-engine');
const { createCultureBeliefFlowDeterministicKernel, runDeterministicSimulationTickWithCultureBeliefFlow } = require('../core/culture-belief-flow-runtime-engine');
const oldCopy = value => JSON.parse(canonicalJson(detachedJson(value)));
const alias = { z: 1, a: [3, 2, 1], absent: undefined };
const cases = [null, true, false, 0, -0, 1.5, '世界', [], {},
  { z: alias, a: alias, nested: [alias, null, undefined], numeric: { 10: 'ten', 2: 'two' } },
  { date: new Date('2020-01-01T00:00:00Z'), set: new Set([1,2]), map: new Map([['a',1]]) },
  JSON.parse('{"__proto__":{"polluted":true},"constructor":4,"b":2,"a":1}'),
  { toJSON() { return { z: 2, a: 1 }; } },
];
for (let n = 0; n < 100; n++) cases.push({ z: n, a: Array.from({ length: 10 }, (_, i) => ({
  z: { b: (n + i) / 7, a: `${n}-${i}` }, a: [i, n, null, false], missing: undefined,
})) });
for (const value of cases) {
  const before = JSON.stringify(value);
  assert.strictEqual(JSON.stringify(canonicalWorldCopy(value)), JSON.stringify(oldCopy(value)));
  assert.strictEqual(JSON.stringify(value), before, 'capture must not mutate input');
}
const copy = canonicalWorldCopy({ first: alias, second: alias });
copy.first.a.push(99);
assert.deepStrictEqual(copy.second.a, [3,2,1]);
assert.deepStrictEqual(alias.a, [3,2,1]);
const cycle = {}; cycle.self = cycle;
const arrayCycle = []; arrayCycle.push(arrayCycle);
for (const value of [undefined, NaN, Infinity, -Infinity, 1n, () => {}, Symbol('x'), cycle, arrayCycle,
  { bad: NaN }, { bad: () => {} }, [1n]]) {
  assert.throws(() => canonicalWorldCopy(value), error => error.code === 'WORLD_DB_INVALID_INPUT');
}
const world = createEnduranceWorld();
advanceDeterministicBatch(world, 5);
assert.strictEqual(JSON.stringify(canonicalWorldCopy(world)), JSON.stringify(oldCopy(world)));
repairLoadedWorld(world);
const before = oldCopy(world);
canonicalizeWorldInPlace(world);
assert.strictEqual(JSON.stringify(world), JSON.stringify(before));
const reference = createEnduranceWorld(), kernel = createCultureBeliefFlowDeterministicKernel();
for (let tick = 0; tick < 5; tick++) {
  repairLoadedWorld(reference);
  const normalized = oldCopy(reference);
  for (const key of Object.keys(reference)) delete reference[key];
  Object.assign(reference, normalized);
  runDeterministicSimulationTickWithCultureBeliefFlow(reference, {}, kernel);
}
repairLoadedWorld(reference);
assert.strictEqual(JSON.stringify(world), JSON.stringify(oldCopy(reference)), 'full simulation must match the old normalizer');
console.log('canonical world capture passed: legacy byte equivalence, aliases, arrays, finite JSON and cycles');

// Fallback must invoke observable serialization exactly once, in original key
// order. Choosing the fast path may inspect descriptors, never read accessors.
function observableCase(kind, trace) {
  const value = { z: { ordinary: true }, a: {} };
  if (kind === 'getter') Object.defineProperty(value.a, 'answer', { enumerable: true, get() { trace.push('getter'); return 42; } });
  if (kind === 'json') value.a.toJSON = function (key) { trace.push('toJSON:' + key); return { z: 2, a: 1 }; };
  if (kind === 'proxy') value.a = new Proxy({ z: 1, a: 2 }, {
    get(target, key, receiver) { trace.push('get:' + String(key)); return Reflect.get(target, key, receiver); },
    ownKeys(target) { trace.push('keys'); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { trace.push('descriptor:' + String(key)); return Reflect.getOwnPropertyDescriptor(target, key); },
  });
  Object.defineProperty(value, 'last', { enumerable: true, get() { trace.push('last'); return 3; } });
  return value;
}
for (const kind of ['getter', 'json', 'proxy']) {
  const a = [], b = [];
  assert.strictEqual(JSON.stringify(canonicalWorldCopy(observableCase(kind, a))), JSON.stringify(oldCopy(observableCase(kind, b))));
  assert.deepStrictEqual(a, b, kind + ' serialization call order');
}
const sparse = Array(5); sparse[2] = alias;
Object.defineProperty(sparse, 'ignored', { get() { throw new Error('array metadata is not serialized'); } });
assert.strictEqual(JSON.stringify(canonicalWorldCopy(sparse)), JSON.stringify(oldCopy(sparse)));
for (const depth of [300, 12000]) {
  const root = {}; let cursor = root;
  for (let n = 0; n < depth; n++) { cursor.child = {}; cursor = cursor.child; }
  const outcome = copy => { try { return { value: copy(root) }; } catch (error) { return { error: error.code }; } };
  assert.deepStrictEqual(outcome(canonicalWorldCopy), outcome(oldCopy), 'deep values preserve legacy finite-JSON boundary');
}
const sharedNaN = { value: NaN };
assert.throws(() => canonicalWorldCopy({ a: sharedNaN, b: sharedNaN }), error => error.code === 'WORLD_DB_INVALID_INPUT');
const revoked = Proxy.revocable({}, {}); revoked.revoke();
assert.throws(() => canonicalWorldCopy({ nested: revoked.proxy }), error => error.code === 'WORLD_DB_INVALID_INPUT');
const inheritedArray = [, , 3];
Object.setPrototypeOf(inheritedArray, Object.create(Array.prototype, { 1: { value: 42 } }));
assert.strictEqual(JSON.stringify(canonicalWorldCopy(inheritedArray)), JSON.stringify(oldCopy(inheritedArray)));
const setterCalls = [];
Object.defineProperty(Object.prototype, 'captureProbe', { configurable: true, set(value) { setterCalls.push(value); } });
try {
  const input = { z: { captureProbe: 7 }, a: {} };
  Object.defineProperty(input.a, 'getter', { enumerable: true, get() { return 9; } });
  canonicalWorldCopy(input);
  assert.deepStrictEqual(setterCalls, [7], 'legacy capture setter executes once, never in a discarded fast copy');
} finally { delete Object.prototype.captureProbe; }
const arrayInput = Array.from({ length: 1340 }, (_, index) => index);
let arraySetterCalls = 0;
Object.defineProperty(Array.prototype, '1337', { configurable: true, set() { arraySetterCalls++; } });
try {
  const captured = canonicalWorldCopy(arrayInput);
  assert.strictEqual(captured[1337], 1337);
  assert.strictEqual(arraySetterCalls, 0, 'capture must not invoke inherited array setters');
} finally { delete Array.prototype[1337]; }
console.log('canonical fast capture passed: accessor/toJSON/Proxy order, sparse arrays and deep fallback');
