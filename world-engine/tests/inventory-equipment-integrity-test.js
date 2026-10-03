'use strict';
const assert = require('assert');
const { inventoryFixture, grantItem } = require('./helpers/inventory-fixture');
const { equipItem, unequipItem, useItem } = require('../core/inventory-engine');
const { transferItem, removeItem, defineItem } = require('../core/item-engine');
const { digest, detachedJson } = require('../storage/postgres/codec');
const { act } = require('./helpers/player-rules-fixture');
const world = inventoryFixture(), hero = world.entities['hero-one'];
const a = grantItem(world, 'entity', hero.id, 'wooden_sword'), b = grantItem(world, 'entity', hero.id, 'wooden_sword');
const base = hero.stats.power;
equipItem(world, hero.id, a.id); const equipped = digest(world);
equipItem(world, hero.id, a.id); assert.strictEqual(digest(world), equipped, 'repeat equip changes no fields or events');
assert.strictEqual(hero.stats.power, base + 2);
for (const remove of [() => removeItem(world, a.id), () => transferItem(world, a.id, 'entity', 'hero-two')]) {
  assert.throws(remove); assert.strictEqual(digest(world), equipped);
}
equipItem(world, hero.id, b.id); assert.strictEqual(hero.stats.power, base + 2); assert.strictEqual(a.equipped, false);
for (let n = 0; n < 5; n++) act(world, 'train');
assert.strictEqual(hero.stats.power, base + 3);
const copy = detachedJson(world);
unequipItem(world, hero.id, 'weapon'); unequipItem(copy, hero.id, 'weapon');
assert.strictEqual(hero.stats.power, base + 1); assert.strictEqual(digest(world), digest(copy));
const robe = grantItem(world, 'entity', hero.id, 'cloth_robe'); hero.stats.energy = 50;
for (let n = 0; n < 3; n++) { equipItem(world, hero.id, robe.id); assert.strictEqual(hero.stats.maxEnergy, 102); unequipItem(world, hero.id, 'armor'); }
assert.strictEqual(hero.stats.energy, 50); assert.strictEqual(hero.stats.maxEnergy, 100);
defineItem(world, { id: 'bad-equipment', type: 'equipment', slot: 'weapon', stackable: false, stats: { secret: 100 } });
const bad = grantItem(world, 'entity', hero.id, 'bad-equipment'); const before = digest(world);
assert.throws(() => equipItem(world, hero.id, bad.id), /invalid_equipment/); assert.strictEqual(digest(world), before);
const pill = grantItem(world, 'entity', hero.id, 'healing_pill', 2); hero.stats.health = 99;
assert.deepStrictEqual(useItem(world, hero.id, pill.id).effects, { health: 1 }); assert.strictEqual(pill.quantity, 1);
const full = digest(world); assert.throws(() => useItem(world, hero.id, pill.id), /no_item_effect/); assert.strictEqual(digest(world), full);
hero.stats.health = 0; assert.throws(() => useItem(world, hero.id, pill.id), /actor_not_alive/); assert.strictEqual(hero.stats.health, 0);
console.log('inventory equipment integrity passed: idempotence, replacement, training, restoration, capacity-only bonuses and guarded consumption');
