'use strict';

const assert = require('assert');
const { buildDemoWorld, runDemoWorld } = require('../demo/run-demo');
const { createPlayerWithCharacter } = require('../core/player-engine');
const { executePlayerCommand } = require('../core/command-engine');
const { queryWorld } = require('../core/query-engine');
const { startTutorial, processTutorialTick } = require('../core/tutorial-engine');

function main() {
  const world = buildDemoWorld();
  runDemoWorld(world, 5, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0, baseMortalityChance: 0 },
  });

  const { player, entity } = createPlayerWithCharacter(world, {
    player: { id: 'query_player', name: 'Query Player' },
    character: {
      id: 'query_hero',
      name: 'Query Hero',
      species: 'human',
      locationId: 'qingyun_city',
      resources: { currency: 100, food: 10 },
      demographics: { age: 19, generation: 1 },
    },
  });

  startTutorial(world, player.id);
  executePlayerCommand(world, player.id, { type: 'inspect', targetType: 'player' });
  executePlayerCommand(world, player.id, { type: 'work', resource: 'currency', amount: 20 });
  processTutorialTick(world, { claimCompleted: false });

  const overview = queryWorld(world, { type: 'world' });
  assert.ok(overview.totals.players >= 1, 'world query should include players');
  assert.ok(overview.totals.commands >= 1, 'world query should include commands');
  assert.ok(overview.totals.quests >= 1, 'world query should include quests');
  assert.ok(overview.limits.quests >= 1, 'world query should include quest limit count');

  const playerQuery = queryWorld(world, { type: 'player', playerId: player.id });
  assert.strictEqual(playerQuery.activeEntity.id, entity.id, 'player query should include active entity');
  assert.ok(playerQuery.quests.length >= 1, 'player query should include quests');
  assert.ok(playerQuery.tutorial.quests.length >= 1, 'player query should include tutorial view');

  const questQuery = queryWorld(world, { type: 'quests', playerId: player.id });
  assert.strictEqual(questQuery.playerId, player.id, 'quest query should preserve player id');
  assert.ok(questQuery.quests.length >= 1, 'quest query should return quests');
  assert.ok(questQuery.stats.total >= 1, 'quest query should return stats');

  const tutorialQuery = queryWorld(world, { type: 'tutorial', playerId: player.id });
  assert.ok(tutorialQuery.quests.length >= 1, 'tutorial query should return tutorial quests');

  const mapByPlayer = queryWorld(world, { type: 'map', playerId: player.id });
  assert.strictEqual(mapByPlayer.currentLocationId, entity.locationId, 'map query by player should use active location');
  assert.ok(mapByPlayer.current.neighbors.length >= 1, 'map query should include neighbors');

  const mapByLocation = queryWorld(world, { type: 'map', locationId: 'mist_forest' });
  assert.strictEqual(mapByLocation.id, 'mist_forest', 'map query by location should return location map');
  assert.ok(mapByLocation.resources.wood >= 0, 'map query should include resources');

  const mapAll = queryWorld(world, { type: 'map' });
  assert.ok(Array.isArray(mapAll.locations), 'map query without id should list locations');
  assert.ok(mapAll.locations.length >= 3, 'map query should list demo locations');

  console.log('query content integration test passed');
}

main();
