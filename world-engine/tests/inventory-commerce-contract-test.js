'use strict';
const assert = require('assert');
const { inventoryFixture, grantItem } = require('./helpers/inventory-fixture');
const { buyItem, sellItem } = require('../core/shop-engine');
const { createItemInstance } = require('../core/item-engine');
const { digest } = require('../storage/postgres/codec');
const { planInventoryOperation, MAX_OWNER_ITEMS } = require('../core/inventory-operations-engine');
const world = inventoryFixture(), hero = world.entities['hero-one'], shop = world.shops.byId.market;
for (const quantity of [0, -1, 1.5, NaN, Infinity, null, '2', 101]) {
  const before = digest(world); assert.throws(() => buyItem(world, 'one', 'market', 'healing_pill', quantity)); assert.strictEqual(digest(world), before);
}
const beforeSword = digest(world); assert.throws(() => buyItem(world, 'one', 'market', 'wooden_sword', 2), /nonstackable_quantity/); assert.strictEqual(digest(world), beforeSword);
const currency = hero.resources.currency + shop.currency;
const purchase = buyItem(world, 'one', 'market', 'healing_pill', 3), id = purchase.item.id;
assert.strictEqual(purchase.quantity, 3); assert.strictEqual(shop.stock.healing_pill.quantity, 7);
assert.strictEqual(hero.resources.currency + shop.currency, currency);
const sale = sellItem(world, 'one', id, 2, 'market'); assert.strictEqual(sale.revenue, 12);
assert.strictEqual(world.items.instances[id].quantity, 1); assert.strictEqual(shop.stock.healing_pill.quantity, 9);
assert.strictEqual(hero.resources.currency + shop.currency, currency);
let before = digest(world); assert.throws(() => sellItem(world, 'one', id, 2, 'market'), /insufficient_items/); assert.strictEqual(digest(world), before);
shop.currency = 0; before = digest(world); assert.throws(() => sellItem(world, 'one', id, 1, 'market'), /shop_insufficient_currency/); assert.strictEqual(digest(world), before);
assert.strictEqual(planInventoryOperation(world, hero, 'buy_item', { shopId: 'remote-market', definitionId: 'healing_pill' }).reason, 'shop_not_at_location');
shop.stock.healing_pill.price = -1; before = digest(world); assert.throws(() => buyItem(world, 'one', 'market', 'healing_pill'), /invalid_price/); assert.strictEqual(digest(world), before);
shop.stock.healing_pill.price = 12;
for (let n = 1; n < MAX_OWNER_ITEMS; n++) grantItem(world, 'entity', hero.id, 'wooden_sword');
assert.strictEqual(planInventoryOperation(world, hero, 'buy_item', { shopId: 'market', definitionId: 'cloth_robe' }).reason, 'inventory_full');
assert.ok(!planInventoryOperation(world, hero, 'buy_item', { shopId: 'market', definitionId: 'healing_pill' }).reason, 'existing stack can still grow');
before = digest(world); assert.throws(() => createItemInstance(world, { id, definitionId: 'healing_pill', ownerType: 'entity', ownerId: hero.id })); assert.strictEqual(digest(world), before);
console.log('inventory commerce contracts passed: positive integral quantities, exact stock/currency conservation, budgets, capacity and duplicate identity');
