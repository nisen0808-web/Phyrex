'use strict';

const { setTimeout: delay } = require('timers/promises');
const { createDurableWorldRuntime } = require('../core/durable-runtime-engine');
const { integer } = require('../storage/postgres/config');

function parseArgs(argv = []) {
  const args = {};
  const names = { '--world-id': 'worldId', '--schema': 'schema', '--ticks-per-batch': 'ticksPerBatch',
    '--batches': 'batches', '--interval': 'intervalMs', '--retry-delay': 'retryDelayMs', '--max-attempts': 'maxCommitAttempts' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--continuous') args.continuous = true;
    else if (arg === '--help') args.help = true;
    else if (names[arg] && argv[index + 1] && !argv[index + 1].startsWith('--')) args[names[arg]] = argv[++index];
    else throw new Error('Invalid durable runtime option');
  }
  if (args.continuous && args.batches !== undefined) throw new Error('Choose batches or continuous mode');
  return args;
}
async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Usage: npm run runtime:postgres -- --world-id <saved-world> [--batches <n> | --continuous]\n'
      + 'Options: --schema <name> --ticks-per-batch <1..100> --interval <ms> --retry-delay <ms> --max-attempts <n>\n'
      + 'Requires an existing migrated PostgreSQL store and checkpoint; no automatic new-world creation.\n'
      + 'Connection and credentials: WORLD_ENGINE_DATABASE_URL only; never put passwords in CLI arguments.');
    return null;
  }
  const batches = integer(args.batches, 1, 1, 1000000, 'batch count');
  const intervalMs = integer(args.intervalMs, 1000, 10, 3600000, 'interval');
  const retryDelayMs = integer(args.retryDelayMs, 250, 10, 60000, 'retry delay');
  const controller = new AbortController();
  let stopping = false, runtime;
  const stop = () => { stopping = true; controller.abort(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    runtime = await createDurableWorldRuntime({ worldId: args.worldId ?? env.WORLD_ENGINE_WORLD_ID,
      database: { schema: args.schema }, env, ticksPerBatch: args.ticksPerBatch,
      intervalMs, retryDelayMs, maxCommitAttempts: args.maxCommitAttempts,
      onCommit: result => console.log(JSON.stringify({ type: 'committed', ...result })),
    });
    console.log(JSON.stringify({ type: 'ready', ...runtime.summary() }));
    let completed = 0;
    while (!stopping && (args.continuous || completed < batches)) {
      try { await runtime.step(); completed += 1; }
      catch (_) {
        const status = runtime.summary();
        console.error(JSON.stringify({ type: 'commit_error', error: status.lastError, pending: status.pending }));
        if (status.status === 'blocked') throw new Error('Runtime requires recovery');
      }
      if (!stopping && (args.continuous || completed < batches)) {
        const pending = runtime.summary().pending;
        const wait = pending ? Math.min(10000, retryDelayMs * (2 ** Math.min(pending.attempts - 1, 20))) : intervalMs;
        await delay(wait, undefined, { signal: controller.signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
      }
    }
    const result = await runtime.close();
    console.log(JSON.stringify({ type: 'stopped', ...result }));
    return result;
  } finally {
    try { if (runtime) await runtime.close(); }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  }
}
if (require.main === module) main().catch(error => {
  const code = /^(WORLD_DB|WORLD_RUNTIME)_[A-Z_]+$/.test(String(error.code)) ? error.code : 'WORLD_RUNTIME_COMMAND_FAILED';
  console.error(JSON.stringify({ ok: false, error: code })); process.exitCode = 1;
});
module.exports = { main, parseArgs };
