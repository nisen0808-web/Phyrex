'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Pool } = require('pg');
const { createPostgresDatabaseStore } = require('../../storage/postgres/store');
const { createDurableCommandApiServer } = require('../../core/durable-command-api-engine');
const { digest } = require('../../storage/postgres/codec');
const execute = promisify(execFile);

async function main() {
  const connectionString = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
  if (!connectionString || !/_(ci|test)$/.test(new URL(connectionString).pathname)) throw new Error('Isolated test database required; no silent skip');
  const schema = `test_quickstart_${crypto.randomBytes(7).toString('hex')}`;
  const env = { ...process.env, WORLD_ENGINE_DATABASE_URL: connectionString, WORLD_ENGINE_DB_SCHEMA: schema };
  delete env.WORLD_ENGINE_SESSION_TOKEN;
  const restoreEnv = { ...env, WORLD_ENGINE_DB_SCHEMA: `${schema}_restored` };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-quickstart-'));
  const worldFile = path.join(directory, 'world.json'), tokenFile = path.join(directory, 'session.token'), backupFile = path.join(directory, 'backup.ndjson');
  const cli = (name, args, selectedEnv = env) => execute(process.execPath, [path.join(__dirname, '../../demo', name), ...args],
    { env: selectedEnv, timeout: 60000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  const store = createPostgresDatabaseStore({ connectionString, schema });
  const restored = createPostgresDatabaseStore({ connectionString, schema: `${schema}_restored` });
  const raw = new Pool({ connectionString });
  let api, groups = 0;
  const pass = label => { groups++; console.log(`PASS ${label}`); };
  try {
    await cli('engine-init-cli.js', ['--output', worldFile, '--world-id', 'quickstart', '--seed', 'quickstart', '--population', '4']);
    await cli('database-postgres-cli.js', ['migrate']);
    await cli('database-postgres-cli.js', ['import', '--input', worldFile, '--expected-revision', '0', '--request-id', 'bootstrap']);
    assert.strictEqual((await store.loadWorld('quickstart')).revision, 1);
    assert.strictEqual((await store.loadWorld('quickstart')).world.simulation.options.process.preserveActive, true);
    pass('documented initialization, migration and import commands work as fresh processes');

    const common = ['--world-id', 'quickstart', '--account-id', 'operator'];
    await cli('account-admin-cli.js', ['account.create', ...common, '--roles', 'admin', '--request-id', 'operator', '--expected-revision', '1']);
    await cli('account-admin-cli.js', ['player.link', ...common, '--player-id', 'observer', '--request-id', 'link', '--expected-revision', '2']);
    await cli('account-admin-cli.js', ['token.create', '--output', tokenFile]);
    const issued = await cli('account-admin-cli.js', ['session.issue', ...common, '--token-file', tokenFile, '--request-id', 'session', '--expected-revision', '3']);
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    assert.strictEqual(issued.stdout.includes(token), false); assert.strictEqual(issued.stderr.includes(token), false);
    const inspect = JSON.parse((await cli('account-admin-cli.js', ['inspect', ...common])).stdout);
    assert.strictEqual(inspect.revision, 4); assert.strictEqual(inspect.account.sessions.length, 1);
    pass('operator bootstrap and session file issuance work without command-line or output credentials');

    api = await createDurableCommandApiServer({ env, rateLimitNow: () => 0 });
    await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${api.server.address().port}/durable/worlds/quickstart`;
    const submit = id => fetch(`${url}/players/observer/commands`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id, type: 'wait' }) });
    assert.strictEqual((await submit('first')).status, 202);
    await cli('durable-runtime-cli.js', ['--world-id', 'quickstart', '--batches', '2', '--ticks-per-batch', '5', '--interval', '10']);
    assert.strictEqual((await store.loadWorld('quickstart')).tick, 10);
    assert.strictEqual((await store.getCommand('quickstart', 'first')).status, 'applied');
    assert.strictEqual((await (await submit('first')).json()).data.idempotent, true);
    pass('CLI runtime commits two batches and authenticated duplicate commands retain their terminal result');

    assert.strictEqual((await submit('pending')).status, 202);
    await api.close(); api = null;
    await cli('database-backup-cli.js', ['export', backupFile]);
    const verification = JSON.parse((await cli('database-backup-cli.js', ['verify', backupFile])).stdout);
    assert.strictEqual(verification.valid, true); assert.ok(verification.counts.command_api_audit >= 3);
    await cli('database-postgres-cli.js', ['migrate'], restoreEnv);
    await cli('database-backup-cli.js', ['restore', backupFile], restoreEnv);
    assert.strictEqual(digest((await store.loadWorld('quickstart')).world), digest((await restored.loadWorld('quickstart')).world));
    assert.strictEqual((await restored.getCommand('quickstart', 'pending')).status, 'pending');
    pass('CLI full backup and empty-schema restoration preserve world, pending command and drained HTTP audits');

    await cli('durable-runtime-cli.js', ['--world-id', 'quickstart', '--batches', '1'], restoreEnv);
    assert.strictEqual((await restored.loadWorld('quickstart')).tick, 11);
    assert.strictEqual((await restored.getCommand('quickstart', 'pending')).status, 'applied');
    assert.strictEqual((await restored.getCommand('quickstart', 'first')).status, 'applied');
    pass('a fresh runtime process resumes the restored world and consumes only pending work');

    for (const [name, args] of [['engine-init-cli.js', ['--output', worldFile]], ['database-backup-cli.js', ['export', backupFile]]]) {
      await assert.rejects(cli(name, args), error => {
        assert.ok(!String(error.stdout).includes(connectionString)); assert.ok(!String(error.stderr).includes(token)); return error.code !== 0;
      });
    }
    assert.ok(!fs.readFileSync(backupFile, 'utf8').includes(token));
    assert.strictEqual((await store.loadWorld('quickstart')).tick, 10);
    pass('existing artifacts are not overwritten and errors cannot expose the database URL or token');
    console.log(`postgres quickstart completed ${groups} scenario groups: ${groups} passed, 0 failed`);
  } finally {
    if (api) await api.close(); await store.close(); await restored.close();
    await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await raw.query(`DROP SCHEMA IF EXISTS "${schema}_restored" CASCADE`); await raw.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
