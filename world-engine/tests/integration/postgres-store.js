'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');
const { createWorld } = require('../../core/world-engine');
const { saveWorld, loadWorld } = require('../../core/persistence-engine');
const { createPostgresDatabaseStore } = require('../../core/postgres-database-engine');
const { createDatabaseStore } = require('../../core/database-engine');
const { randomFloat } = require('../../core/random-engine');
const { nextWorldId } = require('../../core/world-id-engine');
const { MIGRATIONS } = require('../../storage/postgres/migrations');
function child(file, args, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [file, ...args], { env: { ...process.env, ...env }, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', c => { stdout += c; }); proc.stderr.on('data', c => { stderr += c; });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('PostgreSQL test child timed out')); }, 20000);
    proc.on('error', error => { clearTimeout(timer); reject(error); });
    proc.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function main() {
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  if (!connectionString) throw new Error('WORLD_ENGINE_TEST_DATABASE_URL is required; integration tests never silently skip');
  const url = new URL(connectionString);
  assert.ok(/_(ci|test)$/.test(url.pathname), 'Tests require an explicitly named _ci or _test database');
  const schema = `test_world_${crypto.randomBytes(8).toString('hex')}`, quoted = `"${schema}"`;
  const raw = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
  const options = { connectionString, schema };
  const a = createPostgresDatabaseStore(options), b = createDatabaseStore({ provider: 'postgres', ...options });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-world-test-'));
  let groups = 0;
  const pass = name => { groups += 1; console.log(`PASS ${name}`); };
  try {
    const versions = await Promise.all([a.migrate(), b.migrate()]);
    assert.strictEqual(versions.reduce((sum, r) => sum + r.applied, 0), 1);
    assert.strictEqual((await a.migrate()).applied, 0);
    pass('concurrent and repeatable schema migration');

    const world = createWorld({ id: 'sql_world', seed: 'postgres-replay' }); world.tick = 17;
    randomFloat(world, 'before'); nextWorldId(world, 'event', 'before');
    const original = JSON.stringify(world);
    const saved1 = await a.saveWorld(world, { expectedRevision: 0, requestId: 'first', events: [{ id: 'first-event', type: 'test.tick' }] });
    assert.strictEqual(saved1.revision, 1); assert.strictEqual(JSON.stringify(world), original);
    assert.strictEqual((await a.summary()).events, 2);
    pass('atomic snapshot, event, version and unchanged caller state');

    let loaded = await b.loadWorld(); assert.strictEqual(loaded.tick, 17);
    const replayCopy = JSON.parse(original);
    assert.strictEqual(randomFloat(loaded.world, 'after'), randomFloat(replayCopy, 'after'));
    assert.strictEqual(nextWorldId(loaded.world, 'event', 'another.namespace'), nextWorldId(replayCopy, 'event', 'another.namespace'));
    const reopened = createPostgresDatabaseStore(options);
    try { assert.strictEqual((await reopened.loadWorld('sql_world')).revision, 1); } finally { await reopened.close(); }
    pass('connection restart, random-stream and ID continuation');

    world.tick = 5;
    const saveOptions = { expectedRevision: 1, requestId: 'rollback-save' };
    const second = await a.saveWorld(world, saveOptions);
    assert.strictEqual(second.revision, 2); assert.strictEqual((await a.loadWorld()).tick, 5);
    assert.strictEqual((await a.loadWorld('sql_world', { revision: 1 })).tick, 17);
    const retry = await b.saveWorld(world, saveOptions);
    assert.strictEqual(retry.idempotent, true); assert.strictEqual(retry.sequence, second.sequence);
    assert.strictEqual((await a.summary()).records, 2);
    pass('latest revision after tick rollback and idempotent retry');

    await assert.rejects(a.saveWorld(world, { expectedRevision: 1, requestId: 'stale' }), e => e.code === 'WORLD_DB_REVISION_CONFLICT');
    await assert.rejects(a.saveWorld({ ...world, tick: 6 }, saveOptions), e => e.code === 'WORLD_DB_IDEMPOTENCY_CONFLICT');
    assert.strictEqual((await a.summary()).records, 2);
    pass('stale writer and request-ID mismatch rejection');

    const writers = await Promise.all(['one','two'].map(id => child(path.join(__dirname, 'postgres-writer.js'), [schema,world.id,'2',id])));
    assert.deepStrictEqual(writers.map(r => r.code).sort(), [0,2], JSON.stringify(writers));
    loaded = await a.loadWorld(world.id); assert.strictEqual(loaded.revision, 3);
    pass('two independent writer processes cannot overwrite one revision');

    const beforeRollback = await a.summary();
    await raw.query(`CREATE FUNCTION ${quoted}.reject_test_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.type = 'test.reject' THEN RAISE EXCEPTION 'intentional test event failure'; END IF; RETURN NEW; END $$`);
    await raw.query(`CREATE TRIGGER reject_test_event BEFORE INSERT ON ${quoted}.world_events FOR EACH ROW EXECUTE FUNCTION ${quoted}.reject_test_event()`);
    await assert.rejects(a.saveWorld(createWorld({ id: 'must_not_exist' }), { expectedRevision: 0, requestId: 'reject', events: [{ type: 'test.reject' }] }), e => e.code === 'WORLD_DB_SQL_ERROR');
    await assert.rejects(a.saveWorld(loaded.world, { expectedRevision: 3, requestId: 'reject-existing', events: [{ type: 'test.reject' }] }), e => e.code === 'WORLD_DB_SQL_ERROR');
    const afterRollback = await a.summary();
    for (const key of ['worlds','records','events']) assert.strictEqual(afterRollback[key], beforeRollback[key]);
    assert.strictEqual(await a.loadWorld('must_not_exist'), null); assert.strictEqual((await a.loadWorld(world.id)).revision, 3);
    await raw.query(`DROP TRIGGER reject_test_event ON ${quoted}.world_events`);
    pass('SQL failure rolls back snapshot, head, audit event and new-world row');

    const concurrentRetry = await Promise.all([a,b].map(store => store.saveWorld(loaded.world, { expectedRevision: 3, requestId: 'same-retry' })));
    assert.strictEqual(concurrentRetry[0].sequence, concurrentRetry[1].sequence);
    assert.strictEqual(concurrentRetry.filter(r => r.idempotent).length, 1);
    pass('concurrent identical requests commit once');

    const event = { id: 'external-1', worldId: world.id, tick: 6, type: 'test.external', payload: { note: "'; DROP SCHEMA public;--" } };
    const event1 = await a.appendEvent(event), event2 = await b.appendEvent(event);
    assert.strictEqual(event2.idempotent, true); assert.strictEqual(event1.sequence, event2.sequence);
    await assert.rejects(a.appendEvent({ ...event, tick: 7 }), e => e.code === 'WORLD_DB_IDEMPOTENCY_CONFLICT');
    const filtered = await a.listEvents({ worldId: world.id, type: 'test.external', order: 'asc', afterSequence: 0, limit: 1 });
    assert.strictEqual(filtered[0].id, event.id); assert.deepStrictEqual(await a.listEvents({ afterSequence: event1.sequence }), []);
    await assert.rejects(a.listEvents({ limit: 0 })); await assert.rejects(a.listEvents({ order: 'desc;drop' }));
    pass('idempotent events and bounded parameterized filtering');

    const attackName = "world'; DROP TABLE worlds;--";
    await a.saveWorld(createWorld({ id: attackName }), { expectedRevision: 0, requestId: 'quoted-world' });
    assert.strictEqual((await b.loadWorld(attackName)).world.id, attackName);
    await assert.rejects(a.loadWorld(), e => e.code === 'WORLD_DB_AMBIGUOUS_WORLD');
    assert.strictEqual((await a.listWorlds()).length, 2);
    pass('SQL values remain data and ambiguous world selection is refused');

    const row = (await raw.query(`SELECT * FROM ${quoted}.world_saves WHERE world_id=$1 AND revision=4`, [world.id])).rows[0];
    await raw.query(`UPDATE ${quoted}.world_saves SET envelope=jsonb_set(envelope,'{world,corrupt}','true'::jsonb) WHERE sequence=$1`, [row.sequence]);
    await assert.rejects(a.loadWorld(world.id), e => e.code === 'WORLD_DB_CORRUPT_RECORD');
    await raw.query(`UPDATE ${quoted}.world_saves SET envelope=$1::jsonb WHERE sequence=$2`, [JSON.stringify(row.envelope),row.sequence]);
    await assert.rejects(raw.query(`UPDATE ${quoted}.world_saves SET tick=-1 WHERE sequence=$1`, [row.sequence]), e => e.code === '23514');
    pass('checksum corruption and database numeric constraints');

    await raw.query(`UPDATE ${quoted}.schema_migrations SET checksum=$1 WHERE version=1`, ['0'.repeat(64)]);
    await assert.rejects(a.migrate(), e => e.code === 'WORLD_DB_SCHEMA_MISMATCH');
    await raw.query(`UPDATE ${quoted}.schema_migrations SET checksum=$1 WHERE version=1`, [MIGRATIONS[0].checksum]);
    await raw.query(`INSERT INTO ${quoted}.schema_migrations(version,name,checksum) VALUES (99,'future',$1)`, ['0'.repeat(64)]);
    await assert.rejects(b.migrate(), e => e.code === 'WORLD_DB_SCHEMA_MISMATCH');
    await raw.query(`DELETE FROM ${quoted}.schema_migrations WHERE version=99`);
    pass('changed migrations and future versions fail without replacing history');

    const input = path.join(directory, 'input.json'), output = path.join(directory, 'export.json');
    const imported = createWorld({ id: 'cli_world', seed: 'cli' }); imported.tick = 9; saveWorld(imported, input);
    const cli = path.join(__dirname, '../../demo/database-postgres-cli.js');
    const cliEnv = { WORLD_ENGINE_DATABASE_URL: connectionString, WORLD_ENGINE_DB_SCHEMA: schema };
    const importedResult = await child(cli, ['import','--input',input,'--expected-revision','0','--request-id','cli-1'], cliEnv);
    assert.strictEqual(importedResult.code, 0, importedResult.stderr);
    const exportedResult = await child(cli, ['export','--world-id','cli_world','--output',output], cliEnv);
    assert.strictEqual(exportedResult.code, 0, exportedResult.stderr); assert.strictEqual(loadWorld(output).world.tick, 9);
    assert.strictEqual((await child(cli, ['export','--world-id','cli_world','--output',output], cliEnv)).code, 1);
    const status = await child(cli, ['status'], cliEnv); assert.strictEqual(status.code, 0);
    if (url.password) assert.ok(!status.stdout.includes(url.password));
    pass('real CLI import, export, status and exclusive output creation');

    const brokenUrl = new URL(connectionString); brokenUrl.port = '1';
    const offline = createPostgresDatabaseStore({ connectionString: brokenUrl.toString(), schema, connectionTimeoutMillis: 200 });
    try { await assert.rejects(offline.summary(), e => e.code === 'WORLD_DB_UNAVAILABLE'); } finally { await offline.close(); }
    pass('unavailable database fails closed');
    console.log(`postgres integration completed ${groups} scenario groups: ${groups} passed, 0 failed`);
  } finally {
    await Promise.all([a.close(),b.close()]);
    // Drop only the random schema created here, in an explicit test database.
    await raw.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await raw.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
