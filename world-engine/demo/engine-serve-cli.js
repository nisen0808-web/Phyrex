'use strict';
const { createEngineService } = require('../service/engine-service');
const { commandApiOptions } = require('./durable-command-api-server');
const { serviceError } = require('../service/runtime-worker-controller');

function parseArgs(argv) {
  const keys = { '--world-id': 'worldId', '--host': 'host', '--port': 'port', '--ticks-per-batch': 'ticksPerBatch',
    '--interval': 'intervalMs', '--retry-delay': 'retryDelayMs', '--max-attempts': 'maxCommitAttempts',
    '--startup-timeout': 'startupTimeoutMs', '--shutdown-timeout': 'shutdownTimeoutMs', '--heartbeat-timeout': 'heartbeatTimeoutMs' };
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--help' && argv.length === 1) return null;
    if (argv[index] === '--upgrade-command-profile' && result.upgradeCommandProfile === undefined) { result.upgradeCommandProfile = true; continue; }
    const key = keys[argv[index]], value = argv[++index];
    if (!key || Object.hasOwn(result, key) || !value || value.startsWith('--')) throw serviceError('INVALID_ARGUMENT');
    if (['worldId', 'host'].includes(key)) result[key] = value;
    else { if (!/^\d+$/.test(value)) throw serviceError('INVALID_ARGUMENT'); result[key] = Number(value); }
  }
  if (!result.worldId) throw serviceError('WORLD_ID_REQUIRED');
  return result;
}
function safeCode(error) {
  return /^(WORLD_DB|WORLD_RUNTIME|WORLD_SERVICE)_[A-Z_]+$/.test(error?.code || '') ? error.code : 'WORLD_SERVICE_FAILED';
}
async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (!args) { console.log('Usage: npm --prefix world-engine run engine:serve -- --world-id <id> [--host 127.0.0.1] [--port 8791] [--ticks-per-batch 1] [--interval 1000] [--retry-delay 250] [--max-attempts 5] [--startup-timeout 30000] [--shutdown-timeout 30000] [--heartbeat-timeout 30000] [--upgrade-command-profile]'); return; }
  const service = await createEngineService({ ...args, env, api: commandApiOptions({}, env) });
  const shutdown = async signal => {
    process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
    const deadline = setTimeout(() => {
      console.error(JSON.stringify({ ok: false, service: 'world-engine', error: 'WORLD_SERVICE_SHUTDOWN_TIMEOUT' }));
      process.exit(1);
    }, args.shutdownTimeoutMs ?? 30000);
    try { await service.close(); console.log(JSON.stringify({ ok: true, service: 'world-engine', stopped: signal })); }
    catch (error) { console.error(JSON.stringify({ ok: false, service: 'world-engine', error: safeCode(error) })); process.exitCode = 1; }
    finally { clearTimeout(deadline); }
  };
  const onInt = () => { shutdown('SIGINT'); }, onTerm = () => { shutdown('SIGTERM'); };
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  console.log(JSON.stringify({ ok: true, service: 'world-engine', worldId: args.worldId, address: service.address() }));
  return service;
}
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ ok: false, service: 'world-engine', error: safeCode(error) })); process.exitCode = 1;
});
module.exports = { main, parseArgs, safeCode };
