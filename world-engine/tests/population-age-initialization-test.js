'use strict';
const assert = require('assert');
const { createWorld, registerLocation, registerEntity } = require('../core/world-engine');
const { createEntity } = require('../core/schema');
const { initializePopulation, processPopulationTick, ensureDemographics, createChild } = require('../core/population-engine');
const { repairLoadedWorld } = require('../core/persistence-engine');
const { digest } = require('../storage/postgres/codec');

function fixture() {
  const world = createWorld({ id: 'population-ages', tick: 100, seed: 1234 });
  registerLocation(world, { id: 'home', resources: { food: 1000, water: 1000 } });
  registerEntity(world, { id: 'a', locationId: 'home', demographics: { age: 25, sex: 'female' } });
  registerEntity(world, { id: 'b', locationId: 'home', demographics: { age: 27, sex: 'male' } });
  initializePopulation(world, { ticksPerYear: 10, baseBirthChance: 0.2, baseMortalityChance: 0,
    environmentMortalityWeight: 0 });
  return world;
}
const world = fixture();
assert.strictEqual(world.entities.a.demographics.age, 25);
assert.strictEqual(world.entities.a.demographics.birthTick, -150);
assert.strictEqual(world.entities.a.demographics.ageGroup, 'adult');
assert.strictEqual(world.entities.b.demographics.age, 27);
const zero = registerEntity(world, { id: 'explicit-zero', demographics: { birthTick: 0, age: 80 } });
ensureDemographics(zero, world);
assert.strictEqual(zero.demographics.birthTick, 0);
assert.strictEqual(zero.demographics.age, 10);
const newborn = registerEntity(world, { id: 'newborn' });
ensureDemographics(newborn, world);
assert.strictEqual(newborn.demographics.birthTick, 100);
assert.strictEqual(newborn.demographics.age, 0);
assert.ok(['male', 'female'].includes(newborn.demographics.sex));
world.tick += 10;
ensureDemographics(world.entities.a, world);
assert.strictEqual(world.entities.a.demographics.age, 26);
assert.strictEqual(world.entities.a.demographics.birthTick, -150);
const restored = repairLoadedWorld(JSON.parse(JSON.stringify(world)));
ensureDemographics(restored.entities.a, restored);
assert.strictEqual(digest(world), digest(restored));

const legacy = { id: 'legacy', demographics: { age: 20 } };
ensureDemographics(legacy, world);
assert.strictEqual(legacy.demographics.birthTick, -90);
assert.deepStrictEqual(legacy.demographics.childrenIds, []);
const raw = createEntity({ id: 'raw', meta: { age: 30 } });
ensureDemographics(raw, world);
assert.strictEqual(raw.demographics.age, 30);
assert.throws(() => ensureDemographics(createEntity({ id: 'invalid', demographics: { age: -1 } }), world));
assert.throws(() => ensureDemographics(createEntity({ id: 'overflow', demographics: { age: 1e308 } }), world));
assert.throws(() => initializePopulation(world, { ticksPerYear: 0 }));
assert.throws(() => processPopulationTick(world, { ticksPerYear: Infinity }));
assert.strictEqual(world.population.options.ticksPerYear, 10);

const child = createChild(world, world.entities.a, world.entities.b);
assert.strictEqual(child.demographics.birthTick, world.tick);
assert.strictEqual(child.demographics.age, 0);
assert.strictEqual(child.demographics.generation, 2);
assert.ok(world.entities.a.demographics.childrenIds.includes(child.id));
assert.ok(world.entities.b.demographics.childrenIds.includes(child.id));

function generations() {
  const candidate = fixture();
  for (let i = 0; i < 30; i++) { processPopulationTick(candidate); candidate.tick++; }
  assert.ok(candidate.population.births > 0, 'adult founders must be able to produce children');
  assert.ok(Object.values(candidate.entities).some(e => e.demographics.generation === 2));
  return candidate;
}
assert.strictEqual(digest(generations()), digest(generations()));
console.log('population age initialization passed: age, calendar, explicit zero, restore and deterministic births');
