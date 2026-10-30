'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { header, TABLES, SEQUENCED, exportBackupFile, verifyBackupFile } = require('../storage/postgres/backup');

const errorCode = 'WORLD_DB_BACKUP_DIRECTORY_SYNC_FAILED';
const counts = Object.fromEntries(Object.keys(TABLES).map(table => [table, 0]));
const sequences = { type: 'sequences', values: Object.fromEntries(SEQUENCED.map(table => [table, { lastValue: '1', isCalled: false }])) };
const emptyStore = { async exportSnapshot(write) { await write(header()); await write(sequences); return { counts }; } };
function failure(error) { return error.code === errorCode && !error.message.includes('private-path'); }

// Fault-injected directory operations, with real native temporary file writes,
// file sync, hard-link publication and cleanup. No claim of native directory
// durability is made for these modeled scenarios.
function modelDirectory(directory, failAt, gate) {
  const original = { open: fs.promises.open, link: fs.promises.link, unlink: fs.promises.unlink };
  const events = [];
  let cycle = 0;
  const step = async (stage, n) => {
    events.push(`directory.${stage}.${n}`);
    if (failAt?.stage === stage && failAt.cycle === n) throw Object.assign(new Error('private-path: injected'), { code: 'EIO' });
    if (gate && stage === 'sync' && n === 2) await gate;
  };
  fs.promises.open = async (file, ...args) => {
    if (path.resolve(file) === directory) {
      const n = ++cycle;
      await step('open', n);
      return { sync: () => step('sync', n), close: () => step('close', n) };
    }
    events.push('file.open');
    const handle = await original.open(file, ...args);
    return {
      writeFile: (...values) => handle.writeFile(...values),
      async sync() { events.push('file.sync'); await handle.sync(); },
      async close() { events.push('file.close'); await handle.close(); },
    };
  };
  fs.promises.link = async (...args) => { events.push('file.link'); return original.link(...args); };
  fs.promises.unlink = async (file, ...args) => { events.push(`unlink:${path.basename(file)}`); return original.unlink(file, ...args); };
  return { events, restore() { Object.assign(fs.promises, original); } };
}

