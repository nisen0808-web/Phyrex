'use strict';

const { createDurableCommandApiServer } = require('../core/durable-command-api-engine');
const { wallClockNow } = require('../platform/runtime-clock');

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (!args) return null;
  const host = args.host || env.HOST || '127.0.0.1';
  const port = boundedPort(args.port || env.PORT || 8791);
  const apiOptions = { env, rateLimitNow: wallClockNow };
  if (args.maxBodyBytes !== undefined) apiOptions.maxBodyBytes = Number(args.maxBodyBytes);
  copyNumericEnv(apiOptions, env, 'sourceRateLimit', 'WORLD_ENGINE_COMMAND_API_SOURCE_RATE_LIMIT');
  copyNumericEnv(apiOptions, env, 'accountSubmitRateLimit', 'WORLD_ENGINE_COMMAND_API_ACCOUNT_SUBMIT_RATE_LIMIT');
  copyNumericEnv(apiOptions, env, 'accountReadRateLimit', 'WORLD_ENGINE_COMMAND_API_ACCOUNT_READ_RATE_LIMIT');
  copyNumericEnv(apiOptions, env, 'rateLimitWindowMs', 'WORLD_ENGINE_COMMAND_API_RATE_LIMIT_WINDOW_MS');
  copyNumericEnv(apiOptions, env, 'maxTrackedSources', 'WORLD_ENGINE_COMMAND_API_MAX_TRACKED_SOURCES');
  copyNumericEnv(apiOptions, env, 'maxTrackedAccounts', 'WORLD_ENGINE_COMMAND_API_MAX_TRACKED_ACCOUNTS');
  const api = await createDurableCommandApiServer(apiOptions);
  let stopping = false;
  const shutdown = async signal => {
    if (stopping) return;
    stopping = true;
    try {
      await api.close();
      console.log(JSON.stringify({ ok: true, service: 'durable-command-api', stopped: signal }));
      process.exitCode = 0;
    } catch (error) {
      console.error(JSON.stringify({ ok: false, service: 'durable-command-api', error: safeErrorCode(error) }));
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => { shutdown('SIGINT'); });
  process.once('SIGTERM', () => { shutdown('SIGTERM'); });
  await new Promise((resolve, reject) => {
    api.server.once('error', reject);
    api.server.listen(port, host, () => {
      api.server.removeListener('error', reject);
      resolve();
    });
  });
  console.log(JSON.stringify({
    ok: true,
    service: 'durable-command-api',
    host,
    port,
    endpoints: [
      'POST /durable/worlds/:worldId/players/:playerId/commands',
      'GET /durable/worlds/:worldId/commands/:commandId',
    ],
  }, null, 2));
  return api;
}

function parseArgs(argv = []) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--host') out.host = argv[++index];
    else if (arg === '--port') out.port = argv[++index];
    else if (arg === '--max-body-bytes') out.maxBodyBytes = argv[++index];
    else if (arg === '--help') {
      console.log([
        'Usage: node world-engine/demo/durable-command-api-server.js [options]',
        '',
        'Options:',
        '  --host <host>              Bind host, default 127.0.0.1',
        '  --port <port>              Bind port, default 8791',
        '  --max-body-bytes <bytes>   JSON command body limit',
        '',
        'Rate limits are configured with WORLD_ENGINE_COMMAND_API_* environment variables.',
        'PostgreSQL connection and TLS settings are read from WORLD_ENGINE_* environment variables.',
      ].join('\n'));
      return null;
    } else throw new Error(`Unknown argument ${arg}`);
  }
  return out;
}

function copyNumericEnv(target, env, key, envName) {
  if (env[envName] === undefined || env[envName] === '') return target;
  const value = Number(env[envName]);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${envName}`);
  target[key] = value;
  return target;
}

function boundedPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  return port;
}

function safeErrorCode(error) {
  const code = String(error?.code || '');
  return /^(WORLD_DB|WORLD_RUNTIME)_[A-Z_]+$/.test(code) ? code : 'COMMAND_API_FAILED';
}

if (require.main === module) {
  main().catch(error => {
    console.error(JSON.stringify({ ok: false, service: 'durable-command-api', error: safeErrorCode(error) }));
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, copyNumericEnv, boundedPort, safeErrorCode };
