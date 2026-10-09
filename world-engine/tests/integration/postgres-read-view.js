'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createPostgresDatabaseStore } = require('../../storage/postgres/store');
const { createDurableCommandApiServer } = require('../../core/durable-command-api-engine');
const { fixture, request } = require('../helpers/service-fixture');
const { digest } = require('../../storage/postgres/codec');
const { playerStateView } = require('../../core/durable-state-view-engine');
const { revokeSession } = require('../../core/account-session-engine');
async function main() {
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  assert(connectionString && /_(ci|test)$/.test(new URL(connectionString).pathname), 'Isolated _ci/_test database required; never skip');
  const schema = 'test_read_view_' + crypto.randomBytes(8).toString('hex'), q = `"${schema}"`;
  const store = createPostgresDatabaseStore({ connectionString, schema });
  const raw = new Pool({ connectionString, max: 2 }); let api, renamed = false, groups = 0;
  const pass = name => { groups++; console.log('PASS ' + name); };
  const world = fixture().state.world, base = '/durable/worlds/' + world.id;
  try {
    await store.migrate(); await store.saveWorld(world, { expectedRevision: 0, requestId: 'seed' });
    const first = await store.loadWorldView(world.id), again = await store.loadWorldView(world.id);
    assert.strictEqual(first, again); assert.deepStrictEqual(first, await store.loadWorld(world.id));
    assert(Object.isFrozen(first.world.accounts.sessions));
    assert.throws(() => { first.world.entities.character.stats.health = -1; }, TypeError);
    const mutable = await store.loadWorld(world.id); mutable.world.entities.character.name = 'private mutation';
    assert.notStrictEqual(first.world.entities.character.name, mutable.world.entities.character.name);
    pass('warm reads reuse a deeply immutable view; normal runtime loads stay detached and mutable');

    api = await createDurableCommandApiServer({ store, rateLimitNow: () => 0 });
    await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve)); const port = api.server.address().port;
    const originalDigest = digest(first.world);
    const views = await Promise.all(Array.from({ length: 4 }, () => request(port, base + '/players/one/state')));
    for (const response of views) { assert.equal(response.status, 200); assert.deepStrictEqual(response.body.data, playerStateView(first.world, first.revision, 'one')); }
    assert.equal((await request(port, base + '/players/two/state')).status, 403);
    assert.equal((await request(port, base + '/admin/summary')).status, 403);
    assert.equal(digest(first.world), originalDigest);
    pass('concurrent HTTP views preserve projection, ownership, roles and cached account immutability');

    const revoked = await store.loadWorld(world.id); revokeSession(revoked.world, 'owner-secret-token');
    await store.saveWorld(revoked.world, { expectedRevision: 1, requestId: 'revoke' });
    assert.equal((await store.loadWorldView(world.id)).revision, 2);
    assert.equal((await request(port, base + '/players/one/state')).status, 401);
    pass('a new committed revision invalidates a warm view and revocation applies to the very next request');

    const saved = await raw.query(`SELECT envelope FROM ${q}.world_saves WHERE world_id=$1 AND revision=2`, [world.id]);
    await raw.query(`UPDATE ${q}.world_saves SET envelope=jsonb_set(envelope,'{world,name}','"corrupt"'::jsonb) WHERE world_id=$1 AND revision=2`, [world.id]);
    await assert.rejects(store.loadWorldView(world.id), { code: 'WORLD_DB_CORRUPT_RECORD' });
    await raw.query(`UPDATE ${q}.world_saves SET envelope=$2::jsonb WHERE world_id=$1 AND revision=2`, [world.id, JSON.stringify(saved.rows[0].envelope)]);
    assert.equal((await store.loadWorldView(world.id)).revision, 2);
    pass('SQL row changes invalidate warm data even with unchanged revision and checksum; corruption is rejected');

    await raw.query(`ALTER TABLE ${q}.world_saves RENAME TO unavailable_saves`); renamed = true;
    await assert.rejects(store.loadWorldView(world.id), { code: 'WORLD_DB_MIGRATION_REQUIRED' });
    assert.equal((await request(port, base + '/admin/summary', { token: 'admin-secret-token' })).status, 503);
    await raw.query(`ALTER TABLE ${q}.unavailable_saves RENAME TO world_saves`); renamed = false;
    assert.equal((await request(port, base + '/admin/summary', { token: 'admin-secret-token' })).status, 200);
    assert.equal(await store.loadWorldView('missing-world'), null);
    pass('database failure and missing world never return a stale successful cache entry');

    const a = await store.loadWorldView(world.id);
    await store.saveWorld({ ...world, id: 'other' }, { expectedRevision: 0, requestId: 'other' });
    assert.equal((await store.loadWorldView('other')).world.id, 'other');
    const b = await store.loadWorldView(world.id); assert.notStrictEqual(a, b); assert.deepStrictEqual(a, b);
    pass('only one world checkpoint is retained, so cross-world reads cannot grow an unbounded cache');

    const expiry = await store.loadWorld(world.id); expiry.world.tick = 20000;
    await store.saveWorld(expiry.world, { expectedRevision: 2, requestId: 'expire' });
    const immutable = await store.loadWorldView(world.id), before = digest(immutable.world);
    assert.equal((await request(port, base + '/admin/summary', { token: 'admin-secret-token' })).status, 401);
    assert.equal((await request(port, base + '/admin/summary', { token: 'admin-secret-token' })).status, 401);
    assert.equal(digest(immutable.world), before);
    pass('session expiry is checked on each request without mutating shared account state');

    await api.close(); api = null; await store.close();
    await assert.rejects(store.loadWorldView(world.id), { code: 'WORLD_DB_CLOSED' });
    pass('closing the adapter clears its retained view and denies further reads');
    assert.equal(groups, 8);
    console.log('postgres read view completed 8 scenario groups: 8 passed, 0 failed');
  } finally {
    if (api) await api.close(); await store.close();
    if (renamed) await raw.query(`ALTER TABLE ${q}.unavailable_saves RENAME TO world_saves`);
    await raw.query(`DROP SCHEMA IF EXISTS ${q} CASCADE`); await raw.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
