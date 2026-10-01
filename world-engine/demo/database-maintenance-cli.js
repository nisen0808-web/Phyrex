'use strict';
const { createPostgresDatabaseStore } = require('../storage/postgres/store');
const { createPostgresCommandApiAuditStore } = require('../storage/postgres/command-api-audit-store');
const { exportBackupFile } = require('../storage/postgres/backup');
const { databaseError } = require('../storage/postgres/config');

function parseArguments(argv) {
  const [operation, ...args] = argv;
  if (!['checkpoints', 'audit'].includes(operation)) throw databaseError('INVALID_INPUT', 'Select checkpoints or audit');
  const allowed = operation === 'checkpoints'
    ? ['world-id', 'keep', 'limit', 'expected-revision', 'backup', 'apply']
    : ['world-id', 'before-sequence', 'limit', 'backup', 'apply'];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i].slice(2);
    if (!args[i].startsWith('--') || !allowed.includes(key) || Object.hasOwn(options, key)) throw databaseError('INVALID_INPUT', 'Invalid maintenance option');
    const value = key === 'apply' ? true : args[++i];
    if (value === undefined || value === '' || (typeof value === 'string' && value.startsWith('--'))) throw databaseError('INVALID_INPUT', 'Missing option value');
    options[key] = value;
  }
  for (const [key, max] of [['keep', 1000000], ['limit', 1000], ['expected-revision', Number.MAX_SAFE_INTEGER], ['before-sequence', Number.MAX_SAFE_INTEGER]]) {
    if (options[key] === undefined) continue;
    if (!/^[1-9][0-9]*$/.test(options[key]) || !Number.isSafeInteger(Number(options[key])) || Number(options[key]) > max) throw databaseError('INVALID_INPUT', 'Invalid numeric option');
    options[key] = Number(options[key]);
  }
  if (operation === 'checkpoints' && !options['world-id']) throw databaseError('INVALID_INPUT', 'Checkpoint maintenance requires world-id');
  if (operation === 'audit' && !options['before-sequence']) throw databaseError('INVALID_INPUT', 'Audit maintenance requires before-sequence');
  if (options.apply && (!options.backup || (operation === 'checkpoints' && !options['expected-revision']))) throw databaseError('INVALID_INPUT', 'Apply requires a new backup file and checkpoint expected-revision');
  if (!options.apply && options.backup) throw databaseError('INVALID_INPUT', 'Backup is used only with apply');
  return { operation, options };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Usage: database-maintenance-cli.js checkpoints --world-id ID [--keep 20] [--limit 100] [--expected-revision N] [--apply --backup NEW_FILE]\n       database-maintenance-cli.js audit --before-sequence N [--world-id ID] [--limit 100] [--apply --backup NEW_FILE]\nDefault: preview only. Apply writes a complete backup first. Connection/schema use WORLD_ENGINE_* environment variables.');
    return;
  }
  const { operation, options } = parseArguments(argv);
  const store = createPostgresDatabaseStore({ env });
  let audit;
  try {
    const worldId = options['world-id'];
    const maxRecords = options.limit ?? 100;
    if (!options.apply) {
      if (operation === 'checkpoints') return await store.compactCheckpoints(worldId, { keep: options.keep, maxRecords, expectedRevision: options['expected-revision'] });
      audit = createPostgresCommandApiAuditStore({ env });
      const rows = await audit.list({ ...(worldId ? { worldId } : {}), beforeSequence: options['before-sequence'], limit: maxRecords, order: 'asc' });
      return { applied: false, eligibleInBatch: rows.length, firstSequence: rows[0]?.sequence ?? null, lastSequence: rows.at(-1)?.sequence ?? null };
    }
    const candidates = [];
    let backupRevision = null;
    const backup = await exportBackupFile({ exportSnapshot: write => store.exportSnapshot(async record => {
      await write(record);
      if (record.type !== 'row') return;
      if (record.table === 'worlds' && record.values.world_id === worldId) backupRevision = Number(record.values.revision);
      // Select exact rows from the consistent backup, never a DELETE range:
      // a transaction may commit a lower sequence after the snapshot started.
      if (operation === 'audit' && record.table === 'command_api_audit' && candidates.length < maxRecords
          && record.values.sequence < options['before-sequence'] && (!worldId || record.values.world_id === worldId)) candidates.push(record.values);
    }) }, options.backup);
    if (operation === 'checkpoints' && backupRevision !== options['expected-revision']) throw databaseError('REVISION_CONFLICT', 'Backup revision does not match expected-revision');
    const result = operation === 'checkpoints'
      ? await store.compactCheckpoints(worldId, { keep: options.keep, maxRecords, apply: true, expectedRevision: options['expected-revision'] })
      : { applied: true, ...(await store.retireAuditRecords(candidates)) };
    return { ...result, backup: { file: backup.file, checksum: backup.checksum } };
  } finally { if (audit) await audit.close(); await store.close(); }
}
if (require.main === module) main().then(result => {
  if (result) console.log(JSON.stringify({ ok: true, ...result }));
}).catch(error => {
  const code = /^WORLD_DB_[A-Z_]+$/.test(error?.code || '') ? error.code : 'DATABASE_MAINTENANCE_FAILED';
  console.error(JSON.stringify({ ok: false, error: code })); process.exitCode = 1;
});
module.exports = { main, parseArguments };
