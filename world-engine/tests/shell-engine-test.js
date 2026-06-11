'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildDemoWorld, runDemoWorld } = require('../demo/run-demo');
const { createPlayerWithCharacter } = require('../core/player-engine');
const {
  SHELL_STATUS,
  createShellSession,
  parseShellInput,
  executeShellInput,
  resolveLocationId,
  resolveOrganizationId,
} = require('../core/shell-engine');

function main() {
  const world = buildDemoWorld();
  runDemoWorld(world, 5, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0, baseMortalityChance: 0 },
  });

  const { player, entity } = createPlayerWithCharacter(world, {
    player: { id: 'shell_test_player', name: 'Shell Tester' },
    character: {
      id: 'shell_test_hero',
      name: 'Shell Test Hero',
      species: 'human',
      locationId: 'qingyun_city',
      stats: { power: 18, intelligence: 30, social: 60 },
      resources: { currency: 150, food: 10 },
      demographics: { age: 19, generation: 1 },
    },
  });

  const outFile = path.join(__dirname, '..', 'output', 'shell-test-snapshot.json');
  const session = createShellSession(world, player.id, { snapshotPath: outFile });

  const parsed = parseShellInput('move "Mist Forest"');
  assert.strictEqual(parsed.command, 'move', 'parser should read command');
  assert.deepStrictEqual(parsed.args, ['Mist Forest'], 'parser should preserve quoted args');

  assert.strictEqual(resolveLocationId(world, 'mist_forest'), 'mist_forest', 'location resolver should match id');
  assert.strictEqual(resolveLocationId(world, 'Mist Forest'), 'mist_forest', 'location resolver should match name');
  const sectId = Object.values(world.organizations.byId).find(org => org.name === 'Qingyun Sect')?.id;
  assert.ok(sectId, 'Qingyun Sect should exist');
  assert.strictEqual(resolveOrganizationId(world, 'Qingyun Sect'), sectId, 'organization resolver should match name');

  let result = executeShellInput(session, 'status');
  assert.strictEqual(result.status, SHELL_STATUS.OK, 'status should be ok');
  assert.ok(result.message.includes('Shell Test Hero'), 'status should include character name');

  result = executeShellInput(session, 'work currency 20');
  assert.strictEqual(result.status, SHELL_STATUS.OK, 'work shell command should be ok');
  assert.ok(result.message.includes('accepted'), 'work should create accepted action');

  result = executeShellInput(session, 'wait 1');
  assert.strictEqual(result.status, SHELL_STATUS.OK, 'wait should be ok');
  assert.ok(Number(world.entities[entity.id].resources.currency || 0) >= 170, 'work should apply after wait');

  result = executeShellInput(session, 'move mist_forest');
  assert.strictEqual(result.status, SHELL_STATUS.OK, 'move shell command should be ok');
  executeShellInput(session, 'wait 1');
  assert.strictEqual(world.entities[entity.id].locationId, 'mist_forest', 'move should apply after wait');

  result = executeShellInput(session, 'gather wood 5');
  assert.strictEqual(result.status, SHELL_STATUS.OK, 'gather shell command should be ok');
  executeShellInput(session, 'wait 1');
  assert.ok(Number(world.entities[entity.id].resources.wood || 0) >= 5, 'gather should apply after wait');

  result = executeShellInput(session, 'train 3');
  assert.strictEqual(result.status, SHELL_STATUS.OK, 'train should be ok');

  result = executeShellInput(session, 'join "Qingyun Sect"');
  assert.strictEqual(result.status, SHELL_STATUS.OK, 'join should be ok');
  assert.ok(world.entities[entity.id].organizationIds.includes(sectId), 'join should add organization membership');

  result = executeShellInput(session, 'leaderboard overall 3');
  assert.strictEqual(result.status, SHELL_STATUS.OK, 'leaderboard should be ok');
  assert.ok(result.message.includes('1.'), 'leaderboard should render rows');

  result = executeShellInput(session, 'commands');
  assert.strictEqual(result.status, SHELL_STATUS.OK, 'commands should be ok');
  assert.ok(result.message.includes('work') || result.message.includes('move'), 'commands should include command history');

  result = executeShellInput(session, 'snapshot');
  assert.strictEqual(result.status, SHELL_STATUS.OK, 'snapshot should be ok');
  assert.ok(fs.existsSync(outFile), 'snapshot file should be created');
  const snapshot = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.ok(snapshot.players.total >= 1, 'snapshot should include players');
  assert.ok(snapshot.commands.total >= 1, 'snapshot should include commands');

  result = executeShellInput(session, 'unknown_command');
  assert.strictEqual(result.status, SHELL_STATUS.ERROR, 'unknown command should return error');

  result = executeShellInput(session, 'quit');
  assert.strictEqual(result.status, SHELL_STATUS.EXIT, 'quit should exit');

  console.log('shell-engine integration test passed');
}

main();
