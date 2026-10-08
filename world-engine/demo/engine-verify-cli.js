'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '..');
const SQL = Object.freeze([
  ['postgres-store.js', 'integration', 15], ['postgres-command-inbox.js', 'command inbox', 8],
  ['postgres-durable-runtime.js', 'durable runtime', 11], ['postgres-runtime-commands.js', 'runtime commands', 7],
  ['postgres-command-api.js', 'command api', 9], ['postgres-command-audit.js', 'command audit', 4],
  ['postgres-command-audit-query.js', 'command audit query', 10], ['postgres-backup.js', 'backup', 6],
  ['postgres-maintenance.js', 'maintenance', 8], ['postgres-account-admin.js', 'account admin', 8],
  ['postgres-engine-quickstart.js', 'quickstart', 8], ['postgres-engine-service.js', 'service', 9],
  ['postgres-command-queue.js', 'command queue', 10], ['postgres-player-contract.js', 'player contract', 10],
  ['postgres-player-actions.js', 'player actions', 10], ['postgres-inventory.js', 'inventory', 12],
]);
function gate(name, script, marker, args = []) { return { name, script, marker, args }; }
function gatesFor(suite) {
  const count = require('../tests/run-all').discoverTests().length;
  const all = {
    regression: [gate('regression', 'tests/run-all.js', `world-engine test runner completed ${count} tests: ${count} passed, 0 failed`)],
    postgres: SQL.map(([file, topic, n]) => gate(`postgres:${topic}`, `tests/integration/${file}`, `postgres ${topic} completed ${n} scenario groups: ${n} passed, 0 failed`)),
    endurance: [gate('endurance', 'tests/integration/postgres-engine-endurance.js', 'postgres engine endurance completed 6 scenario groups: 6 passed, 0 failed')],
    scale: ['small', 'medium', 'large'].map((name, i) => gate(`scale:${name}`, 'tests/integration/engine-scale.js', `engine scale ${name} completed: lifecycle, finite state, capacity and ${[10, 6, 3][i]} recoveries passed`, [name])),
    stress: [gate('stress', 'tests/stability-1000-test.js', '1000 tick stability test passed')],
  };
  if (suite === 'all') return Object.values(all).flat();
  if (!Object.hasOwn(all, suite)) throw new Error('Unknown verification suite');
  return all[suite];
}
function hasCompletion(stdout, expected) { return stdout.split(/\r?\n/).some(line => line.trim() === expected); }
function runGate(g) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, g.script), ...g.args], { cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', timer = setTimeout(() => child.kill(), 30 * 60 * 1000);
    child.stdout.on('data', data => { process.stdout.write(data); stdout = (stdout + data.toString('utf8')).slice(-2 * 1024 * 1024); });
    child.stderr.on('data', data => process.stderr.write(data));
    child.once('error', () => { clearTimeout(timer); resolve({ exitCode: null, stdout }); });
    child.once('close', code => { clearTimeout(timer); resolve({ exitCode: code, stdout }); });
  });
}
async function verify(gates, run = runGate) {
  const results = [];
  for (const g of gates) {
    const result = await run(g);
    const passed = result.exitCode === 0 && hasCompletion(result.stdout, g.marker);
    results.push({ gate: g.name, passed, exitCode: result.exitCode, completionFound: hasCompletion(result.stdout, g.marker) });
    if (!passed) break;
  }
  return { ok: results.length === gates.length && results.every(r => r.passed), node: process.versions.node,
    expected: gates.length, completed: results.length, results };
}
async function main(argv = process.argv.slice(2)) {
  let suite = 'regression', report, list = false;
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]; if (seen.has(key)) throw new Error('Duplicate argument'); seen.add(key);
    if (key === '--list') { list = true; continue; }
    if (!['--suite', '--report'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Invalid verification arguments');
    const value = argv[++i]; if (key === '--suite') suite = value; else report = path.resolve(value);
  }
  const gates = gatesFor(suite);
  if (list) { console.log(JSON.stringify({ suite, gates }, null, 2)); return { listed: true }; }
  if (![20, 22].includes(Number(process.versions.node.split('.')[0]))) throw new Error('Node 20 or 22 required');
  if (gates.some(g => g.name.startsWith('postgres:') || g.name === 'endurance')) {
    const url = process.env.WORLD_ENGINE_TEST_DATABASE_URL;
    if (!url || !/_(ci|test)$/.test(new URL(url).pathname)) throw new Error('Isolated _ci/_test PostgreSQL required; no skip');
    if (process.platform !== 'linux' && gates.some(g => g.name === 'postgres:service')) throw new Error('The complete service signal gate requires Linux');
  }
  let handle;
  // Refuse an existing report: each completion report belongs to one invocation.
  if (report) handle = await fs.promises.open(report, 'wx', 0o600);
  try {
    const result = await verify(gates);
    if (handle) await handle.writeFile(JSON.stringify({ suite, ...result }, null, 2) + '\n');
    console.log(`engine verification ${suite} ${result.ok ? 'passed' : 'failed'}: ${result.completed}/${result.expected} gates executed`);
    if (!result.ok) process.exitCode = 1;
    return result;
  } finally { if (handle) await handle.close(); }
}
if (require.main === module) main().catch(() => { console.error('ENGINE_VERIFICATION_FAILED'); process.exitCode = 1; });
module.exports = { SQL, gatesFor, hasCompletion, verify, main };
