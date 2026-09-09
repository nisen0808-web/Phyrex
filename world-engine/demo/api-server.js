'use strict';

const { DEFAULT_API_OPTIONS } = require('../core/api-server-engine');
const { createWorldApiServer } = require('../core/world-template-api-engine');
const { getRuntimeLoopSummary } = require('../core/runtime-loop-engine');
const { normalizeRuntimeAutosaveMode } = require('../core/runtime-autosave-engine');
const { loadDatabaseConfig } = require('../core/database-config-engine');
const { prepareDatabaseStartup, normalizeDatabaseStartupMode } = require('../core/database-startup-engine');

function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(helpText());
    return null;
  }
  const app = createApiServerFromArgs(args, env);
  const { server, api, options } = app;
  const { host, port } = options;
  server.once('error', error => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    const world = api.getWorld();
    const boundPort = server.address().port;
    console.log(JSON.stringify({
      ok: true,
      service: 'world-engine-api',
      host,
      port: boundPort,
      clientUrl: `http://${host}:${boundPort}/client`,
      worldId: world.id,
      tick: world.tick,
      requireAuth: Boolean(args.requireAuth),
      startup: app.startup,
      runtimeLoop: getRuntimeLoopSummary(api.runtimeLoop),
      endpoints: endpoints(),
    }, null, 2));
  });
  return app;
}

// Exposed for lifecycle tests. Recovery completes before a server can listen.
function createApiServerFromArgs(args = {}, env = process.env) {
  const port = integerOption(args.port ?? env.PORT, DEFAULT_API_OPTIONS.port, 0, 65535, 'port');
  const host = args.host || env.HOST || DEFAULT_API_OPTIONS.host;
  const seedTicks = integerOption(args.seedTicks, DEFAULT_API_OPTIONS.seedTicks, 0, Number.MAX_SAFE_INTEGER, 'seed-ticks');
  const savePath = args.savePath || DEFAULT_API_OPTIONS.defaultSavePath;
  const database = loadDatabaseConfig(buildDatabaseOptions(args, env), env);
  const runtimeLoop = buildRuntimeLoopOptions(args, { savePath }, env);
  runtimeLoop.autosaveDatabase = database;
  const recovered = prepareDatabaseStartup({ ...buildStartupOptions(args, env), database }, env);
  const app = createWorldApiServer(recovered.world, {
    port,
    host,
    seedTicks,
    defaultSavePath: savePath,
    database,
    requireAuth: Boolean(args.requireAuth),
    autoStartLoop: Boolean(args.autoLoop),
    runtimeLoop,
  });
  return {
    ...app,
    startup: {
      ...recovered.summary,
      worldId: app.api.getWorld().id,
      tick: app.api.getWorld().tick,
    },
  };
}

function buildStartupOptions(args = {}, env = process.env) {
  const worldId = args.resumeWorld ?? env.WORLD_ENGINE_DB_RESUME_WORLD ?? null;
  const mode = normalizeDatabaseStartupMode(args.resumeMode ?? env.WORLD_ENGINE_DB_RESUME_MODE ?? (worldId !== null ? 'required' : 'off'));
  return { mode, worldId };
}

function buildRuntimeLoopOptions(args = {}, context = {}, env = process.env) {
  const savePath = context.savePath || args.savePath || DEFAULT_API_OPTIONS.defaultSavePath;
  const autosaveMode = normalizeRuntimeAutosaveMode(args.autosaveMode || env.WORLD_ENGINE_AUTOSAVE_MODE || 'file');
  const autosaveEveryTicks = integerOption(args.autosaveEvery, 0, 0, Number.MAX_SAFE_INTEGER, 'autosave-every');
  return {
    intervalMs: integerOption(args.interval, 1000, 10, 2147483647, 'interval'),
    ticksPerCycle: integerOption(args.ticksPerCycle, 1, 1, Number.MAX_SAFE_INTEGER, 'ticks-per-cycle'),
    autosaveEveryTicks,
    autosavePath: args.autosavePath || (autosaveEveryTicks > 0 && autosaveMode === 'file' ? savePath : null),
    autosaveMode,
    autosaveDatabase: buildDatabaseOptions(args, env),
    immediate: Boolean(args.immediate),
    stopOnError: Boolean(args.stopOnError),
  };
}