async function maintenanceGate(directory, operation, failAt) {
  const storeModule = require('../storage/postgres/store');
  const originalCreate = storeModule.createPostgresDatabaseStore;
  const cliPath = require.resolve('../demo/database-maintenance-cli');
  const originalCli = require.cache[cliPath];
  const state = { envelopes: ['original'], auditRows: ['original'], compactCalls: 0, retireCalls: 0, closed: 0 };
  const fake = {
    async exportSnapshot(write) {
      await write(header());
      await write({ type: 'row', table: 'worlds', values: { world_id: 'world', revision: 6, latest_sequence: null, updated_at: '2026-10-26T00:00:00Z' } });
      await write({ type: 'row', table: 'command_api_audit', values: { sequence: 1, world_id: 'world', request_id: 'audit', account_id: null,
        player_id: null, command_id: null, method: 'GET', route: 'durable.audit.list', status_code: 200, error_code: null, created_at: '2026-10-26T00:00:00Z' } });
      await write({ ...sequences, values: Object.fromEntries(SEQUENCED.map(table => [table, { lastValue: '2', isCalled: false }])) });
      return { counts: { ...counts, worlds: 1, command_api_audit: 1 } };
    },
    async compactCheckpoints() { state.compactCalls++; state.envelopes.length = 0; return { applied: true }; },
    async retireAuditRecords() { state.retireCalls++; state.auditRows.length = 0; return { retired: 1 }; },
    async close() { state.closed++; },
  };
  storeModule.createPostgresDatabaseStore = () => fake;
  delete require.cache[cliPath];
  const { main } = require(cliPath);
  const model = failAt ? modelDirectory(directory, failAt) : null;
  const backupFile = path.join(directory, `${operation}-${failAt ? `${failAt.cycle}-${failAt.stage}` : 'native'}.ndjson`);
  try {
    const args = operation === 'checkpoints'
      ? ['checkpoints', '--world-id', 'world', '--expected-revision', '6', '--apply', '--backup', backupFile]
      : ['audit', '--before-sequence', '9', '--apply', '--backup', backupFile];
    await assert.rejects(main(args, {}), failure);
    assert.deepEqual(state.envelopes, ['original']);
    assert.deepEqual(state.auditRows, ['original']);
    assert.equal(state.compactCalls, 0); assert.equal(state.retireCalls, 0);
    assert.equal(state.closed, 1);
    assert.equal(fs.existsSync(backupFile), failAt?.cycle === 2);
  } finally {
    model?.restore(); storeModule.createPostgresDatabaseStore = originalCreate;
    if (originalCli) require.cache[cliPath] = originalCli; else delete require.cache[cliPath];
  }
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-directory-sync-'));
  try {
    // Exercise the production path with no filesystem override first. Unsupported
    // filesystems must reject before creating temporary or final backup files.
    const nativeFile = path.join(directory, 'native.ndjson');
    let nativeSupported = true;
    try { await exportBackupFile(emptyStore, nativeFile); }
    catch (error) {
      assert.ok(failure(error)); nativeSupported = false;
      assert.deepEqual(fs.readdirSync(directory), []);
    }
    if (nativeSupported) assert.equal((await verifyBackupFile(nativeFile)).valid, true);
    else for (const operation of ['checkpoints', 'audit']) await maintenanceGate(directory, operation);
    console.log(`native directory durability: ${nativeSupported ? 'supported and export verified' : 'unsupported; default export rejected before writing'}`);

    let model = modelDirectory(directory);
    try {
      const file = path.join(directory, 'ordered.ndjson');
      await exportBackupFile(emptyStore, file);
      assert.equal((await verifyBackupFile(file)).valid, true);
      assert.deepEqual(model.events.filter(event => !event.startsWith('unlink:')), [
        'directory.open.1', 'directory.sync.1', 'directory.close.1',
        'file.open', 'file.sync', 'file.close', 'file.link',
        'directory.open.2', 'directory.sync.2', 'directory.close.2',
      ]);
      const original = fs.readFileSync(file);
      await assert.rejects(exportBackupFile(emptyStore, file), { code: 'EEXIST' });
      assert.deepEqual(fs.readFileSync(file), original);
    } finally { model.restore(); }

    for (const cycle of [1, 2]) for (const stage of ['open', 'sync', 'close']) {
      model = modelDirectory(directory, { cycle, stage });
      const file = path.join(directory, `failed-${cycle}-${stage}.ndjson`);
      try {
        await assert.rejects(exportBackupFile(emptyStore, file), failure);
        assert.equal(fs.existsSync(file), cycle === 2, 'never delete a published backup after durability uncertainty');
        if (cycle === 2) assert.equal((await verifyBackupFile(file)).valid, true);
        assert.ok(!fs.readdirSync(directory).some(name => name.endsWith('.tmp')));
        if (stage === 'sync') assert.ok(model.events.includes(`directory.close.${cycle}`), 'close after failed sync');
        assert.ok(model.events.filter(event => event.startsWith('unlink:')).every(event => event.endsWith('.tmp')));
      } finally { model.restore(); }
    }

    // A successful publication remains pending until the *post-link* directory
    // sync resolves. A concurrent publisher must not replace that file.
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    model = modelDirectory(directory, null, gate);
    let first;
    try {
      const file = path.join(directory, 'concurrent.ndjson');
      let resolved = false;
      let earlyError;
      first = exportBackupFile(emptyStore, file).then(value => { resolved = true; return value; });
      first.catch(error => { earlyError = error; });
      const deadline = Date.now() + 2000;
      while (!model.events.includes('directory.sync.2') && !earlyError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
      if (earlyError) throw earlyError;
      assert.ok(model.events.includes('directory.sync.2'), 'publication must reach directory sync within the test bound');
      assert.equal(resolved, false); const original = fs.readFileSync(file);
      await assert.rejects(exportBackupFile(emptyStore, file), { code: 'EEXIST' });
      assert.deepEqual(fs.readFileSync(file), original);
      release(); await first; assert.equal(resolved, true);
    } finally { release(); await first?.catch(() => {}); model.restore(); }

    for (const operation of ['checkpoints', 'audit']) {
      for (const cycle of [1, 2]) for (const stage of ['open', 'sync', 'close']) {
        await maintenanceGate(directory, operation, { cycle, stage });
      }
    }
    console.log('backup directory durability passed: native policy; modeled preflight/publication open-sync-close faults, awaited publication, no overwrite and both maintenance gates');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
