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
