'use strict';

const assert = require('assert');
const { buildDemoWorld, runDemoWorld } = require('../demo/run-demo');
const { createPlayerWithCharacter } = require('../core/player-engine');
const { getItemStats, grantItem } = require('../core/item-engine');
const { getPlayerInventory, equipItem, unequipItem, useItem } = require('../core/inventory-engine');
const { getPlayerShop, buyItem, sellItem, getShopStats } = require('../core/shop-engine');
const { queryWorld } = require('../core/query-engine');
const { createWorldSnapshot } = require('../core/snapshot-engine');
const { createShellSession, executeShellInput } = require('../core/shell-engine');

function main() {
  const world = buildDemoWorld();
  runDemoWorld(world, 5, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0, baseMortalityChance: 0 },
  });

  const { player, entity } = createPlayerWithCharacter(world, {
    player: { id: 'item_player', name: 'Item Player' },
    character: {
      id: 'item_hero',
      name: 'Item Hero',
      species: 'human',
      locationId: 'qingyun_city',
      stats: { health: 50, maxHealth: 100, energy: 80, maxEnergy: 100, power: 10, defense: 5, social: 50 },
      resources: { currency: 200, food: 10 },
      demographics: { age: 18, generation: 1 },
    },
  });

  const itemStatsBefore = getItemStats(world);
  assert.ok(itemStatsBefore.definitions >= 1, 'default item definitions should exist');

  const shopView = getPlayerShop(world, player.id);
  assert.ok(shopView.shops.length >= 1, 'player location should have shops');
  const generalShop = shopView.shops.find(shop => shop.id === 'shop_qingyun_city_general') || shopView.shops[0];
  assert.ok(generalShop.stock.some(stock => stock.definitionId === 'wooden_sword'), 'shop should stock wooden_sword');

  const swordBuy = buyItem(world, player.id, generalShop.id, 'wooden_sword', 1);
  assert.ok(swordBuy.item.id, 'buy should grant sword item');
  assert.ok(Number(world.entities[entity.id].resources.currency) < 200, 'buy should reduce currency');

  const pillBuy = buyItem(world, player.id, generalShop.id, 'healing_pill', 2);
  assert.ok(pillBuy.item.quantity >= 2, 'buy should stack healing pills');

  let inventory = getPlayerInventory(world, player.id);
  assert.ok(inventory.items.some(item => item.definitionId === 'wooden_sword'), 'inventory should contain sword');
  assert.ok(inventory.items.some(item => item.definitionId === 'healing_pill'), 'inventory should contain pill');

  const powerBefore = Number(world.entities[entity.id].stats.power || 0);
  equipItem(world, entity.id, swordBuy.item.id, { playerId: player.id });
  assert.ok(Number(world.entities[entity.id].stats.power || 0) >= powerBefore + 2, 'equipping sword should increase power');

  inventory = getPlayerInventory(world, player.id);
  assert.ok(inventory.equipment.weapon, 'equipment should include weapon');

  unequipItem(world, entity.id, 'weapon', { playerId: player.id });
  assert.strictEqual(Number(world.entities[entity.id].stats.power || 0), powerBefore, 'unequip should restore base power');

  const healthBefore = Number(world.entities[entity.id].stats.health || 0);
  useItem(world, entity.id, pillBuy.item.id, { playerId: player.id });
  assert.ok(Number(world.entities[entity.id].stats.health || 0) > healthBefore, 'using healing pill should restore health');

  inventory = getPlayerInventory(world, player.id);
  const remainingPill = inventory.items.find(item => item.definitionId === 'healing_pill');
  assert.ok(remainingPill && remainingPill.quantity >= 1, 'one pill should remain after use');
  const currencyBeforeSell = Number(world.entities[entity.id].resources.currency || 0);
  sellItem(world, player.id, remainingPill.id, 1);
  assert.ok(Number(world.entities[entity.id].resources.currency || 0) > currencyBeforeSell, 'selling item should increase currency');

  grantItem(world, 'entity', entity.id, 'spirit_stone', 1);
  inventory = getPlayerInventory(world, player.id);
  assert.ok(inventory.items.some(item => item.definitionId === 'spirit_stone'), 'grantItem should add spirit stone');

  const session = createShellSession(world, player.id);
  let result = executeShellInput(session, '商店');
  assert.strictEqual(result.status, 'ok', 'Chinese shop alias should work');
  assert.ok(result.message.includes('Shops'), 'shop output should list shops');

  result = executeShellInput(session, `购买 ${generalShop.id} healing_pill 1`);
  assert.strictEqual(result.status, 'ok', 'Chinese buy alias should work');

  result = executeShellInput(session, '背包');
  assert.strictEqual(result.status, 'ok', 'Chinese inventory alias should work');
  assert.ok(result.message.includes('Inventory'), 'inventory output should render');

  result = executeShellInput(session, '使用 healing_pill');
  assert.strictEqual(result.status, 'ok', 'Chinese use alias should resolve by definition id');

  result = executeShellInput(session, '购买 shop_qingyun_city_general wooden_sword 1');
  assert.strictEqual(result.status, 'ok', 'buy should be able to buy another sword');

  result = executeShellInput(session, '装备 wooden_sword');
  assert.strictEqual(result.status, 'ok', 'Chinese equip alias should resolve by definition id');

  result = executeShellInput(session, '卸下 weapon');
  assert.strictEqual(result.status, 'ok', 'Chinese unequip alias should work by slot');

  const inventoryQuery = queryWorld(world, { type: 'inventory', playerId: player.id });
  assert.ok(inventoryQuery.items.length >= 1, 'inventory query should return items');

  const shopQuery = queryWorld(world, { type: 'shop', playerId: player.id });
  assert.ok(shopQuery.shops.length >= 1, 'shop query should return shops');

  const playerQuery = queryWorld(world, { type: 'player', playerId: player.id });
  assert.ok(playerQuery.inventory.items.length >= 1, 'player query should include inventory');
  assert.ok(playerQuery.shop.shops.length >= 1, 'player query should include shop');

  const snapshot = createWorldSnapshot(world);
  assert.ok(snapshot.items.definitions >= 1, 'snapshot should include item definitions');
  assert.ok(snapshot.items.instances >= 1, 'snapshot should include item instances');
  assert.ok(snapshot.shops.total >= 1, 'snapshot should include shops');
  assert.ok(snapshot.limits.itemInstances.current <= snapshot.limits.itemInstances.limit, 'item instance cap should hold');
  assert.ok(snapshot.limits.shops.current <= snapshot.limits.shops.limit, 'shop cap should hold');

  const shopStats = getShopStats(world);
  assert.ok(shopStats.stats.bought >= 1, 'shop stats should count buys');
  assert.ok(shopStats.stats.sold >= 1, 'shop stats should count sells');

  console.log('item inventory shop integration test passed');
}

main();
