'use strict';
const { fixture } = require('./player-rules-fixture');
const { createShop } = require('../../core/shop-engine');
const { grantItem } = require('../../core/item-engine');
function inventoryFixture() {
  const world = fixture();
  createShop(world, { id: 'market', locationId: 'home', currency: 1000 });
  createShop(world, { id: 'remote-market', locationId: 'away', currency: 1000 });
  world.entities['hero-one'].resources.currency = 1000;
  return world;
}
module.exports = { inventoryFixture, grantItem };
