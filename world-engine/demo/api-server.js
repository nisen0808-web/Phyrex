'use strict';

const { DEFAULT_API_OPTIONS } = require('../core/api-server-engine');
const { createWorldApiServer } = require('../core/world-template-api-engine');
const { getRuntimeLoopSummary } = require('../core/runtime-loop-engine');

function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port || process.env.PORT || DEFAULT_API_OPTIONS.port);
  const host = args.host || process.env.HOST || DEFAULT_API_OPTIONS.host;
  const seedTicks = Number(args.seedTicks || DEFAULT_API_OPTIONS.seedTicks);
  const savePath = args.savePath || DEFAULT_API_OPTIONS.defaultSavePath;
  const autoStartLoop = Boolean(args.autoLoop);
  const runtimeLoop = buildRuntimeLoopOptions(args, { savePath });

  const { server, api } = createWorldApiServer(null, {
    port,
    host,
    seedTicks,
    defaultSavePath: savePath,
    database: buildDatabaseOptions(args),
    requireAuth: Boolean(args.requireAuth),
    autoStartLoop,
    runtimeLoop,
  });

  server.listen(port, host, () => {
    const world = api.getWorld();
    console.log(JSON.stringify({
      ok: true,
      service: 'world-engine-api',
      host,
      port,
      clientUrl: `http://${host}:${port}/client`,
      worldId: world.id,
      tick: world.tick,
      requireAuth: Boolean(args.requireAuth),
      runtimeLoop: getRuntimeLoopSummary(api.runtimeLoop),
      endpoints: endpoints(),
    }, null, 2));
  });
}

function buildRuntimeLoopOptions(args = {}, context = {}) {
  const savePath = context.savePath || args.savePath || DEFAULT_API_OPTIONS.defaultSavePath;
  const autosaveMode = args.autosaveMode || process.env.WORLD_ENGINE_AUTOSAVE_MODE || 'file';
  const autosaveEveryTicks = Number(args.autosaveEvery || 0);
  return {
    intervalMs: Number(args.interval || 1000),
    ticksPerCycle: Number(args.ticksPerCycle || 1),
    autosaveEveryTicks,
    autosavePath: args.autosavePath || (autosaveEveryTicks > 0 && autosaveMode === 'file' ? savePath : null),
    autosaveMode,
    autosaveDatabase: buildDatabaseOptions(args),
    immediate: Boolean(args.immediate),
    stopOnError: Boolean(args.stopOnError),
  };
}

function buildDatabaseOptions(args = {}) {
  return {
    provider: args.dbProvider || process.env.WORLD_ENGINE_DB_PROVIDER || undefined,
    directory: args.dbDir || process.env.WORLD_ENGINE_DB_DIR || undefined,
    name: args.dbName || process.env.WORLD_ENGINE_DB_NAME || undefined,
    autoCreate: args.dbAutoCreate ?? process.env.WORLD_ENGINE_DB_AUTO_CREATE,
  };
}

function endpoints() {
  return [
    'GET /client',
    'GET /health',
    'GET /world',
    'GET /snapshot',
    'GET /stream',
    'WS  /ws/ticks',
    'POST /accounts',
    'POST /sessions',
    'GET /session',
    'GET /players/:playerId',
    'GET /players/:playerId/dashboard',
    'POST /players/:playerId/actions',
    'POST /offline',
    'GET /offline/:playerId',
    'POST /tick',
    'POST /runtime/run',
    'GET /admin/loop',
    'POST /admin/loop/start',
    'POST /admin/loop/pause',
    'POST /admin/loop/stop',
    'POST /admin/loop/config',
    'POST /admin/loop/step',
    'GET /admin/database',
    'GET /admin/templates',
    'POST /admin/templates/reset',
    'POST /save',
    'POST /load',
    'GET /saves',
  ];
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') out.port = argv[++i];
    else if (arg === '--host') out.host = argv[++i];
    else if (arg === '--seed-ticks') out.seedTicks = argv[++i];
    else if (arg === '--save') out.savePath = argv[++i];
    else if (arg === '--auto-loop') out.autoLoop = true;
    else if (arg === '--interval') out.interval = argv[++i];
    else if (arg === '--ticks-per-cycle') out.ticksPerCycle = argv[++i];
    else if (arg === '--autosave-every') out.autosaveEvery = argv[++i];
    else if (arg === '--autosave-path') out.autosavePath = argv[++i];
    else if (arg === '--autosave-mode') out.autosaveMode = argv[++i];
    else if (arg === '--db-provider') out.dbProvider = argv[++i];
    else if (arg === '--db-dir') out.dbDir = argv[++i];
    else if (arg === '--db-name') out.dbName = argv[++i];
    else if (arg === '--db-auto-create') out.dbAutoCreate = argv[++i];
    else if (arg === '--immediate') out.immediate = true;
    else if (arg === '--stop-on-error') out.stopOnError = true;
    else if (arg === '--auth') out.requireAuth = true;
    else if (arg === '--help') {
      console.log([
        'Usage: node world-engine/demo/api-server.js [options]',
        '',
        'Options:',
        '  --host <host>              Default 127.0.0.1',
        '  --port <port>              Default 8790',
        '  --seed-ticks <n>           Demo world seed ticks before server starts',
        '  --save <file>              Default save/load path',
        '  --auto-loop                Start continuous world loop after listen',
        '  --interval <ms>            Runtime loop interval, minimum 10ms',
        '  --ticks-per-cycle <n>      World ticks per runtime cycle',
        '  --autosave-every <ticks>   Autosave after this many world ticks',
        '  --autosave-path <file>     Runtime-loop autosave path',
        '  --autosave-mode <mode>     file or database',
        '  --db-provider <provider>   Database provider, default jsonl',
        '  --db-dir <dir>             Database directory',
        '  --db-name <name>           Database name',
        '  --db-auto-create <bool>    Auto-create local database files',
        '  --immediate                Run first loop cycle immediately',
        '  --stop-on-error            Stop loop after a cycle error',
        '  --auth                     Require session/role authorization',
      ].join('\n'));
      process.exit(0);
    }
  }
  return out;
}

if (require.main === module) main();

module.exports = { main, parseArgs, endpoints, buildRuntimeLoopOptions, buildDatabaseOptions };
