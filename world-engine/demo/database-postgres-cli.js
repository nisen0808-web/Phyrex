'use strict';
const fs = require('fs');
const path = require('path');
const { createPostgresDatabaseStore } = require('../core/postgres-database-engine');
const { loadWorld } = require('../core/persistence-engine');
const { integer, databaseError } = require('../storage/postgres/config');
function parseArgs(argv = []) {
  const args = { command: argv[0] || 'help' };
  const allowed = { '--schema': 'schema', '--input': 'input', '--output': 'output', '--world-id': 'worldId',
    '--request-id': 'requestId', '--expected-revision': 'expectedRevision', '--limit': 'limit' };
  if (!['help','--help','migrate','status','import','export','events'].includes(args.command)) throw databaseError('INVALID_INPUT', 'Unknown database command');
  for (let index = 1; index < argv.length; index += 1) {
    const key = allowed[argv[index]];
    if (!key || !argv[index + 1] || argv[index + 1].startsWith('--')) throw databaseError('INVALID_INPUT', 'Invalid database command option');
    args[key] = argv[++index];
  }
  return args;
}
async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (['help','--help'].includes(args.command)) {
    console.log('Usage: npm run database:postgres -- <migrate|status|import|export|events> [options]\n'
      + 'Connection: WORLD_ENGINE_DATABASE_URL; do not put passwords in command-line arguments.\n'
      + 'Options: --schema <name> --world-id <id> --input <file> --output <new-file>\n'
      + 'Import requires --expected-revision <n> --request-id <unique-id>. Events accept --limit <1..1000>.');
    return null;
  }
  const store = createPostgresDatabaseStore({ schema: args.schema, env });
  try {
    let result;
    if (args.command === 'migrate') result = await store.migrate();
    if (args.command === 'status') result = await store.summary();
    if (args.command === 'import') {
      if (!args.input || args.expectedRevision === undefined || !args.requestId) throw databaseError('INVALID_INPUT', 'Import requires input, expected revision and request ID');
      const saved = loadWorld(args.input);
      if (args.worldId && saved.world.id !== args.worldId) throw databaseError('INVALID_INPUT', 'Import world ID does not match input');
      result = await store.saveWorld(saved.world, { expectedRevision: integer(args.expectedRevision, 0, 0, Number.MAX_SAFE_INTEGER, 'expected revision'),
        requestId: args.requestId, reason: 'postgres_cli_import', metadata: saved.metadata });
    }
    if (args.command === 'export') {
      if (!args.output) throw databaseError('INVALID_INPUT', 'Export requires a new output file');
      const saved = await store.loadWorld(args.worldId ?? null);
      if (!saved) throw databaseError('MISSING_WORLD', 'No matching world checkpoint');
      const file = path.resolve(args.output);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Inspection/export must not overwrite existing saves.
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: saved.schemaVersion, savedAt: saved.savedAt,
        worldId: saved.worldId, tick: saved.tick, metadata: saved.metadata, world: saved.world }, null, 2),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      result = { worldId: saved.worldId, tick: saved.tick, revision: saved.revision, output: file };
    }
    if (args.command === 'events') result = await store.listEvents({ ...(args.worldId ? { worldId: args.worldId } : {}),
      limit: integer(args.limit, 100, 1, 1000, 'event limit') });
    console.log(JSON.stringify({ ok: true, data: result }, null, 2));
    return result;
  } finally { await store.close(); }
}
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error.code || 'DATABASE_COMMAND_FAILED',
    message: String(error.code || '').startsWith('WORLD_DB_') ? error.message : 'Database command failed' }));
  process.exitCode = 1;
});
module.exports = { main, parseArgs };
