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
  const runtimeLoop = {
    intervalMs: Number(args.interval || 1000),
    ticksPerCycle: Number(args.ticksPerCycle || 1),
    autosaveEveryTicks: Number(args.autosaveEvery || 0),
    autosavePath: args.autosavePath || (Number(args.autosaveEvery || 0) > 0 ? savePath : null),
    immediate: Boolean(args.immediate),
    stopOnError: Boolean(args.stopOnError),
  };

  const { server, api } = createWorldApiServer(null, {
    port,
    host,
    seedTicks,
    defaultSavePath: savePath,
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

module.exports = { main, parseArgs, endpoints };
