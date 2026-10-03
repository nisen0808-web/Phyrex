'use strict';
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { Pool } = require('pg');
const { createPostgresDatabaseStore } = require('../../storage/postgres/store');
const { createPostgresCommandApiAuditStore } = require('../../storage/postgres/command-api-audit-store');
const { createDurableWorldRuntime } = require('../../runtime/durable-world-runtime');
const { createDurableCommandApiServer } = require('../../core/durable-command-api-engine');
const { advanceWorld } = require('../../core/world-engine');
const { createAccount, createSession } = require('../../core/account-session-engine');
const { getPlayerActionRules } = require('../../core/player-action-rules-engine');
const { digest } = require('../../storage/postgres/codec');
const { inventoryFixture, grantItem } = require('../helpers/inventory-fixture');
const { request } = require('../helpers/service-fixture');
const execute = promisify(execFile);
async function main() {
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  if (!connectionString || !/_(ci|test)$/.test(new URL(connectionString).pathname)) throw new Error('Isolated PostgreSQL _ci/_test required; no skip');
  const schema = `test_inventory_${crypto.randomBytes(7).toString('hex')}`, database = { connectionString, schema };
  const store = createPostgresDatabaseStore(database), audits = createPostgresCommandApiAuditStore(database), raw = new Pool({ connectionString });
  const runtimes = []; let api, groups = 0;
  const pass = name => { groups++; console.log(`PASS ${name}`); };
  const advance = (world, ticks, _options, afterTick) => { for (let i = 0; i < ticks; i++) { advanceWorld(world); if (afterTick) afterTick(world); } };
  const create = async (worldId, options = {}) => { const r = await createDurableWorldRuntime({ store, worldId, advance, simulationId: 'inventory-sql-v1', ...options }); runtimes.push(r); return r; };
  const seed = async (id, setup = () => {}, metadata = {}) => { const world = inventoryFixture(); world.id = id;
    createAccount(world, { id: 'owner', roles: ['player'], playerIds: ['one'] }); createSession(world, 'owner', { token: 'owner-secret-token' });
    setup(world); await store.saveWorld(world, { requestId: `seed:${id}`, expectedRevision: 0, metadata }); return world; };
  const queue = (worldId, id, type, payload = {}, playerId = 'one') => store.enqueueCommand({ worldId, id, playerId, input: { type, payload } });
  const row = (worldId, id) => store.getCommand(worldId, id);
  const step = async (r, id, type, payload = {}, playerId = 'one') => { const worldId = r.getWorld().id; await queue(worldId, id, type, payload, playerId); await r.step(); return (await row(worldId, id)).result; };
  const hero = r => r.getWorld().entities['hero-one'];
  const env = { ...process.env, WORLD_ENGINE_DATABASE_URL: connectionString, WORLD_ENGINE_DB_SCHEMA: schema };
  const cli = (id, flags = []) => execute(process.execPath, [path.join(__dirname, '../../demo/durable-runtime-cli.js'), '--world-id', id, '--batches', '1', ...flags], { env, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true });
  try {
    await store.migrate();
    await seed('http'); api = await createDurableCommandApiServer({ store, auditStore: audits, rateLimitNow: () => 0 });
    await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve)); const port = api.server.address().port;
    for (const [id, payload] of [['forged', { shopId: 'market', definitionId: 'wooden_sword', price: 1 }], ['purchase', { shopId: 'market', definitionId: 'wooden_sword' }]]) {
      const result = await request(port, '/durable/worlds/http/players/one/commands', { method: 'POST', body: { id, type: 'buy_item', payload } }); assert.strictEqual(result.status, 202);
    }
    const http = await create('http'); await http.step();
    assert.strictEqual((await row('http', 'forged')).result.status, 'rejected');
    const purchase = await row('http', 'purchase'); assert.strictEqual(purchase.result.status, 'completed');
    assert.strictEqual(hero(http).resources.currency, 975); assert.strictEqual(http.getWorld().shops.byId.market.currency, 1025);
    assert.strictEqual(http.getWorld().shops.byId.market.stock.wooden_sword.quantity, 9);
    pass('HTTP public purchase rejects price overrides and commits payment, stock and receipt');

    const swordId = purchase.result.outcome.value.itemId;
    await step(http, 'equip', 'equip_item', { itemId: swordId }); const power = hero(http).stats.power;
    const repeated = await step(http, 'equip-again', 'equip_item', { itemId: swordId });
    assert.strictEqual(repeated.outcome.value.unchanged, true); assert.strictEqual(hero(http).stats.power, power);
    await http.close(); const resumed = await create('http');
    await step(resumed, 'remove', 'unequip_item', { slot: 'weapon' }); assert.strictEqual(hero(resumed).stats.power, power - 2);
    pass('repeated equip and SQL restart cannot accumulate or lose equipment bonuses');

    await seed('growth'); const growth = await create('growth');
    const first = await step(growth, 'buy-a', 'buy_item', { shopId: 'market', definitionId: 'wooden_sword' });
    const second = await step(growth, 'buy-b', 'buy_item', { shopId: 'market', definitionId: 'wooden_sword' });
    await step(growth, 'equip-a', 'equip_item', { itemId: first.outcome.value.itemId });
    await step(growth, 'equip-b', 'equip_item', { itemId: second.outcome.value.itemId });
    for (let n = 0; n < 5; n++) await step(growth, `train-${n}`, 'train');
    await growth.close(); const growthAgain = await create('growth'); await step(growthAgain, 'unequip', 'unequip_item', { slot: 'weapon' });
    assert.strictEqual(hero(growthAgain).stats.power, 13); assert.strictEqual(hero(growthAgain).playerActionState.experience, 10);
    pass('replacement equipment and permanent training growth remain distinct across restoration');

    let pillId; await seed('healing', world => { pillId = grantItem(world, 'entity', 'hero-one', 'healing_pill', 2).id; world.entities['hero-one'].stats.health = 99; });
    const healing = await create('healing'); const used = await step(healing, 'one-point', 'use_item', { itemId: pillId });
    assert.deepStrictEqual(used.outcome.value.effects, { health: 1 });
    assert.strictEqual((await step(healing, 'at-full', 'use_item', { itemId: pillId })).outcome.reason, 'no_item_effect');
    assert.strictEqual(healing.getWorld().items.instances[pillId].quantity, 1);
    pass('consumption reports actual recovery and cannot waste or duplicate a full-health potion');

    const currencyBefore = hero(resumed).resources.currency + resumed.getWorld().shops.byId.market.currency;
    const sold = await step(resumed, 'sell', 'sell_item', { shopId: 'market', itemId: swordId }); assert.strictEqual(sold.status, 'completed');
    assert.strictEqual(hero(resumed).resources.currency + resumed.getWorld().shops.byId.market.currency, currencyBefore);
    assert.strictEqual(resumed.getWorld().shops.byId.market.stock.wooden_sword.quantity, 10);
    let brokeItem; await seed('broke-shop', world => { world.shops.byId.market.currency = 0; brokeItem = grantItem(world, 'entity', 'hero-one', 'wooden_sword').id; });
    const broke = await create('broke-shop'); assert.strictEqual((await step(broke, 'reject', 'sell_item', { shopId: 'market', itemId: brokeItem })).outcome.reason, 'shop_insufficient_currency');
    assert.ok(broke.getWorld().items.instances[brokeItem]);
    pass('selling restocks the shop, conserves money and rejects unfunded purchases');

    let gift; await seed('gift', world => { gift = grantItem(world, 'entity', 'hero-one', 'healing_pill', 4).id; });
    const giving = await create('gift'); await step(giving, 'give', 'give_item', { itemId: gift, targetId: 'hero-two' });
    assert.strictEqual(giving.getWorld().items.instances[gift].ownerId, 'hero-two');
    assert.ok(giving.getWorld().items.byOwner['entity:hero-two'].includes(gift));
    assert.ok(!giving.getWorld().items.byOwner['entity:hero-one'].includes(gift));
    assert.strictEqual((await step(giving, 'stolen-back', 'use_item', { itemId: gift })).outcome.reason, 'item_not_owned');
    pass('gifts transfer a complete stack and both owner indexes without authorizing the previous owner');

    await seed('capacity', world => { for (let i = 0; i < 128; i++) grantItem(world, 'entity', 'hero-one', 'wooden_sword'); });
    const capacity = await create('capacity'); const balance = hero(capacity).resources.currency;
    assert.strictEqual((await step(capacity, 'too-many', 'buy_item', { shopId: 'market', definitionId: 'cloth_robe' })).outcome.reason, 'inventory_full');
    assert.strictEqual(hero(capacity).resources.currency, balance); assert.strictEqual(Object.keys(capacity.getWorld().items.instances).length, 128);
    pass('inventory capacity rejects before charging or decrementing stock');

    await seed('views', world => { const item = grantItem(world, 'entity', 'hero-one', 'wooden_sword'); item.meta.private = 'item-secret'; item.stats.private = 100;
      world.shops.byId.market.stock.wooden_sword.private = 'stock-secret'; grantItem(world, 'entity', 'hero-two', 'spirit_stone'); });
    const beforeView = await store.loadWorld('views');
    const view = await request(port, '/durable/worlds/views/players/one/state'); assert.strictEqual(view.status, 200);
    assert.strictEqual(view.body.data.inventory.items.length, 1); assert.ok(!JSON.stringify(view.body).includes('secret'));
    assert.ok(!Object.hasOwn(view.body.data.inventory.items[0].stats, 'private'));
    assert.strictEqual((await request(port, '/durable/worlds/views/players/two/state')).status, 403);
    const afterView = await store.loadWorld('views'); assert.strictEqual(afterView.revision, beforeView.revision); assert.strictEqual(digest(afterView.world), digest(beforeView.world));
    pass('authenticated state projection is bounded, redacted, owner-scoped and read-only');

    await seed('rollback'); await queue('rollback', 'buy-once', 'buy_item', { shopId: 'market', definitionId: 'wooden_sword' });
    const broken = await create('rollback', { store: { ...store, saveWorld(world, options) { return store.saveWorld(world, { ...options, commandResults: options.commandResults.map(r => ({ ...r, inputDigest: '0'.repeat(64) })) }); } } });
    await assert.rejects(broken.step(), { code: 'WORLD_DB_COMMAND_CONFLICT' });
    const rolledBack = await store.loadWorld('rollback'); assert.strictEqual(rolledBack.world.shops.byId.market.stock.wooden_sword.quantity, 10);
    assert.strictEqual(rolledBack.world.entities['hero-one'].resources.currency, 1000); assert.strictEqual((await row('rollback', 'buy-once')).status, 'pending');
    await broken.close({ flush: false }); const recovered = await create('rollback'); await recovered.step(); assert.strictEqual(hero(recovered).resources.currency, 975);
    pass('SQL rollback and recovery never leave a paid but missing item');

    await seed('lost-ack'); await queue('lost-ack', 'buy-once', 'buy_item', { shopId: 'market', definitionId: 'wooden_sword' });
    let fault = true, advances = 0;
    const lost = await create('lost-ack', { advance(...args) { advances++; return advance(...args); }, store: { ...store,
      async saveWorld(...args) { const result = await store.saveWorld(...args); if (fault) { fault = false; throw Object.assign(new Error('private'), { code: 'WORLD_DB_UNAVAILABLE' }); } return result; } } });
    await assert.rejects(lost.step()); assert.strictEqual(hero(lost).resources.currency, 1000);
    const receipt = await row('lost-ack', 'buy-once'); await lost.retry(); assert.strictEqual(advances, 1);
    assert.deepStrictEqual(await row('lost-ack', 'buy-once'), receipt); assert.strictEqual(hero(lost).resources.currency, 975);
    assert.strictEqual(Object.keys(lost.getWorld().items.instances).length, 1);
    pass('lost acknowledgment retries one frozen purchase without a second item or charge');

    await seed('last-stock', world => { world.shops.byId.market.stock.wooden_sword.quantity = 1; });
    await queue('last-stock', 'first', 'buy_item', { shopId: 'market', definitionId: 'wooden_sword' }, 'one');
    await queue('last-stock', 'second', 'buy_item', { shopId: 'market', definitionId: 'wooden_sword' }, 'two');
    const competing = await create('last-stock'); await competing.step();
    assert.strictEqual((await row('last-stock', 'first')).result.status, 'completed');
    assert.strictEqual((await row('last-stock', 'second')).result.outcome.reason, 'insufficient_stock');
    assert.strictEqual(competing.getWorld().shops.byId.market.stock.wooden_sword.quantity, 0);
    assert.strictEqual(Object.keys(competing.getWorld().items.instances).length, 1);
    pass('two queued buyers competing for the final unit settle exactly one purchase');

    const legacy = inventoryFixture(); const oldHash = digest({ version: 4, profile: 'culture-info-v1', simulation: {},
      commands: { profile: 'postgres-player-rules-v3', maxPerBatch: 100, rules: getPlayerActionRules(legacy) } });
    await seed('v4-upgrade', () => {}, { durableRuntime: { version: 4, configHash: oldHash } });
    await queue('v4-upgrade', 'purchase', 'buy_item', { shopId: 'market', definitionId: 'wooden_sword' });
    await assert.rejects(cli('v4-upgrade'), error => error.code === 1 && error.stderr.includes('WORLD_RUNTIME_COMMAND_PROFILE_UPGRADE_REQUIRED'));
    await cli('v4-upgrade', ['--upgrade-command-profile']); const applied = await row('v4-upgrade', 'purchase'); assert.strictEqual(applied.result.status, 'completed');
    await cli('v4-upgrade'); assert.deepStrictEqual(await row('v4-upgrade', 'purchase'), applied);
    const upgraded = await store.loadWorld('v4-upgrade'); assert.strictEqual(upgraded.metadata.durableRuntime.version, 5);
    assert.strictEqual(upgraded.metadata.durableRuntime.upgradedFrom, oldHash); assert.strictEqual(Object.keys(upgraded.world.items.instances).length, 1);
    pass('fresh full-kernel CLI processes explicitly upgrade v4 and restore applied inventory receipts');
    console.log(`postgres inventory completed ${groups} scenario groups: ${groups} passed, 0 failed`);
  } finally {
    if (api) await api.close();
    await Promise.all(runtimes.map(r => r.close({ flush: false }).catch(() => {})));
    await audits.close(); await store.close(); await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await raw.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
