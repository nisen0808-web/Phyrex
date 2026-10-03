'use strict';
const assert = require('assert');
const { buildInfoFlowLinks } = require('../core/info-flow-engine');
const legacy = require('./fixtures/info-flow-links-reference');
let seed = 318001;
const next = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
const limits = [undefined, -2, 0, 1, 1.8, 7, '13', NaN, 'NaN', Infinity, 10000];
for (let run = 0; run < 80; run++) {
  const world = { entities: {}, organizations: { byId: {} }, cities: { byId: {} } };
  for (let n = 0; n < 40; n++) {
    // Collation-equal strings, duplicate entity IDs and key delimiters retain
    // the old deduplication and stable insertion-order tie behavior.
    const id = ['e\u0301', '\u00e9', 'x->entity:y', 'e-' + n, 2, '2'][next(6)];
    world.entities['row-' + n] = { id, status: next(5) ? 'alive' : 'dead', locationId: ['loc-a', 'loc-b', null][next(3)],
      organizationIds: ['org-' + next(5), 'missing', 'org-' + next(5)] };
  }
  const ids = Object.values(world.entities).map(row => row.id);
  for (let n = 0; n < 5; n++) world.organizations.byId['org-' + n] = { id: 'org-' + n, members: [ids[next(ids.length)], ids[next(ids.length)]] };
  for (let n = 0; n < 4; n++) world.cities.byId['city-' + n] = { id: 'city-' + n, locationId: ['loc-a', 'loc-b', 'unknown'][next(3)] };
  for (const limit of limits) {
    const actual = structuredClone(world), expected = structuredClone(world);
    assert.deepStrictEqual(buildInfoFlowLinks(actual, { maxLinksPerTick: limit }), legacy.buildInfoFlowLinks(expected, { maxLinksPerTick: limit }), `run ${run}, limit ${limit}`);
    assert.deepStrictEqual(actual, expected, 'all candidate counters and initialization');
  }
}
const dense = { entities: {} };
for (let n = 0; n < 200; n++) dense.entities['e-' + n] = { id: 'e-' + n, status: 'alive', locationId: 'one' };
const expected = structuredClone(dense);
assert.deepStrictEqual(buildInfoFlowLinks(dense, { maxLinksPerTick: 120 }), legacy.buildInfoFlowLinks(expected, { maxLinksPerTick: 120 }));
assert.deepStrictEqual(dense, expected);
assert.strictEqual(dense.infoFlow.stats.linksCreated, 200 * 199);
console.log('info-flow selection passed: 880 limit/order comparisons, Unicode ties and dense all-candidate counters');
