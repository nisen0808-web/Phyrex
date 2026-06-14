'use strict';

const path = require('path');
const { buildDemoWorld, runDemoWorld } = require('./run-demo');
const { createPlayerWithCharacter } = require('../core/player-engine');
const { scheduleOfflineCommand, getPlayerOfflineCommands } = require('../core/offline-command-engine');
const { createWorldRuntime, runWorldRuntime } = require('../core/runtime-engine');
const { saveWorld, loadWorld, listSaves } = require('../core/persistence-engine');
const { queryWorld } = require('../core/query-engine');

function main() {
  const world = buildDemoWorld();
  runDemoWorld(world, 10, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0, baseMortalityChance: 0 },
  });

  const { player } = createPlayerWithCharacter(world, {
    player: { id: 'runtime_player', name: 'Runtime Player' },
    character: {
      id: 'runtime_hero',
      name: 'Runtime Hero',
      species: 'human',
      locationId: 'qingyun_city',
      stats: { power: 15, intelligence: 30, social: 50 },
      resources: { currency: 100, food: 10 },
      demographics: { age: 20, generation: 1 },
    },
  });

  scheduleOfflineCommand(world, player.id, { type: 'work', resource: 'currency', amount: 8, durationTicks: 6, runsEveryTicks: 2, repeat: 3 });
  scheduleOfflineCommand(world, player.id, { type: 'train', amount: 2, durationTicks: 4, runsEveryTicks: 2, repeat: 2 });

  const savePath = path.join(__dirname, '..', 'output', 'runtime-world-save.json');
  const runtime = createWorldRuntime(world, {
    maxTicks: 8,
    tickBatch: 1,
    autosaveEveryTicks: 4,
    autosavePath: savePath,
    snapshotEveryTicks: 4,
  });
  const summary = runWorldRuntime(runtime);
  const save = saveWorld(world, savePath, { reason: 'runtime_demo_final' });
  const loaded = loadWorld(savePath);
  const playerQuery = queryWorld(loaded.world, { type: 'player', playerId: player.id });

  const output = {
    runtime: summary,
    save,
    loaded: { worldId: loaded.worldId, tick: loaded.tick, player: playerQuery?.player?.id || player.id },
    offlineCommands: getPlayerOfflineCommands(loaded.world, player.id, { limit: 10 }),
    saves: listSaves(path.dirname(savePath)).slice(0, 5),
  };

  console.log(JSON.stringify(output, null, 2));
  return output;
}

if (require.main === module) main();

module.exports = { main };
