'use strict';
const fs = require('fs');
const path = require('path');
const { createEngineWorld } = require('./engine-v1-world');
const { createSaveEnvelope } = require('../core/persistence-engine');

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Usage: engine-init-cli.js --output NEW_FILE [--world-id engine-world] [--seed engine-v1] [--population 12]\nCreates a deterministic sample world with four locations, population, organization, observer and v1 retention settings. No accounts or tokens are embedded.');
    return;
  }
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = { '--output': 'output', '--world-id': 'worldId', '--seed': 'seed', '--population': 'population' }[argv[i]];
    const value = argv[++i];
    if (!key || !value || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error('Invalid initialization arguments');
    options[key] = value;
  }
  if (!options.output) throw new Error('A new output file is required');
  if (options.population !== undefined) {
    if (!/^[1-9][0-9]*$/.test(options.population)) throw new Error('Invalid population');
    options.population = Number(options.population);
  }
  if (options.worldId !== undefined && (!options.worldId.trim() || options.worldId.length > 200 || options.worldId.includes('\u0000'))) throw new Error('Invalid world ID');
  const world = createEngineWorld(options);
  const envelope = createSaveEnvelope(world, { reason: 'engine_v1_initialization' });
  const file = path.resolve(options.output);
  await fs.promises.writeFile(file, JSON.stringify(envelope) + '\n', { flag: 'wx', mode: 0o600 });
  return { file, worldId: world.id, tick: world.tick, population: Object.keys(world.entities).length, observerId: 'observer' };
}
if (require.main === module) main().then(result => { if (result) console.log(JSON.stringify({ ok: true, ...result })); }).catch(() => {
  console.error(JSON.stringify({ ok: false, error: 'ENGINE_INITIALIZATION_FAILED' })); process.exitCode = 1;
});
module.exports = { main };
