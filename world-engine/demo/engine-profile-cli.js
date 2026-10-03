'use strict';
const fs = require('fs');
const path = require('path');
const { loadWorld } = require('../core/persistence-engine');
const { createEngineWorld } = require('./engine-v1-world');
const { profileEngineWorld } = require('../runtime/engine-profiler');
const MAX_INPUT_BYTES = 32 * 1024 * 1024;

function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = { '--input': 'input', '--output': 'output', '--ticks': 'ticks',
      '--warmup': 'warmup', '--population': 'population', '--seed': 'seed' }[argv[i]];
    const value = argv[++i];
    if (!key || !value || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error('Invalid profile arguments');
    options[key] = value;
  }
  if (!options.output) throw new Error('A new report output file is required');
  if (options.input && (options.population !== undefined || options.seed !== undefined)) throw new Error('Input cannot be combined with generated world options');
  for (const key of ['ticks', 'warmup', 'population']) {
    if (options[key] === undefined) continue;
    if (!/^(0|[1-9][0-9]*)$/.test(options[key])) throw new Error('Invalid profile number');
    options[key] = Number(options[key]);
    const min = key === 'warmup' ? 0 : key === 'ticks' ? 1 : 2;
    if (!Number.isSafeInteger(options[key]) || options[key] < min || options[key] > 1000) throw new Error('Profile number out of bounds');
  }
  return options;
}
async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Usage: engine-profile-cli.js --output NEW_REPORT [--input SAVE | --population 12 --seed engine-v1] [--warmup 0] [--ticks 10]\nRuns an isolated in-memory world copy. Writes timing aggregates and state fingerprints, never the world or account/session contents. No database is accessed.');
    return;
  }
  const options = parseArguments(argv);
  const file = path.resolve(options.output);
  if (fs.existsSync(file)) throw new Error('Report already exists');
  let world;
  if (options.input) {
    const input = path.resolve(options.input);
    const stat = await fs.promises.stat(input);
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error('Input save exceeds 32 MiB');
    world = loadWorld(input).world;
  } else world = createEngineWorld({ population: options.population ?? 12, seed: options.seed || 'engine-profile-v1' });
  const { report } = profileEngineWorld(world, { ticks: options.ticks, warmup: options.warmup });
  await fs.promises.writeFile(file, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { file, ticks: report.ticks, elapsedMs: report.elapsedMs, finalDigest: report.end.digest };
}
if (require.main === module) main().then(result => { if (result) console.log(JSON.stringify({ ok: true, ...result })); }).catch(() => {
  console.error(JSON.stringify({ ok: false, error: 'ENGINE_PROFILE_FAILED' })); process.exitCode = 1;
});
module.exports = { main, parseArguments };

