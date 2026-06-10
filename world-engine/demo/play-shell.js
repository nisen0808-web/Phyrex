'use strict';

const fs = require('fs');
const readline = require('readline');
const { buildDemoWorld, runDemoWorld } = require('./run-demo');
const { createPlayerWithCharacter } = require('../core/player-engine');
const { createShellSession, executeShellInput, SHELL_STATUS, HELP_TEXT } = require('../core/shell-engine');

const PLAYER_ID = 'shell_player';

function main() {
  const args = parseArgs(process.argv.slice(2));
  const world = buildDemoWorld();
  runDemoWorld(world, Number(args.seedTicks || 10), {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0, baseMortalityChance: 0 },
  });

  const { player } = createPlayerWithCharacter(world, {
    player: { id: PLAYER_ID, name: args.playerName || 'Shell Player' },
    character: {
      id: 'shell_hero',
      name: args.characterName || 'Shell Hero',
      species: 'human',
      locationId: args.locationId || 'qingyun_city',
      stats: { power: 18, intelligence: 30, social: 60 },
      resources: { currency: 150, food: 10 },
      demographics: { age: 19, sex: 'unknown', generation: 1 },
    },
  });

  const session = createShellSession(world, player.id, {
    snapshotPath: args.snapshotPath || 'world-engine/output/shell-snapshot.json',
  });

  if (args.script) {
    runScript(session, args.script);
    return;
  }

  startInteractiveShell(session);
}

function startInteractiveShell(session) {
  console.log('\n=== World Engine Play Shell ===');
  console.log('Type help for commands. Type quit to exit.');
  console.log(executeShellInput(session, 'status').message);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'world> ',
  });

  rl.prompt();
  rl.on('line', line => {
    const result = executeShellInput(session, line);
    if (result.message) console.log(result.message);
    if (result.status === SHELL_STATUS.EXIT) {
      rl.close();
      return;
    }
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('Shell closed.');
  });
}

function runScript(session, scriptPath) {
  const text = fs.readFileSync(scriptPath, 'utf8');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  console.log('\n=== World Engine Scripted Shell ===');
  console.log(`Script: ${scriptPath}`);
  for (const line of lines) {
    console.log(`\n> ${line}`);
    const result = executeShellInput(session, line);
    if (result.message) console.log(result.message);
    if (result.status === SHELL_STATUS.EXIT) break;
  }
  console.log('\nScript completed.');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      console.log([
        'Usage: node world-engine/demo/play-shell.js [options]',
        '',
        'Options:',
        '  --script <file>       Run commands from a text file',
        '  --seed-ticks <n>      Advance demo world before player creation',
        '  --snapshot <file>     Default snapshot output path',
        '  --player <name>       Player display name',
        '  --character <name>    Character display name',
        '  --location <id>       Starting location id',
        '',
        HELP_TEXT,
      ].join('\n'));
      process.exit(0);
    }
    if (arg === '--script') out.script = argv[++i];
    else if (arg === '--seed-ticks') out.seedTicks = argv[++i];
    else if (arg === '--snapshot') out.snapshotPath = argv[++i];
    else if (arg === '--player') out.playerName = argv[++i];
    else if (arg === '--character') out.characterName = argv[++i];
    else if (arg === '--location') out.locationId = argv[++i];
  }
  return out;
}

if (require.main === module) main();

module.exports = {
  main,
  parseArgs,
};
