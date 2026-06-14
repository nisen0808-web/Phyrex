'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildDemoWorld, runDemoWorld } = require('../demo/run-demo');
const { createPlayerWithCharacter } = require('../core/player-engine');
const { saveWorld, loadWorld, autosaveWorld, listSaves } = require('../core/persistence-engine');
const { scheduleOfflineCommand, getPlayerOfflineCommands, getOfflineCommandStats, advanceWorldWithOfflineCommands } = require('../core/offline-command-engine');
const { createWorldRuntime, runWorldRuntime } = require('../core/runtime-engine');
const { queryWorld } = require('../core/query-engine');
const { createWorldSnapshot } = require('../core/snapshot-engine');

function main() {
  const world = buildDemoWorld();
  runDemoWorld(world, 5, { autoNovel: false, autoNarrative: false, population: { baseBirthChance: 0, baseMortalityChance: 0 } });

  const { player, entity } = createPlayerWithCharacter(world, {
    player: { id: 'persist_player', name: 'Persist Player' },
    character: {
      id: 'persist_hero',
      name: 'Persist Hero',
      species: 'human',
      locationId: 'qingyun_city',
      stats: { health: 80, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10, social: 50 },
      resources: { currency: 100, food: 10 },
      demographics: { age: 18, generation: 1 },
    },
  });

  scheduleOfflineCommand(world, player.id, { type: 'work', resource: 'currency', amount: 5, durationTicks: 4, runsEveryTicks: 2, repeat: 2 });
  scheduleOfflineCommand(world, player.id, { type: 'train', amount: 1, durationTicks: 2, runsEveryTicks: 1, repeat: 2 });
  assert.strictEqual(getOfflineCommandStats(world).queued, 2, 'offline commands should be queued');

  advanceWorldWithOfflineCommands(world, 4, { simulation: { autoNovel: false, autoNarrative: false, population: { baseBirthChance: 0, baseMortalityChance: 0 } } });
  const offline = getPlayerOfflineCommands(world, player.id, { limit: 10 });
  assert.ok(offline.every(command => command.status === 'completed'), 'offline commands should complete');
  assert.ok(Number(world.entities[entity.id].resources.currency || 0) >= 100, 'offline work should not reduce currency');
  assert.ok(Object.keys(world.commands?.byId || {}).length >= 2, 'offline commands should create player commands');

  const saveDir = path.join(__dirname, '..', 'output', 'test-saves');
  const savePath = path.join(saveDir, 'persistence-offline-runtime.json');
  fs.mkdirSync(saveDir, { recursive: true });
  const save = saveWorld(world, savePath, { reason: 'test_save', createBackup: false });
  assert.ok(fs.existsSync(save.file), 'save file should exist');

  const loaded = loadWorld(savePath);
  assert.strictEqual(loaded.world.id, world.id, 'loaded world id should match');
  assert.strictEqual(loaded.world.tick, world.tick, 'loaded tick should match');
  assert.ok(loaded.world.players.byId[player.id], 'loaded world should include player');
  assert.ok(queryWorld(loaded.world, { type: 'offline', playerId: player.id }).offlineCommands.length >= 2, 'loaded world should query offline commands');

  scheduleOfflineCommand(loaded.world, player.id, { type: 'work', resource: 'currency', amount: 3, durationTicks: 2, runsEveryTicks: 1, repeat: 2 });
  const runtimeSave = path.join(saveDir, 'runtime-autosave.json');
  const runtime = createWorldRuntime(loaded.world, { maxTicks: 3, tickBatch: 1, autosaveEveryTicks: 1, autosavePath: runtimeSave, snapshotEveryTicks: 1 });
  const summary = runWorldRuntime(runtime);
  assert.strictEqual(summary.status, 'idle', 'runtime should finish idle');
  assert.ok(summary.ticksRun >= 3, 'runtime should run requested ticks');
  assert.ok(summary.saves.length >= 1, 'runtime should autosave');
  assert.ok(summary.snapshots.length >= 1, 'runtime should keep snapshots');
  assert.ok(fs.existsSync(runtimeSave), 'runtime autosave file should exist');

  const auto = autosaveWorld(loaded.world, saveDir, { fileName: 'manual-autosave.json', createBackup: false });
  assert.ok(fs.existsSync(auto.file), 'manual autosave should exist');
  const saves = listSaves(saveDir);
  assert.ok(saves.length >= 2, 'listSaves should return saves');

  const snapshot = createWorldSnapshot(loaded.world);
  assert.ok(snapshot.offlineCommands.total >= 1, 'snapshot should include offline commands');
  assert.ok(snapshot.limits.offlineCommands.current <= snapshot.limits.offlineCommands.limit, 'offline command limit should hold');

  console.log('persistence offline runtime integration test passed');
}

main();
