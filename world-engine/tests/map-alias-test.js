'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildDemoWorld, runDemoWorld } = require('../demo/run-demo');
const { createPlayerWithCharacter } = require('../core/player-engine');
const { createPlayerMap, createLocationMap, formatLocationMap } = require('../core/map-engine');
const { normalizeShellCommand, normalizeShellTarget, getShellAliases } = require('../core/shell-alias-engine');
const { createShellSession, executeShellInput } = require('../core/shell-engine');

function main() {
  const world = buildDemoWorld();
  runDemoWorld(world, 5, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0, baseMortalityChance: 0 },
  });

  const { player } = createPlayerWithCharacter(world, {
    player: { id: 'alias_player', name: 'Alias Player' },
    character: {
      id: 'alias_hero',
      name: 'Alias Hero',
      species: 'human',
      locationId: 'qingyun_city',
      resources: { currency: 100, food: 10 },
      demographics: { age: 18, generation: 1 },
    },
  });

  assert.strictEqual(normalizeShellCommand('状态'), 'status', 'Chinese status alias should normalize');
  assert.strictEqual(normalizeShellCommand('前往'), 'move', 'Chinese move alias should normalize');
  assert.strictEqual(normalizeShellCommand('修炼'), 'train', 'Chinese train alias should normalize');
  assert.strictEqual(normalizeShellCommand('地图'), 'map', 'Chinese map alias should normalize');
  assert.strictEqual(normalizeShellTarget('地点'), 'location', 'Chinese location target should normalize');
  assert.ok(getShellAliases().commands.map.includes('地图'), 'alias list should expose map alias');

  const playerMap = createPlayerMap(world, player.id);
  assert.ok(playerMap.current, 'player map should include current location');
  assert.strictEqual(playerMap.current.id, 'qingyun_city', 'player map should use active character location');
  assert.ok(playerMap.current.neighbors.some(item => item.id === 'mist_forest'), 'map should include neighbor');
  assert.ok(formatLocationMap(playerMap).includes('Location:'), 'formatted map should include title');

  const locationMap = createLocationMap(world, 'mist_forest');
  assert.strictEqual(locationMap.id, 'mist_forest', 'location map should resolve location');
  assert.ok(locationMap.resources.wood >= 0, 'location map should include resources');

  const session = createShellSession(world, player.id);
  let result = executeShellInput(session, '地图');
  assert.strictEqual(result.status, 'ok', 'map alias command should succeed');
  assert.ok(result.message.includes('Location:'), 'map alias output should include location');

  result = executeShellInput(session, '前往 mist_forest');
  assert.strictEqual(result.status, 'ok', 'move alias should be accepted');
  executeShellInput(session, '等待 1');
  assert.strictEqual(world.entities.alias_hero.locationId, 'mist_forest', 'Chinese wait should advance move action');

  result = executeShellInput(session, '采集 wood 2');
  assert.strictEqual(result.status, 'ok', 'gather alias should be accepted');
  executeShellInput(session, '等待 1');
  assert.ok(Number(world.entities.alias_hero.resources.wood || 0) >= 2, 'gather alias should apply after wait');

  result = executeShellInput(session, '修炼 2');
  assert.strictEqual(result.status, 'ok', 'train alias should be accepted');

  const out = path.join(__dirname, '..', 'output', 'alias-map-snapshot.json');
  if (fs.existsSync(out)) fs.unlinkSync(out);
  result = executeShellInput(session, `快照 ${out}`);
  assert.strictEqual(result.status, 'ok', 'snapshot alias should succeed');
  assert.ok(fs.existsSync(out), 'snapshot alias should write file');

  console.log('map and shell alias test passed');
}

main();
