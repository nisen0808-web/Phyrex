'use strict';

const { createWorldApiServer, DEFAULT_API_OPTIONS } = require('../core/api-server-engine');

function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port || process.env.PORT || DEFAULT_API_OPTIONS.port);
  const host = args.host || process.env.HOST || DEFAULT_API_OPTIONS.host;
  const seedTicks = Number(args.seedTicks || DEFAULT_API_OPTIONS.seedTicks);
  const { server, api } = createWorldApiServer(null, { port, host, seedTicks, defaultSavePath: args.savePath || DEFAULT_API_OPTIONS.defaultSavePath });
  server.listen(port, host, () => {
    const world = api.getWorld();
    console.log(JSON.stringify({ ok: true, service: 'world-engine-api', host, port, worldId: world.id, tick: world.tick, endpoints: endpoints() }, null, 2));
  });
}

function endpoints() {
  return [
    'GET /health',
    'GET /world',
    'GET /snapshot',
    'GET /stream',
    'GET /players/:playerId',
    'POST /players',
    'POST /commands',
    'POST /offline',
    'GET /offline/:playerId',
    'POST /tick',
    'POST /runtime/run',
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
    else if (arg === '--help') {
      console.log([
        'Usage: node world-engine/demo/api-server.js [options]',
        '',
        'Options:',
        '  --host <host>        Default 127.0.0.1',
        '  --port <port>        Default 8790',
        '  --seed-ticks <n>     Demo world seed ticks before server starts',
        '  --save <file>        Default save/load path',
      ].join('\n'));
      process.exit(0);
    }
  }
  return out;
}

if (require.main === module) main();

module.exports = { main, parseArgs, endpoints };
