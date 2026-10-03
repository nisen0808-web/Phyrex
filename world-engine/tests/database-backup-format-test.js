'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { header, TABLES, SEQUENCED, exportBackupFile, readBackupFile, verifyBackupFile } = require('../storage/postgres/backup');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-backup-format-'));
  const counts = Object.fromEntries(Object.keys(TABLES).map(table => [table, table === 'worlds' ? 1 : 0]));
  const records = [header(), { type: 'row', table: 'worlds', values: {
    world_id: '中文世界😀', revision: 0, latest_sequence: null, updated_at: '2026-10-02T00:00:00.123456+00:00' } },
  { type: 'sequences', values: Object.fromEntries(SEQUENCED.map(table => [table, { lastValue: '1', isCalled: false }])) }];
  const fake = { exportSnapshot: async write => { for (const record of records) await write(record); return { counts }; } };
  try {
    const file = path.join(directory, 'world.ndjson');
    const result = await exportBackupFile(fake, file);
    assert.strictEqual((await verifyBackupFile(file)).checksum, result.checksum);
    const read = []; for await (const record of readBackupFile(file)) read.push(record);
    assert.deepStrictEqual(read.slice(0, -1), records);
    const original = fs.readFileSync(file);
    await assert.rejects(exportBackupFile(fake, file), error => error.code === 'EEXIST');
    assert.deepStrictEqual(fs.readFileSync(file), original, 'existing backup is preserved');
    for (const [name, bytes] of [
      ['truncated', original.subarray(0, original.length - 2)],
      ['tampered', Buffer.from(original.toString().replace('中文世界', '被改世界'))],
      ['trailing', Buffer.concat([original, Buffer.from('{}\n')])],
      ['bad-utf8', Buffer.concat([Buffer.from([0xff]), original])],
      ['duplicate-header', Buffer.concat([Buffer.from(JSON.stringify(header()) + '\n'), original])],
    ]) {
      const bad = path.join(directory, name); fs.writeFileSync(bad, bytes);
      await assert.rejects(verifyBackupFile(bad), error => error.code === 'WORLD_DB_INVALID_BACKUP', name);
    }
    const large = path.join(directory, 'large');
    await assert.rejects(exportBackupFile({ exportSnapshot: async write => {
      await write(header()); await write({ type: 'row', value: 'x'.repeat(2000) }); return { counts };
    } }, large, { maxLineBytes: 1024 }), error => error.code === 'WORLD_DB_BACKUP_RECORD_TOO_LARGE');
    assert.ok(!fs.existsSync(large));
    await assert.rejects(exportBackupFile({ exportSnapshot: async write => {
      await write(header()); throw new Error('injected source failure');
    } }, path.join(directory, 'failed')));
    assert.ok(!fs.readdirSync(directory).some(name => name.endsWith('.tmp')));
    console.log('database backup format passed: UTF-8, checksums, truncation, no overwrite, bounded lines and failed-write cleanup');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
