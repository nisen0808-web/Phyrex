'use strict';
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Pool } = require('pg');
const { createPostgresDatabaseStore } = require('../../storage/postgres/store');
const { createPostgresCommandApiAuditStore } = require('../../storage/postgres/command-api-audit-store');
const { createDurableCommandApiServer } = require('../../core/durable-command-api-engine');
const { fixture, request } = require('../helpers/service-fixture');
const execute = promisify(execFile);
async function main() {
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  if (!connectionString || !/_(ci|test)$/.test(new URL(connectionString).pathname)) throw new Error('Isolated PostgreSQL _ci/_test database required; no silent skip');
  const schema = `test_queue_${crypto.randomBytes(7).toString('hex')}`;
  const options = { connectionString, schema, maxPendingCommands: 6, maxPendingPerPlayer: 3 };
  const a = createPostgresDatabaseStore(options), b = createPostgresDatabaseStore(options);
  const audits = createPostgresCommandApiAuditStore(options), raw = new Pool({ connectionString });
  const world = fixture().state.world, worldId = world.id, base = `/durable/worlds/${worldId}`;
  const command = (id, playerId = 'one', selectedWorld = worldId) => ({ worldId: selectedWorld, playerId, id,
    input: { id, type: 'wait', payload: { secret: 'private-input' } } });
  let groups = 0, api, low;
  const pass = label => { groups++; console.log(`PASS ${label}`); };
  try {
    await a.migrate(); await a.saveWorld(world, { expectedRevision: 0, requestId: 'bootstrap' });
    const first = await Promise.allSettled(Array.from({ length: 16 }, (_, index) => (index % 2 ? a : b).enqueueCommand(command(`one-${index}`))));
    assert.strictEqual(first.filter(row => row.status === 'fulfilled').length, 3);
    assert.ok(first.filter(row => row.status === 'rejected').every(row => row.reason.code === 'WORLD_DB_PLAYER_QUEUE_FULL'));
    assert.strictEqual((await a.getCommandQueue(worldId)).pending, 3);
    pass('concurrent independent connections cannot overrun the per-player pending cap');

    const one = first.filter(row => row.status === 'fulfilled').map(row => row.value);
    const beforeDuplicates = (await raw.query(`SELECT last_value FROM "${schema}".world_commands_sequence_seq`)).rows[0].last_value;
    const duplicates = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? a : b).enqueueCommand(command(one[0].id))));
    assert.ok(duplicates.every(row => row.idempotent && row.sequence === one[0].sequence));
    assert.strictEqual((await raw.query(`SELECT last_value FROM "${schema}".world_commands_sequence_seq`)).rows[0].last_value, beforeDuplicates);
    await assert.rejects(a.enqueueCommand({ ...command(one[0].id), input: { type: 'inspect' } }), { code: 'WORLD_DB_IDEMPOTENCY_CONFLICT' });
    pass('full player queues acknowledge identical retries without allocating new sequence IDs');

    const second = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => (index % 2 ? a : b).enqueueCommand(command(`two-${index}`, 'two'))));
    assert.strictEqual(second.filter(row => row.status === 'fulfilled').length, 3);
    assert.ok(second.filter(row => row.status === 'rejected').every(row => row.reason.code === 'WORLD_DB_QUEUE_FULL'));
    assert.strictEqual((await a.getCommandQueue(worldId)).pending, 6);
    assert.strictEqual((await a.getCommandQueue(worldId)).worldCapacityAvailable, false);
    assert.strictEqual((await b.enqueueCommand(command(one[0].id))).idempotent, true);
    await a.saveWorld({ ...world, id: 'other-world' }, { expectedRevision: 0, requestId: 'other-world' });
    assert.strictEqual((await b.enqueueCommand(command('other-command', 'one', 'other-world'))).status, 'pending');
    pass('world capacity is shared across players and isolated from other worlds');

    world.tick = 1;
    const receipts = one.map(row => ({ sequence: row.sequence, id: row.id, playerId: row.playerId, inputDigest: row.inputDigest, result: { private: 'private-result' } }));
    await assert.rejects(a.saveWorld(world, { expectedRevision: 1, requestId: 'failed-consume', commandResults: [{ ...receipts[0], inputDigest: '0'.repeat(64) }] }), { code: 'WORLD_DB_COMMAND_CONFLICT' });
    assert.strictEqual((await a.getCommandQueue(worldId)).pending, 6);
    await a.saveWorld(world, { expectedRevision: 1, requestId: 'consume', commandResults: receipts });
    assert.strictEqual((await a.getCommandQueue(worldId)).pending, 3);
    const oldApplied = await b.enqueueCommand(command(one[0].id)); assert.strictEqual(oldApplied.status, 'applied'); assert.strictEqual(oldApplied.idempotent, true);
    pass('capacity is released only by committed application, never rolled-back checkpoints');

    const page1 = await a.listCommandReceipts({ worldId, playerId: 'one', limit: 2 }, { expectedWorldRevision: 2 });
    assert.deepStrictEqual(page1.records.map(row => row.sequence), one.map(row => row.sequence).sort((x, y) => y - x).slice(0, 2));
    const extra = await b.enqueueCommand(command('after-first-page'));
    const page2 = await a.listCommandReceipts({ worldId, playerId: 'one', limit: 2, beforeSequence: page1.records[1].sequence });
    assert.strictEqual(page2.records.length, 1); assert.ok(page2.records.every(row => !page1.records.some(prev => prev.sequence === row.sequence) && row.sequence !== extra.sequence));
    const applied = await a.listCommandReceipts({ worldId, playerId: 'one', status: 'applied' });
    assert.strictEqual(applied.records.length, 3);
    assert.ok(!JSON.stringify(applied).includes('private-')); assert.ok(!JSON.stringify(applied).includes('inputDigest'));
    await assert.rejects(a.listCommandReceipts({ worldId, playerId: 'one' }, { expectedWorldRevision: 1 }), { code: 'WORLD_DB_REVISION_CONFLICT' });
    pass('receipt pages remain ordered under new inserts and exclude raw input, result and digests');

    let revokeOwner = false, revokeAdmin = false;
    const raced = { ...a,
      async listCommandReceipts(query, readOptions) {
        if (revokeOwner) {
          revokeOwner = false; const loaded = await b.loadWorld(worldId);
          loaded.world.accounts.byId.owner.playerIds = []; delete loaded.world.accounts.byPlayer.one;
          await b.saveWorld(loaded.world, { expectedRevision: loaded.revision, requestId: 'revoke-owner' });
        }
        return a.listCommandReceipts(query, readOptions);
      },
      async getCommandQueue(selected, readOptions) {
        if (revokeAdmin) {
          revokeAdmin = false; const loaded = await b.loadWorld(worldId); loaded.world.accounts.byId.operator.roles = ['player'];
          await b.saveWorld(loaded.world, { expectedRevision: loaded.revision, requestId: 'revoke-admin' });
        }
        return a.getCommandQueue(selected, readOptions);
      },
    };
    api = await createDurableCommandApiServer({ store: raced, auditStore: audits, rateLimitNow: () => 0 });
    await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
    const port = api.server.address().port;
    const history = await request(port, `${base}/players/one/commands?limit=2`); assert.strictEqual(history.status, 200); assert.strictEqual(history.body.data.records.length, 2);
    assert.strictEqual((await request(port, `${base}/players/two/commands`)).status, 403);
    assert.strictEqual((await request(port, `${base}/admin/queue`)).status, 403);
    assert.strictEqual((await request(port, `${base}/admin/queue`, { token: 'admin-secret-token' })).body.data.pending, 4);
    const full = await request(port, `${base}/players/two/commands`, { method: 'POST', token: 'admin-secret-token', body: { id: 'overflow', type: 'wait' } });
    assert.strictEqual(full.status, 429); assert.strictEqual(full.body.error, 'player_queue_full'); assert.strictEqual(full.headers.get('retry-after'), '1');
    assert.strictEqual(await a.getCommand(worldId, 'overflow'), null);
    assert.strictEqual((await request(port, `${base}/players/one/commands?limit=101`)).status, 400);
    pass('HTTP history and queue routes enforce permissions, strict bounds and safe capacity responses');

    revokeOwner = true;
    const deniedHistory = await request(port, `${base}/players/one/commands`);
    assert.strictEqual(deniedHistory.status, 403); assert.ok(!JSON.stringify(deniedHistory.body).includes('receipt'));
    pass('a concurrent ownership revocation invalidates history authorization before SQL readback');

    revokeAdmin = true;
    assert.strictEqual((await request(port, `${base}/admin/queue`, { token: 'admin-secret-token' })).status, 403);
    await api.close(); api = null;
    const auditRows = await audits.list({ worldId, limit: 100 });
    assert.ok(auditRows.some(row => row.route === 'history' && row.statusCode === 200));
    assert.ok(auditRows.some(row => row.route === 'queue' && row.statusCode === 403));
    assert.ok(auditRows.some(row => row.errorCode === 'player_queue_full'));
    assert.ok(!JSON.stringify(auditRows).includes('private-'));
    pass('administrator revocation fences queue reads and new operations retain safe durable audit');

    low = createPostgresDatabaseStore({ ...options, maxPendingCommands: 2 });
    const overfull = await low.getCommandQueue(worldId);
    assert.strictEqual(overfull.pending, 3); assert.strictEqual(overfull.pendingIsLowerBound, true); assert.strictEqual(overfull.worldCapacityAvailable, false);
    assert.strictEqual((await low.enqueueCommand(command(extra.id))).idempotent, true);
    await assert.rejects(low.enqueueCommand(command('after-reconfiguration')), { code: 'WORLD_DB_QUEUE_FULL' });
    assert.strictEqual((await a.listPendingCommands(worldId)).length, 4);
    await low.close(); low = null;
    pass('restarting with a lower cap preserves pending work and reports a bounded lower-bound count');

    const env = { ...process.env, WORLD_ENGINE_DATABASE_URL: connectionString, WORLD_ENGINE_DB_SCHEMA: schema,
      WORLD_ENGINE_COMMAND_QUEUE_MAX_PENDING: '6', WORLD_ENGINE_COMMAND_QUEUE_MAX_PLAYER_PENDING: '3' };
    const run = () => execute(process.execPath, [path.join(__dirname, '../../demo/durable-runtime-cli.js'), '--world-id', worldId, '--batches', '1'], { env, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true });
    const oldSaveSequence = (await a.getCommand(worldId, one[0].id)).appliedSaveSequence;
    await run(); assert.strictEqual((await a.getCommandQueue(worldId)).pending, 0);
    assert.strictEqual((await a.getCommand(worldId, extra.id)).status, 'applied');
    await run(); assert.strictEqual((await a.getCommand(worldId, one[0].id)).appliedSaveSequence, oldSaveSequence);
    assert.strictEqual((await a.enqueueCommand(command('resumed-new-command'))).status, 'pending');
    pass('fresh runtime processes drain persistent work, reopen capacity and never replay applied commands');
    console.log(`postgres command queue completed ${groups} scenario groups: ${groups} passed, 0 failed`);
  } finally {
    if (api) await api.close(); if (low) await low.close();
    await a.close(); await b.close(); await audits.close(); await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await raw.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
