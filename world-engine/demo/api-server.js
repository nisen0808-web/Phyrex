'use strict';

const { DEFAULT_API_OPTIONS } = require('../core/api-server-engine');
const { createWorldApiServer: createLocalWorldApiServer } = require('../core/world-template-api-engine');
const { createProductionWorldApiServer } = require('../core/production-api-engine');
const { resolveProductionConfig, redactProductionConfig } = require('../core/production-config-engine');
const { loadStartupWorld, createProductionLifecycle } = require('../core/production-lifecycle-engine');
const { getRuntimeLoopSummary } = require('../core/runtime-loop-engine');

function main() {
  const args = parseArgs(process.argv.slice(2));
  const productionConfig = resolveProductionConfig({
    args: {
      ...args,
      savePath: args.savePath || DEFAULT_API_OPTIONS.defaultSavePath,
    },
    env: process.env,
  });
  const port = productionConfig.port;
  const host = productionConfig.host;
  const seedTicks = Number(args.seedTicks || DEFAULT_API_OPTIONS.seedTicks);
  const autoStartLoop = Boolean(args.autoLoop);
  const runtimeLoop = {
    intervalMs: Number(args.interval || 1000),
    ticksPerCycle: Number(args.ticksPerCycle || 1),
    autosaveEveryTicks: Number(args.autosaveEvery || 0),
    autosavePath: args.autosavePath
      ? resolveProductionSavePath(args.autosavePath, productionConfig)
      : (Number(args.autosaveEvery || 0) > 0 ? productionConfig.defaultSavePath : null),
    immediate: Boolean(args.immediate),
    stopOnError: Boolean(args.stopOnError),
  };

  const startupWorld = productionConfig.enabled ? loadStartupWorld(productionConfig) : null;
  const createServer = productionConfig.enabled
    ? createProductionWorldApiServer
    : createLocalWorldApiServer;
  const { server, api } = createServer(startupWorld, {
    port,
    host,
    seedTicks,
    defaultSavePath: productionConfig.defaultSavePath,
    requireAuth: productionConfig.enabled || Boolean(args.requireAuth),
    autoStartLoop,
    runtimeLoop,
    productionConfig,
  });

  const lifecycle = productionConfig.enabled
    ? createProductionLifecycle({ server, api, config: productionConfig }).install()
    : null;

  server.listen(port, host, () => {
    const world = api.getWorld();
    console.log(JSON.stringify({
      ok: true,
      service: 'phyrex-world-engine',
      version: productionConfig.releaseVersion,
      production: productionConfig.enabled,
      host,
      port,
      clientUrl: `http://${host}:${port}/client`,
      worldId: world.id,
      tick: world.tick,
      requireAuth: productionConfig.enabled || Boolean(args.requireAuth),
      runtimeLoop: getRuntimeLoopSummary(api.runtimeLoop),
      config: productionConfig.enabled ? redactProductionConfig(productionConfig) : undefined,
      endpoints: endpoints(productionConfig.enabled),
    }, null, 2));
  });

  return { server, api, lifecycle, productionConfig };
}

function resolveProductionSavePath(requested, config) {
  const { resolveManagedPath } = require('../core/production-config-engine');
  return config.enabled
    ? resolveManagedPath(config.dataDir, requested, { extension: '.json' })
    : requested;
}

function endpoints(production = false) {
  const base = [
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
    'GET /admin/templates',
    'POST /admin/templates/reset',
    'POST /save',
    'POST /load',
    'GET /saves',
  ];
  if (!production) return base;
  return [
    'GET /livez',
    'GET /readyz',
    'GET /version',
    'GET /metrics',
    'GET /admin/config',
    'GET /admin/maintenance',
    'POST /admin/maintenance',
    'GET /admin/backups',
    'POST /admin/backups',
    'POST /admin/backups/restore',
    ...base,
  ];
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') out.port = argv[++index];
    else if (arg === '--host') out.host = argv[++index];
    else if (arg === '--seed-ticks') out.seedTicks = argv[++index];
    else if (arg === '--save') out.savePath = argv[++index];
    else if (arg === '--auto-loop') out.autoLoop = true;
    else if (arg === '--interval') out.interval = argv[++index];
    else if (arg === '--ticks-per-cycle') out.ticksPerCycle = argv[++index];
    else if (arg === '--autosave-every') out.autosaveEvery = argv[++index];
    else if (arg === '--autosave-path') out.autosavePath = argv[++index];
    else if (arg === '--immediate') out.immediate = true;
    else if (arg === '--stop-on-error') out.stopOnError = true;
    else if (arg === '--auth') out.requireAuth = true;
    else if (arg === '--production') out.production = true;
    else if (arg === '--operator-token') out.operatorToken = argv[++index];
    else if (arg === '--operator-account') out.operatorAccountId = argv[++index];
    else if (arg === '--data-dir') out.dataDir = argv[++index];
    else if (arg === '--load-on-start') out.loadOnStart = argv[++index];
    else if (arg === '--shutdown-save') out.shutdownSave = argv[++index];
    else if (arg === '--shutdown-timeout') out.shutdownTimeoutMs = argv[++index];
    else if (arg === '--cors-origins') out.corsOrigins = argv[++index];
    else if (arg === '--rate-limit') out.rateLimitMax = argv[++index];
    else if (arg === '--auth-rate-limit') out.authRateLimitMax = argv[++index];
    else if (arg === '--metrics-public') out.metricsPublic = true;
    else if (arg === '--maintenance') out.maintenanceAtStart = true;
    else if (arg === '--release-version') out.releaseVersion = argv[++index];
    else if (arg === '--release-sha') out.releaseSha = argv[++index];
    else if (arg === '--help') {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp() {
  console.log([
    'Usage: node world-engine/demo/api-server.js [options]',
    '',
    'Core options:',
    '  --host <host>              Default 127.0.0.1; production default 0.0.0.0',
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
    '',
    'Production options:',
    '  --production              Enable production security and lifecycle',
    '  --operator-token <token>  Required; minimum 32 characters',
    '  --operator-account <id>   Bootstrap admin account ID',
    '  --data-dir <dir>          Managed save/backup directory',
    '  --load-on-start <file>    Restore a managed save before listening',
    '  --shutdown-save <file>    Save target during graceful shutdown',
    '  --shutdown-timeout <ms>   Maximum server close wait',
    '  --cors-origins <csv>      Explicit allowed HTTP origins',
    '  --rate-limit <n>          Requests per minute per client',
    '  --auth-rate-limit <n>     Account/session requests per minute',
    '  --metrics-public          Allow unauthenticated /metrics',
    '  --maintenance             Start in maintenance mode',
    '  --release-version <v>     Version exposed by /version and metrics',
    '  --release-sha <sha>       Build SHA exposed by /version and metrics',
  ].join('\n'));
}

if (require.main === module) main();

module.exports = { main, parseArgs, endpoints, printHelp };
