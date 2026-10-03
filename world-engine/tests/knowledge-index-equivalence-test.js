'use strict';
const assert = require('assert');
const memory = require('../core/memory-engine');
const information = require('../core/information-engine');
const reference = require('./fixtures/knowledge-index-reference');
const { addOrderedIndex } = require('../core/ordered-index-engine');
let seed = 910217;
const next = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
for (let run = 0; run < 150; run++) {
  const actual = { tick: run };
  memory.ensureMemoryState(actual); information.ensureInformationState(actual);
  for (let n = 0; n < 160; n++) {
    const id = [n, String(n), 'id-' + next(60)][next(3)];
    const tags = ['tag-' + next(4), 'tag-' + next(4), 2, '2', null, undefined];
    actual.memories.byId['row-' + n] = { id, type: 'type-' + next(3), scope: 'scope-' + next(3), tags };
    actual.information.items['row-' + n] = { id, type: 'type-' + next(3), status: 'status-' + next(2),
      originLocationId: next(3) ? 'location-' + next(2) : null, tags };
  }
  const expected = structuredClone(actual);
  for (let step = 0; step < 5; step++) {
    const force = step % 2 === 0;
    memory.rebuildMemoryIndexes(actual, force); reference.rebuildMemoryIndexes(expected, force);
    information.rebuildInformationIndexes(actual, force); reference.rebuildInformationIndexes(expected, force);
    assert.deepStrictEqual(actual, expected, `run ${run}, step ${step}`);
    assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), 'serialized order');
    const key = 'row-' + (1 + next(159));
    for (const world of [actual, expected]) {
      delete world.memories.byId[key]; delete world.information.items[key];
      world.memories.byId['row-0'].tags.push('late-' + step);
      world.information.items['row-0'].status = 'updated-' + step;
      if (step === 1) {
        world.memories.indexes.byType['type-0'].reverse();
        world.information.indexes.byType['type-0'].push('external');
      }
    }
  }
}
// Array.includes and Set.has use the same SameValueZero identity rule.
const index = {}, membership = new Map(), object = {};
for (const value of [NaN, NaN, 0, -0, 2, '2', object, object, {}, undefined, undefined]) addOrderedIndex(index, 'tag', value, membership);
assert.strictEqual(index.tag.length, 7);
assert.ok(Number.isNaN(index.tag[0]));
assert.strictEqual(index.tag[4], object);
// Incremental calls deliberately re-read mutable arrays, with no stale cache.
index.tag.length = 0; addOrderedIndex(index, 'tag', NaN); addOrderedIndex(index, 'tag', NaN);
assert.strictEqual(index.tag.length, 1);
const world = { tick: 1 };
for (let n = 0; n < 40; n++) {
  memory.createMemory(world, { id: 'm-' + n % 5, ownerType: 'entity', ownerId: 'a', summary: 'synthetic', tags: ['x', 'x'] });
  information.createInformation(world, { id: 'i-' + n % 5, summary: 'synthetic', tags: ['x', 'x'] });
}
const expected = structuredClone(world);
memory.rebuildMemoryIndexes(world, true); reference.rebuildMemoryIndexes(expected, true);
information.rebuildInformationIndexes(world, true); reference.rebuildInformationIndexes(expected, true);
assert.deepStrictEqual(world, expected);
console.log('knowledge indexes passed: 750 rebuild comparisons, duplicate IDs/tags, order and mutable arrays');