function buildDatabaseOptions(args = {}, env = process.env) {
  return {
    provider: args.dbProvider || env.WORLD_ENGINE_DB_PROVIDER || undefined,
    directory: args.dbDir || env.WORLD_ENGINE_DB_DIR || undefined,
    name: args.dbName || env.WORLD_ENGINE_DB_NAME || undefined,
    autoCreate: args.dbAutoCreate ?? env.WORLD_ENGINE_DB_AUTO_CREATE,
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
    'GET /admin/database/events',
    'GET /admin/database/summary',
    'GET /admin/database/check',
    'GET /admin/templates',
    'POST /admin/templates/reset',
    'POST /save',
    'POST /load',
    'GET /saves',
  ];
}

function parseArgs(argv = []) {
  const values = {
    '--port': 'port', '--host': 'host', '--seed-ticks': 'seedTicks', '--save': 'savePath',
    '--interval': 'interval', '--ticks-per-cycle': 'ticksPerCycle', '--autosave-every': 'autosaveEvery',
    '--autosave-path': 'autosavePath', '--autosave-mode': 'autosaveMode', '--db-provider': 'dbProvider',
    '--db-dir': 'dbDir', '--db-name': 'dbName', '--db-auto-create': 'dbAutoCreate',
    '--resume-mode': 'resumeMode', '--resume-world': 'resumeWorld',
  };
  const flags = {
    '--auto-loop': 'autoLoop', '--immediate': 'immediate', '--stop-on-error': 'stopOnError',
    '--auth': 'requireAuth', '--help': 'help',
  };
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (Object.prototype.hasOwnProperty.call(flags, arg)) out[flags[arg]] = true;
    else if (Object.prototype.hasOwnProperty.call(values, arg)) {
      const value = argv[++i];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      out[values[arg]] = value;
    } else throw new Error(`Unknown API option ${arg}`);
  }
  return out;
}

function integerOption(value, fallback, min, max, name) {
  const number = value === undefined || value === null ? fallback : Number(value);
  if (value === '' || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`Invalid ${name}: expected integer from ${min} to ${max}`);
  }
  return number;
}

function helpText() {
  return [
    'Usage: node world-engine/demo/api-server.js [options]',
    '',
    'Options:',
    '  --host <host>              Default 127.0.0.1',
    '  --port <port>              Default 8790; 0 chooses a free port',
    '  --seed-ticks <n>           Initial demo ticks (not applied to restored worlds)',
    '  --save <file>              Default save/load path',
    '  --auto-loop                Start continuous world loop after listen',
    '  --interval <ms>            Runtime loop interval, minimum 10ms',
    '  --ticks-per-cycle <n>      World ticks per runtime cycle',
    '  --autosave-every <ticks>   Autosave interval; 0 disables autosave',
    '  --autosave-path <file>     Runtime-loop autosave path',
    '  --autosave-mode <mode>     file or database',
    '  --db-provider <provider>   Database provider, default jsonl',
    '  --db-dir <dir>             Database directory (relative to working directory)',
    '  --db-name <name>           Database name',
    '  --db-auto-create <bool>    Auto-create local database files',
    '  --resume-mode <mode>       off, if-present, or required (default off)',
    '  --resume-world <id>        World to restore; implies required unless mode supplied',
    '  --immediate                Run first loop cycle immediately',
    '  --stop-on-error            Stop loop after a cycle error',
    '  --auth                     Require session/role authorization',
  ].join('\n');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs, endpoints, buildRuntimeLoopOptions, buildDatabaseOptions, buildStartupOptions, createApiServerFromArgs };
