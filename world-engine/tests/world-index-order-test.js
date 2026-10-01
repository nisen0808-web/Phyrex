'use strict';
const assert = require('assert');
const { createWorld, registerLocation, registerEntity } = require('../core/world-engine');
const { auditWorldConsistency, repairWorldConsistency } = require('../core/world-consistency-engine');
const world = createWorld();
registerLocation(world, { id: 'home' });
for (const [id, ageGroup, generation] of [['a','elder',2], ['bb','adult',1], ['ccc','adult',1]]) {
  registerEntity(world, { id, locationId: 'home', demographics: { ageGroup, generation } });
}
world.population = { indexes: {
  byAgeGroup: { adult: ['ccc','bb'], elder: ['a'] },
  byGeneration: { 1: ['ccc','bb'], 2: ['a'] },
} };
const initial = JSON.stringify(world);
assert.deepStrictEqual(auditWorldConsistency(world).issues, []);
assert.strictEqual(JSON.stringify(world), initial, 'read-only audit must not sort live arrays');
world.entities = Object.fromEntries(Object.entries(world.entities).reverse());
assert.deepStrictEqual(auditWorldConsistency(world).issues, [], 'JSONB entity order is irrelevant');

for (const corrupt of [{ adult: ['bb','ccc','bb'], elder: ['a'] }, { adult: ['bb'], elder: ['a'] },
  { adult: ['bb','ccc','missing'], elder: ['a'] }, { adult: ['bb','ccc'], elder: 'a' },
  { adult: ['bb','ccc'], elder: null }, []]) {
  world.population.indexes.byAgeGroup = corrupt;
  assert.ok(auditWorldConsistency(world).issues.some(issue => issue.code === 'stale_population_age_index'));
  assert.strictEqual(repairWorldConsistency(world).ok, true);
}
world.population.indexes.byGeneration[1].push('a');
assert.ok(auditWorldConsistency(world).issues.some(issue => issue.code === 'stale_population_generation_index'));
repairWorldConsistency(world);
world.ecology = { populations: { byKey: {
  'home:human': { locationId: 'home', speciesId: 'human', population: 1, carryingCapacity: 10 },
}, byLocation: { home: 'human' } } };
assert.ok(auditWorldConsistency(world).issues.some(issue => issue.code === 'stale_ecology_location_index'));
assert.strictEqual(repairWorldConsistency(world).ok, true);
console.log('world membership index audit passed: reordered JSONB maps, strict corruption and nonmutating reads');
