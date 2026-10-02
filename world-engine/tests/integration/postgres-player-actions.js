'use strict';
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { Pool } = require('pg');
const { createPostgresDatabaseStore } = require('../../storage/postgres/store');
const { createDurableWorldRuntime } = require('../../runtime/durable-world-runtime');
const { advanceWorld } = require('../../core/world-engine');
const { configurePlayerActionRules } = require('../../core/player-action-rules-engine');
const { createDurableCommandApiServer } = require('../../core/durable-command-api-engine');
const { createPostgresCommandApiAuditStore } = require('../../storage/postgres/command-api-audit-store');
const { digest } = require('../../storage/postgres/codec');
const { fixture: rulesFixture } = require('../helpers/player-rules-fixture');
const { createAccount, createSession } = require('../../core/account-session-engine');
const { request } = require('../helpers/service-fixture');
const execute = promisify(execFile);
async function main() {
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  if (!connectionString || !/_(ci|test)$/.test(new URL(connectionString).pathname)) throw new Error('Isolated PostgreSQL _ci/_test required; no silent skip');
  const schema = `test_player_actions_${crypto.randomBytes(7).toString('hex')}`;
  const database = { connectionString, schema }, store = createPostgresDatabaseStore(database), raw = new Pool({ connectionString });
  const audits = createPostgresCommandApiAuditStore(database), runtimes = [];
  const advance = (world, ticks, _options, afterTick) => { for (let i = 0; i < ticks; i++) { advanceWorld(world); if (afterTick) afterTick(world); } };
  const create = async (worldId, options = {}) => { const r = await createDurableWorldRuntime({ store, worldId, advance, simulationId: 'player-actions-sql-v1', ...options }); runtimes.push(r); return r; };
  const seed = async (id, setup = () => {}, metadata = {}) => { const world = rulesFixture(); world.id = id; setup(world); await store.saveWorld(world, { requestId: `seed:${id}`, expectedRevision: 0, metadata }); return world; };
  const queue = (worldId, id, type, payload = {}, playerId = 'one') => store.enqueueCommand({ worldId, id, playerId, input: { type, payload } });
  const row = (worldId, id) => store.getCommand(worldId, id);
  const env = { ...process.env, WORLD_ENGINE_DATABASE_URL: connectionString, WORLD_ENGINE_DB_SCHEMA: schema };
  const cli = (worldId, flags = []) => execute(process.execPath, [path.join(__dirname, '../../demo/durable-runtime-cli.js'), '--world-id', worldId, '--batches', '1', ...flags], { env, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true });
  let api, groups = 0; const pass = label => { groups++; console.log(`PASS ${label}`); };
  try {
    await store.migrate();
    await seed('authority');
    await queue('authority', 'free-money', 'work', { amount: 100, energyCost: 0 });
    await queue('authority', 'fake-resource', 'work', { resource: 'diamonds' });
    await queue('authority', 'valid', 'work');
    await queue('authority', 'second', 'rest');
    const authority = await create('authority'); await authority.step();
    assert.strictEqual((await row('authority', 'free-money')).result.status, 'rejected');
    assert.strictEqual((await row('authority', 'fake-resource')).result.outcome.reason, 'work_resource_not_allowed');
    assert.strictEqual((await row('authority', 'valid')).result.outcome.value.amount, 10);
    assert.strictEqual((await row('authority', 'second')).result.outcome.reason, 'character_busy');
    assert.strictEqual(authority.getWorld().entities['hero-one'].stats.energy, 94);
    assert.strictEqual(authority.getWorld().entities['hero-one'].resources.currency, 110);
    pass('durable player requests cannot mint arbitrary resources, waive costs or stack actions');

    await seed('energy', world => { world.entities['hero-one'].stats.energy = 1; });
    await queue('energy', 'tired', 'work'); await queue('energy', 'recover', 'rest');
    const energy = await create('energy'); await energy.step();
    assert.strictEqual((await row('energy', 'tired')).result.outcome.reason, 'insufficient_energy');
    assert.strictEqual(energy.getWorld().entities['hero-one'].stats.energy, 21);
    await queue('energy', 'after-rest', 'work'); await energy.step();
    assert.strictEqual(energy.getWorld().entities['hero-one'].stats.energy, 15);
    pass('rest restores actual energy and unlocks a later funded action');

    await seed('gather', world => { world.locations.home.resources.wood = 2; });
    await queue('gather', 'collect', 'gather', { resource: 'wood' });
    const gather = await create('gather'); await gather.step();
    assert.strictEqual(gather.getWorld().locations.home.resources.wood, 0);
    assert.strictEqual(gather.getWorld().entities['hero-one'].resources.wood, 2);
    await queue('gather', 'empty', 'gather', { resource: 'wood' });
    await queue('gather', 'invented', 'gather', { resource: 'new-kind' }); await gather.step();
    assert.strictEqual((await row('gather', 'empty')).result.outcome.reason, 'resource_unavailable');
    assert.strictEqual((await row('gather', 'invented')).result.status, 'rejected');
    assert.ok(!Object.hasOwn(gather.getWorld().entities['hero-one'].resources, 'new-kind'));
    pass('gathering conserves local stocks and cannot create arbitrary empty resource keys');

    await seed('transfer'); await queue('transfer', 'gift', 'transfer', { targetId: 'hero-two', amount: 20 });
    const transfer = await create('transfer'); await transfer.step();
    let entities = transfer.getWorld().entities;
    assert.strictEqual(entities['hero-one'].resources.currency, 80); assert.strictEqual(entities['hero-two'].resources.currency, 120);
    await queue('transfer', 'overdraw', 'transfer', { targetId: 'hero-two', amount: 100 }); await transfer.step();
    assert.strictEqual((await row('transfer', 'overdraw')).result.outcome.reason, 'insufficient_resource');
    assert.strictEqual(transfer.getWorld().entities['hero-one'].resources.currency, 80);
    pass('transfers preserve total resources and overdrafts have no partial effects');

    await seed('training'); const training = await create('training');
    for (let i = 0; i < 5; i++) { await queue('training', `train-${i}`, 'train'); await training.step(); }
    let hero = training.getWorld().entities['hero-one'];
    assert.strictEqual(hero.playerActionState.experience, 10); assert.strictEqual(hero.stats.power, 13); assert.strictEqual(hero.stats.energy, 60);
    await training.close(); const trainingResumed = await create('training');
    await queue('training', 'train-5', 'train'); await trainingResumed.step();
    hero = trainingResumed.getWorld().entities['hero-one']; assert.strictEqual(hero.playerActionState.experience, 12); assert.strictEqual(hero.stats.power, 13);
    assert.strictEqual((await row('training', 'train-4')).result.outcome.value.powerGain, 1);
    pass('training crosses a deterministic growth threshold and survives SQL restart');

    await seed('combat', world => { world.entities['hero-two'].stats.health = 3; });
    const combat = await create('combat'); await queue('combat', 'spare', 'damage', { targetId: 'hero-two', lethal: false }); await combat.step();
    assert.strictEqual((await row('combat', 'spare')).result.outcome.value.amount, 2);
    assert.strictEqual(combat.getWorld().entities['hero-two'].stats.health, 1); assert.strictEqual(combat.getWorld().entities['hero-two'].status, 'alive');
    await queue('combat', 'finish', 'damage', { targetId: 'hero-two' }); await combat.step();
    assert.strictEqual(combat.getWorld().entities['hero-two'].status, 'dead');
    assert.strictEqual(combat.getWorld().events.filter(event => event.type === 'entity.dead').length, 1);
    pass('defense-derived combat honors nonlethal intent and commits one terminal death');

    await seed('rules', world => {
      configurePlayerActionRules(world, { workYield: 7, workEnergy: 3 });
      createAccount(world, { id: 'owner', roles: ['player'], playerIds: ['one'] }); createSession(world, 'owner', { token: 'owner-secret-token' });
    });
    const configured = await create('rules'); await queue('rules', 'custom-work', 'work'); await configured.step(); await configured.close();
    assert.strictEqual((await row('rules', 'custom-work')).result.outcome.value.amount, 7);
    api = await createDurableCommandApiServer({ store, auditStore: audits, rateLimitNow: () => 0 });
    await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
    const view = await request(api.server.address().port, '/durable/worlds/rules/players/one/state');
    assert.strictEqual(view.body.data.actionRules.workEnergy, 3); assert.strictEqual(view.body.data.character.actionState.lastTick, 1);
    await api.close(); api = null;
    const loaded = await store.loadWorld('rules'); configurePlayerActionRules(loaded.world, { workYield: 8 });
    await store.saveWorld(loaded.world, { expectedRevision: loaded.revision, requestId: 'unauthorized-rules-change', metadata: loaded.metadata });
    await assert.rejects(create('rules', { upgradeCommandProfile: true }), { code: 'WORLD_RUNTIME_CONFIG_MISMATCH' });
    pass('committed rule configuration is readable over HTTP and changed rules fail the runtime hash fence');

    await seed('lost-ack'); await queue('lost-ack', 'train-once', 'train');
    let fault = true, advances = 0;
    const lost = await create('lost-ack', { advance(...args) { advances++; return advance(...args); }, store: { ...store,
      async saveWorld(...args) { const result = await store.saveWorld(...args); if (fault) { fault = false; throw Object.assign(new Error('private'), { code: 'WORLD_DB_UNAVAILABLE' }); } return result; } } });
    await assert.rejects(lost.step()); assert.strictEqual(lost.getWorld().entities['hero-one'].playerActionState, undefined);
    const receipt = await row('lost-ack', 'train-once'); await lost.retry();
    assert.strictEqual(advances, 1); assert.deepStrictEqual(await row('lost-ack', 'train-once'), receipt);
    assert.strictEqual(lost.getWorld().entities['hero-one'].playerActionState.experience, 2);
    pass('lost commit acknowledgment cannot repeat training, energy cost or growth');

    await seed('rollback'); await queue('rollback', 'train-once', 'train');
    const broken = await create('rollback', { store: { ...store, saveWorld(world, options) { return store.saveWorld(world, { ...options,
      commandResults: options.commandResults.map(result => ({ ...result, inputDigest: '0'.repeat(64) })) }); } } });
    await assert.rejects(broken.step(), { code: 'WORLD_DB_COMMAND_CONFLICT' });
    assert.strictEqual((await store.loadWorld('rollback')).world.entities['hero-one'].playerActionState, undefined);
    assert.strictEqual((await row('rollback', 'train-once')).status, 'pending'); await broken.close({ flush: false });
    const recovered = await create('rollback'); await recovered.step();
    assert.strictEqual(recovered.getWorld().entities['hero-one'].playerActionState.experience, 2);
    pass('transaction rollback preserves energy and experience until a successful recovery');

    const oldHash = digest({ version: 3, profile: 'culture-info-v1', simulation: {}, commands: { profile: 'postgres-player-contract-v2', maxPerBatch: 100 } });
    await seed('v3-upgrade', () => {}, { durableRuntime: { version: 3, configHash: oldHash } });
    await queue('v3-upgrade', 'old-free-action', 'work', { energyCost: 0 }); await queue('v3-upgrade', 'first-training', 'train');
    await assert.rejects(cli('v3-upgrade'), error => error.code === 1 && error.stderr.includes('WORLD_RUNTIME_COMMAND_PROFILE_UPGRADE_REQUIRED'));
    await cli('v3-upgrade', ['--upgrade-command-profile']);
    const firstTraining = await row('v3-upgrade', 'first-training');
    assert.strictEqual(firstTraining.result.status, 'completed'); assert.strictEqual((await row('v3-upgrade', 'old-free-action')).result.status, 'rejected');
    await cli('v3-upgrade'); assert.deepStrictEqual(await row('v3-upgrade', 'first-training'), firstTraining);
    const upgraded = await store.loadWorld('v3-upgrade'); assert.strictEqual(upgraded.metadata.durableRuntime.version, 4);
    assert.strictEqual(upgraded.metadata.durableRuntime.upgradedFrom, oldHash);
    pass('two fresh full-kernel CLI processes upgrade v3 explicitly and retain the original applied action receipt');

    console.log(`postgres player actions completed ${groups} scenario groups: ${groups} passed, 0 failed`);
  } finally {
    if (api) await api.close();
    await Promise.all(runtimes.map(runtime => runtime.close({ flush: false }).catch(() => {})));
    await audits.close(); await store.close();
    await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await raw.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
