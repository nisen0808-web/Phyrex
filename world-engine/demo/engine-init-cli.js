'use strict';
const fs = require('fs');
const path = require('path');
const { createEngineWorld } = require('./engine-v1-world');
const { createSaveEnvelope } = require('../core/persistence-engine');
const { configurePlayerActionRules } = require('../core/player-action-rules-engine');
const { createEngineWorldFromTemplate } = require('../core/engine-template-engine');
const { readTemplateFile } = require('./engine-template-cli');

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Usage: engine-init-cli.js --output NEW_FILE [--world-id ID] [--seed SEED] [--population 12 --player-rules RULES_JSON_FILE --commerce starter|none | --template-file TEMPLATE_JSON --template-id ID]\nCreates a deterministic world with an observer and v1 retention settings. Template mode validates all content before building a new save. No accounts or tokens are embedded; existing output is never replaced.');
    return;
  }
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = { '--output': 'output', '--world-id': 'worldId', '--seed': 'seed', '--population': 'population', '--player-rules': 'rulesFile', '--commerce': 'commerce', '--template-file': 'templateFile', '--template-id': 'templateId' }[argv[i]];
    const value = argv[++i];
    if (!key || !value || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error('Invalid initialization arguments');
    options[key] = value;
  }
  if (!options.output) throw new Error('A new output file is required');
  if (options.templateId && !options.templateFile) throw new Error('Template ID requires a file');
  if (options.templateFile && ['population','rulesFile','commerce'].some(key => options[key] !== undefined)) throw new Error('Template mode cannot use sample-world options');
  if (options.population !== undefined) {
    if (!/^[1-9][0-9]*$/.test(options.population)) throw new Error('Invalid population');
    options.population = Number(options.population);
  }
  if (options.worldId !== undefined && (!options.worldId.trim() || options.worldId.length > 200 || options.worldId.includes('\u0000'))) throw new Error('Invalid world ID');
  const world = options.templateFile ? createEngineWorldFromTemplate(await readTemplateFile(options.templateFile),options) : createEngineWorld(options);
  if (options.rulesFile) {
    const file = path.resolve(options.rulesFile);
    if ((await fs.promises.stat(file)).size > 16384) throw new Error('Rules file too large');
    configurePlayerActionRules(world, JSON.parse(await fs.promises.readFile(file, 'utf8')));
  }
  const envelope = createSaveEnvelope(world, { reason: 'engine_v1_initialization' });
  const file = path.resolve(options.output);
  const serialized = JSON.stringify(envelope) + '\n';
  if (Buffer.byteLength(serialized,'utf8') > 32 * 1024 * 1024) throw new Error('Initial save exceeds 32 MiB');
  await fs.promises.writeFile(file, serialized, { flag: 'wx', mode: 0o600 });
  return { file, worldId: world.id, tick: world.tick, population: Object.keys(world.entities).length, observerId: 'observer' };
}
if (require.main === module) main().then(result => { if (result) console.log(JSON.stringify({ ok: true, ...result })); }).catch(error => {
  console.error(JSON.stringify({ ok: false, error: 'ENGINE_INITIALIZATION_FAILED', ...(error.code === 'ENGINE_TEMPLATE_INVALID' ? { issues:error.issues } : {}) })); process.exitCode = 1;
});
module.exports = { main };
