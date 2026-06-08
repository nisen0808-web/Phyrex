'use strict';

const { buildDemoWorld, runDemoWorld } = require('./run-demo');
const { runSimulationTicks, getSimulationSummary } = require('../core/simulation-engine');
const { createPlayerWithCharacter, getPlayerView, processPlayersTick } = require('../core/player-engine');
const { executePlayerCommand, getPlayerCommands } = require('../core/command-engine');
const { queryWorld } = require('../core/query-engine');

const PLAYER_ID = 'player_demo';

function main() {
  const world = buildDemoWorld();
  runDemoWorld(world, 10, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0, baseMortalityChance: 0 },
  });

  const { player, entity } = createPlayerWithCharacter(world, {
    player: { id: PLAYER_ID, name: 'Demo Player' },
    character: {
      id: 'player_hero',
      name: 'Player Hero',
      species: 'human',
      locationId: 'qingyun_city',
      stats: { power: 18, intelligence: 30, social: 60 },
      resources: { currency: 150, food: 10 },
      demographics: { age: 19, sex: 'unknown', generation: 1 },
    },
  });

  console.log('\n=== Play Demo: Start ===');
  printPlayer(world, player.id);

  runCommand(world, player.id, { type: 'inspect', targetType: 'location', targetId: entity.locationId });
  runCommand(world, player.id, { type: 'work', resource: 'currency', amount: 25, energyCost: 5 });
  tick(world, 1);
  printPlayer(world, player.id);

  runCommand(world, player.id, { type: 'move', locationId: 'mist_forest' });
  tick(world, 1);
  printPlayer(world, player.id);

  runCommand(world, player.id, { type: 'gather', resource: 'wood', amount: 5 });
  tick(world, 1);
  printPlayer(world, player.id);

  const sectId = Object.values(world.organizations.byId).find(org => org.name === 'Qingyun Sect')?.id;
  if (sectId) {
    runCommand(world, player.id, { type: 'join_organization', organizationId: sectId, role: 'student', createContract: false });
    printPlayer(world, player.id);
  }

  runCommand(world, player.id, { type: 'train', amount: 3, power: 40 });
  tick(world, 3);
  printPlayer(world, player.id);

  console.log('\nLeaderboard by overall:');
  console.log(JSON.stringify(queryWorld(world, { type: 'leaderboard', options: { by: 'overall', limit: 5 } }), null, 2));

  console.log('\nRecent player commands:');
  console.log(JSON.stringify(getPlayerCommands(world, player.id, 10), null, 2));

  console.log('\nWorld overview:');
  console.log(JSON.stringify(queryWorld(world, { type: 'world' }), null, 2));
  console.log('\n=== Play Demo: End ===');
}

function runCommand(world, playerId, input) {
  const result = executePlayerCommand(world, playerId, input);
  console.log(`\n> ${input.type}`);
  console.log(JSON.stringify(result.result, null, 2));
  return result;
}

function tick(world, count) {
  runSimulationTicks(world, count, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0, baseMortalityChance: 0 },
    information: { maxInformationItems: 1000, maxKnownItemsPerOwner: 120 },
    memory: { maxGlobalMemories: 3000, maxMemoriesPerOwner: 50 },
    process: { maxProcesses: 500, maxInactiveProcesses: 150, staleAfterTicks: 120 },
  });
  processPlayersTick(world);
  console.log(`\n-- advanced ${count} tick(s), world tick=${world.tick} --`);
}

function printPlayer(world, playerId) {
  const view = getPlayerView(world, playerId);
  const entity = view.activeEntity;
  const summary = getSimulationSummary(world);
  console.log('\nPlayer View:');
  console.log(JSON.stringify({
    player: view.player,
    entity: entity ? {
      id: entity.id,
      name: entity.name,
      status: entity.status,
      locationId: entity.locationId,
      stats: entity.stats,
      resources: entity.resources,
      organizations: entity.organizations,
    } : null,
    worldTick: world.tick,
    counters: summary.counters,
  }, null, 2));
}

if (require.main === module) main();

module.exports = {
  main,
};
