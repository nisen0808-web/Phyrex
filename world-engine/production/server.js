'use strict';

const {
  loadProductionConfig,
  redactProductionConfig,
} = require('../core/production-config-engine');
const {
  createProductionWorldService,
  installProductionSignalHandlers,
} = require('../core/production-server-engine');

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return null;
  }

  const config = loadProductionConfig(env, commandLineOverrides(args));
  if (args.checkConfig) {
    console.log(JSON.stringify({ ok: true, config: redactProductionConfig(config) }, null, 2));
    return null;
  }

  const service = createProductionWorldService(config);
  installProductionSignalHandlers(service);
  const status = await service.start();
  console.log(JSON.stringify({
    level: 'info',
    event: 'production_ready',
    status,
    clientUrl: publicClientUrl(config),
    probes: {
      live: '/livez',
      ready: '/readyz',
      metrics: '/metrics',
    },
  }));
  return service;
}

function parseArgs(argv = []) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--host') output.host = argv[++index];
    else if (value === '--port') output.port = argv[++index];
    else if (value === '--data-dir') output.dataDirectory = argv[++index];
    else if (value === '--save') output.savePath = argv[++index];
    else if (value === '--backup-dir') output.backupDirectory = argv[++index];
    else if (value === '--no-loop') output.autoStartLoop = false;
    else if (value === '--no-load') output.loadOnStart = false;
    else if (value === '--allow-registration') output.allowRegistration = true;
    else if (value === '--metrics-public') output.metricsPublic = true;
    else if (value === '--pretty') output.logFormat = 'pretty';
    else if (value === '--check-config') output.checkConfig = true;
    else if (value === '--help' || value === '-h') output.help = true;
    else throw new Error(`unknown_argument:${value}`);
  }
  return output;
}

function commandLineOverrides(args = {}) {
  const output = {};
  for (const key of [
    'host',
    'dataDirectory',
    'savePath',
    'backupDirectory',
    'autoStartLoop',
    'loadOnStart',
    'allowRegistration',
    'metricsPublic',
    'logFormat',
  ]) {
    if (args[key] !== undefined) output[key] = args[key];
  }
  if (args.port !== undefined) output.port = Number(args.port);
  return output;
}

function publicClientUrl(config) {
  const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
  return `http://${host}:${config.port}/client`;
}

function printHelp() {
  console.log([
    'World Engine production server',
    '',
    'Required environment:',
    '  WORLD_ADMIN_PASSWORD          Bootstrap/rotate the administrator password',
    '',
    'Options:',
    '  --host <host>                 Override HOST / WORLD_HOST',
    '  --port <port>                 Override PORT / WORLD_PORT',
    '  --data-dir <directory>        Persistent data directory',
    '  --save <file>                 Primary world save file',
    '  --backup-dir <directory>      Operational archive directory',
    '  --no-loop                     Do not start the runtime loop',
    '  --no-load                     Do not load the primary save at startup',
    '  --allow-registration          Allow public player registration',
    '  --metrics-public              Expose /metrics without admin auth',
    '  --pretty                      Human-readable logs instead of JSON',
    '  --check-config                Validate and print redacted configuration',
    '  --help                        Show this help',
  ].join('\n'));
}

if (require.main === module) {
  main().catch(error => {
    console.error(JSON.stringify({
      level: 'fatal',
      event: 'production_start_failed',
      error: error.message || String(error),
      stack: error.stack || null,
    }));
    process.exit(1);
  });
}

module.exports = {
  main,
  parseArgs,
  commandLineOverrides,
  publicClientUrl,
  printHelp,
};
