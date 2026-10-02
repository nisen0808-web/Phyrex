'use strict';
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { Pool } = require('pg');
const { createPostgresDatabaseStore } = require('../../storage/postgres/store');
const { createPostgresCommandApiAuditStore } = require('../../storage/postgres/command-api-audit-store');
const { createDurableCommandApiServer } = require('../../core/durable-command-api-engine');
const { createDurableWorldRuntime, advanceDeterministicBatch, COMMAND_PROFILE } = require('../../runtime/durable-world-runtime');
const { registerLocation } = require('../../core/world-engine');
const { assignGoal } = require('../../core/goal-engine');
const { createPlayerCharacter } = require('../../core/player-engine');
const { digest, detachedJson } = require('../../storage/postgres/codec');
const { fixture, request } = require('../helpers/service-fixture');
const execute = promisify(execFile);
async function main() {
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  if (!connectionString || !/_(ci|test)$/.test(new URL(connectionString).pathname)) throw new Error('Isolated PostgreSQL _ci/_test required; never silently skip');
  const schema = `test_player_contract_${crypto.randomBytes(7).toString('hex')}`;
  const database = { connectionString, schema };
  const store = createPostgresDatabaseStore(database), audits = createPostgresCommandApiAuditStore(database), raw = new Pool({ connectionString });
  const runtimes = [];
  let api, groups = 0;
  const pass = name => { groups++; console.log(`PASS ${name}`); };
  const create = async (worldId, extra = {}) => { const r = await createDurableWorldRuntime({ store, worldId, ...extra }); runtimes.push(r); return r; };
  const seed = async (id, setup = () => {}, metadata = {}) => {
    const world = fixture().state.world; world.id = id;
    registerLocation(world, { id: 'away' }); world.locations.home.neighbors = ['away']; world.locations.away.neighbors = ['home'];
    createPlayerCharacter(world, 'two', { id: 'other', locationId: 'home' });
    setup(world); await store.saveWorld(world, { expectedRevision: 0, requestId: `seed:${id}`, metadata }); return world;
  };
  const enqueue = (worldId, id, input, playerId = 'one') => store.enqueueCommand({ worldId, id, input, playerId });
  const env = { ...process.env, WORLD_ENGINE_DATABASE_URL: connectionString, WORLD_ENGINE_DB_SCHEMA: schema };
  const cli = (worldId, flags = []) => execute(process.execPath, [path.join(__dirname, '../../demo/durable-runtime-cli.js'), '--world-id', worldId, '--batches', '1', ...flags], { env, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true });
  try {
    await store.migrate(); await seed('http-contract');
    api = await createDurableCommandApiServer({ store, auditStore: audits, rateLimitNow: () => 0 });
    await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
    const port = api.server.address().port, base = '/durable/worlds/http-contract';
    const bad = [
      { type: 'wait', ticks: 'not-a-number' }, { type: 'work', amount: '1e999' }, { type: 'work', energyCost: -7 },
      { type: 'gather', resource: '__proto__' }, { type: 'train', power: {} }, { type: 'interact', targetId: 'home' },
      { type: 'create_character', payload: { id: 'other', stats: { power: 99999 } } },
      { type: 'set_goal', payload: { goalType: 'gain_power', payload: { power: 'wrong' } } },
    ];
    for (let i = 0; i < bad.length; i++) {
      const response = await request(port, `${base}/players/one/commands`, { method: 'POST', body: { id: `bad-${i}`, ...bad[i] } });
      assert.strictEqual(response.status, 202);
    }
    await enqueue('http-contract', 'good', { type: 'work', amount: 7 });
    const runtime = await create('http-contract'); await runtime.step();
    for (let i = 0; i < bad.length; i++) {
      const row = await store.getCommand('http-contract', `bad-${i}`);
      assert.strictEqual(row.status, 'applied'); assert.strictEqual(row.result.status, 'rejected');
    }
    assert.strictEqual(runtime.summary().tick, 1); assert.strictEqual(runtime.summary().status, 'idle');
    assert.strictEqual((await store.getCommand('http-contract', 'good')).result.status, 'completed');
    detachedJson(runtime.getWorld());
    pass('authenticated finite-but-malformed commands are terminally rejected and do not poison following work');

    const result = await request(port, `${base}/commands/good`);
    assert.strictEqual(result.status, 200); assert.strictEqual(result.body.data.result.outcome.value.amount, 7);
    assert.strictEqual(result.body.data.result.updatedAt, 1);
    assert.strictEqual((await request(port, `${base}/players/two/commands`)).status, 403);
    await api.close(); api = null;
    const audit = await audits.list({ worldId: 'http-contract', limit: 100 });
    for (const secret of ['owner-secret-token', 'not-a-number', 'inputDigest', '99999']) assert.ok(!JSON.stringify(audit).includes(secret));
    pass('HTTP readback publishes settled outcomes only after commit and audit retains safe fields');

    await seed('reserved');
    for (const id of ['__proto__', 'constructor', 'valid-after']) await enqueue('reserved', id, { type: 'wait' });
    const reserved = await create('reserved'); await reserved.step();
    assert.strictEqual((await store.getCommand('reserved', '__proto__')).result.outcome.reason, 'invalid_identifier');
    assert.strictEqual((await store.getCommand('reserved', 'constructor')).result.status, 'rejected');
    assert.strictEqual((await store.getCommand('reserved', 'valid-after')).result.status, 'completed');
    assert.strictEqual(Object.hasOwn(reserved.getWorld().commands.byId, '__proto__'), false);
    pass('legacy pending prototype-named command IDs drain without corrupting dictionaries or blocking FIFO');

    await seed('characters');
    await enqueue('characters', 'create', { type: 'create_character', payload: { name: 'New Hero', active: false, species: 'human', locationId: 'home' } });
    await enqueue('characters', 'steal', { type: 'switch_character', entityId: 'other' });
    const characters = await create('characters'); await characters.step();
    const created = await store.getCommand('characters', 'create');
    assert.deepStrictEqual(Object.keys(created.result.outcome.value).sort(), ['entityId', 'name', 'species']);
    assert.strictEqual(created.result.outcome.value.entityId, 'one_character_2');
    assert.strictEqual(characters.getWorld().players.byEntityId.other, 'two');
    assert.strictEqual(characters.getWorld().players.byId.one.activeEntityId, 'character');
    assert.strictEqual((await store.getCommand('characters', 'steal')).result.outcome.reason, 'character_not_owned');
    pass('safe character creation and ownership checks survive real checkpoint serialization');

    await seed('observer');
    await enqueue('observer', 'observe', { type: 'observe' });
    await enqueue('observer', 'forbidden-work', { type: 'work' });
    await enqueue('observer', 'switch', { type: 'switch_character', entityId: 'character' });
    await enqueue('observer', 'allowed-work', { type: 'work' });
    const observer = await create('observer'); await observer.step();
    assert.strictEqual((await store.getCommand('observer', 'forbidden-work')).result.outcome.reason, 'observer_cannot_act');
    assert.strictEqual((await store.getCommand('observer', 'allowed-work')).result.status, 'completed');
    pass('observer and character control transitions apply in durable FIFO order');

    await seed('moved-target');
    await enqueue('moved-target', 'gift', { type: 'transfer', targetId: 'other', amount: 5 });
    await enqueue('moved-target', 'depart', { type: 'move', locationId: 'away' }, 'two');
    const moved = await create('moved-target'); await moved.step();
    assert.strictEqual((await store.getCommand('moved-target', 'depart')).result.status, 'completed');
    assert.strictEqual((await store.getCommand('moved-target', 'gift')).result.outcome.reason, 'target_not_at_location');
    pass('targets are revalidated at action execution after higher-priority movement');

    await seed('lost-ack'); await enqueue('lost-ack', 'once', { type: 'work', amount: 9 });
    let failOnce = true, simulations = 0;
    const lost = await create('lost-ack', { simulationId: 'contract-lost-ack-v1',
      advance(world, ticks, options) { simulations++; advanceDeterministicBatch(world, ticks, options); },
      store: { ...store, async saveWorld(...args) { const result = await store.saveWorld(...args); if (failOnce) { failOnce = false; throw Object.assign(new Error('private'), { code: 'WORLD_DB_UNAVAILABLE' }); } return result; } } });
    await assert.rejects(lost.step()); assert.strictEqual(lost.getWorld().tick, 0);
    const committed = await store.getCommand('lost-ack', 'once');
    await lost.retry(); assert.strictEqual(simulations, 1);
    assert.deepStrictEqual(await store.getCommand('lost-ack', 'once'), committed);
    assert.strictEqual(lost.getWorld().commands.byId.once.status, 'completed');
    pass('lost acknowledgments retry the frozen settled result without executing commands or simulation again');

    await seed('rollback'); await enqueue('rollback', 'once', { type: 'work' });
    const broken = await create('rollback', { store: { ...store, saveWorld(world, opts) { return store.saveWorld(world, { ...opts, commandResults: opts.commandResults.map(r => ({ ...r, inputDigest: '0'.repeat(64) })) }); } } });
    await assert.rejects(broken.step(), { code: 'WORLD_DB_COMMAND_CONFLICT' });
    assert.strictEqual((await store.loadWorld('rollback')).tick, 0);
    assert.strictEqual((await store.getCommand('rollback', 'once')).status, 'pending');
    await broken.close({ flush: false });
    await cli('rollback'); const afterRestart = await store.getCommand('rollback', 'once');
    assert.strictEqual(afterRestart.result.status, 'completed');
    await cli('rollback'); assert.deepStrictEqual(await store.getCommand('rollback', 'once'), afterRestart);
    pass('SQL rollback preserves pending work and two fresh CLI processes recover without replay');

    const oldHash = digest({ version: 2, profile: 'culture-info-v1', simulation: {}, commands: { profile: 'postgres-inbox-v1', maxPerBatch: 100 } });
    await seed('upgrade', () => {}, { durableRuntime: { version: 2, configHash: oldHash } });
    await enqueue('upgrade', 'legacy-bad', { type: 'wait', ticks: 'bad' });
    await assert.rejects(cli('upgrade'), error => error.code === 1 && error.stderr.includes('WORLD_RUNTIME_COMMAND_PROFILE_UPGRADE_REQUIRED'));
    assert.strictEqual((await store.getWorldHead('upgrade')).revision, 1);
    await cli('upgrade', ['--upgrade-command-profile']);
    const upgraded = await store.loadWorld('upgrade');
    assert.strictEqual(upgraded.metadata.durableRuntime.version, 4);
    assert.strictEqual(upgraded.metadata.durableRuntime.upgradedFrom, oldHash);
    assert.strictEqual(upgraded.metadata.durableRuntime.commandProfile, COMMAND_PROFILE);
    assert.strictEqual((await store.getCommand('upgrade', 'legacy-bad')).result.status, 'rejected');
    await cli('upgrade');
    await assert.rejects(create('upgrade', { upgradeCommandProfile: true, simulation: { changed: true } }), { code: 'WORLD_RUNTIME_CONFIG_MISMATCH' });
    pass('old command profiles require explicit upgrade, preserve provenance and cannot authorize unrelated config changes');

    await seed('bounded', world => { for (let i = 0; i < 100; i++) assignGoal(world, 'character', { id: `goal-${i}`, type: 'gain_power', priority: 1, payload: { power: 1000000 } }); });
    await enqueue('bounded', 'too-many-goals', { type: 'set_goal' });
    await enqueue('bounded', 'still-works', { type: 'wait' });
    const bounded = await create('bounded'); await bounded.step();
    assert.strictEqual((await store.getCommand('bounded', 'too-many-goals')).result.outcome.reason, 'goal_limit');
    assert.strictEqual((await store.getCommand('bounded', 'still-works')).result.status, 'completed');
    assert.strictEqual((await store.getCommandQueue('bounded')).pending, 0);
    pass('live goal admission is bounded without preventing subsequent command consumption');

    console.log(`postgres player contract completed ${groups} scenario groups: ${groups} passed, 0 failed`);
  } finally {
    if (api) await api.close();
    await Promise.all(runtimes.map(r => r.close({ flush: false }).catch(() => {})));
    await audits.close(); await store.close();
    await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await raw.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
