'use strict';
const { createPostgresDatabaseStore } = require('../storage/postgres/store');
const { exportBackupFile, readBackupFile, verifyBackupFile } = require('../storage/postgres/backup');

async function main(argv = process.argv.slice(2), env = process.env) {
  const [operation, file, ...rest] = argv;
  if (operation === '--help') {
    console.log('Usage: database-backup-cli.js <export|verify|restore> <file>\nDatabase connection/schema use WORLD_ENGINE_* environment variables. Restore requires an empty migrated schema. Existing files are never overwritten.');
    return;
  }
  if (!['export', 'verify', 'restore'].includes(operation) || !file || rest.length) throw new Error('Invalid backup arguments');
  if (operation === 'verify') return verifyBackupFile(file);
  // Verify before touching a database, and again while importing in one SQL transaction.
  if (operation === 'restore') await verifyBackupFile(file);
  const store = createPostgresDatabaseStore({ env });
  try {
    return operation === 'export' ? await exportBackupFile(store, file)
      : await store.restoreSnapshot(readBackupFile(file));
  } finally { await store.close(); }
}
if (require.main === module) main().then(result => {
  if (result) console.log(JSON.stringify({ ok: true, ...result }));
}).catch(error => {
  const code = /^WORLD_DB_[A-Z_]+$/.test(error?.code || '') ? error.code : 'DATABASE_BACKUP_FAILED';
  console.error(JSON.stringify({ ok: false, error: code })); process.exitCode = 1;
});
module.exports = { main };
