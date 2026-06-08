'use strict';

const assert = require('assert');
const { createWorld, registerLocation } = require('../core/world-engine');
const { initializeSimulation, runSimulationTicks, getSimulationSummary } = require('../core/simulation-engine');
const { createOrganization } = require('../core/organization-engine');
const { createPlayerWithCharacter, getPlayerView, processPlayersTick } = require('../core/player-engine');
const { executePlayerCommand, getPlayerCommands, getCommandStats } = require('../core/command-engine');
const { queryWorld } = require('../core/query-engine');

function main() {
  const world = createWorld({ id: 'player-command-test-world' });
  registerLocation(world, { id: 'town', name: 'Town', resources: { food: 500, wood: 500 } });
  registerLocation(world, { id: 'forest', name: 'Forest', resources: { food: 1000, wood: 1000 } });
  world.locations.town.neighbors.push('forest');
  world.locations.forest.neighbors.push('town');

  initializeSimulation(world, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0, baseMortalityChance: 0 },
    city: { minPopulationForSettlement: 1 },
  });

  const { player, entity } = createPlayerWithCharacter(world, {
    player: { id: 'p1', name: 'Player One' },
    character: {
      id: 'hero',
      name: 'Hero',
      locationId: 'town',
      species: 'human',
      stats: { power: 20, intelligence: 30, social: 50 },
      resources: { currency: 100, food: 5 },
      demographics: { age: 20, generation: 1 },
    },
  });

  const org = createOrganization(world, {
    type: 'sect',
    name: 'Test Sect',
    leaderId: entity.id,
    homeLocationId: 'town',
    currency: 1000,
  });

  assert.strictEqual(player.id, 'p1');
  assert.strictEqual(entity.id, 'hero');
  assert.strictEqual(getPlayerView(world, 'p1').activeEntity.id, 'hero');

  const inspect = executePlayerCommand(world, 'p1', { type: 'inspect', targetType: 'location', targetId: 'town' });
  assert.ok(inspect.result.ok, 'inspect should complete');
  assert.strictEqual(inspect.command.status, 'completed');

  const work = executePlayerCommand(world, 'p1', { type: 'work', resource: 'currency', amount: 25, energyCost: 5 });
  assert.ok(work.result.ok, 'work command should be accepted');
  assert.strictEqual(work.command.status, 'accepted');
  runSimulationTicks(world, 1, { autoNovel: false, autoNarrative: false, population: { baseBirthChance: 0, baseMortalityChance: 0 } });
  assert.ok(world.entities.hero.resources.currency >= 125, 'work command should increase currency after tick');

  const move = executePlayerCommand(world, 'p1', { type: 'move', locationId: 'forest' });
  assert.ok(move.result.ok, 'move command should be accepted');
  runSimulationTicks(world, 1, { autoNovel: false, autoNarrative: false, population: { baseBirthChance: 0, baseMortalityChance: 0 } });
  assert.strictEqual(world.entities.hero.locationId, 'forest', 'move command should change location after tick');

  const gather = executePlayerCommand(world, 'p1', { type: 'gather', resource: 'wood', amount: 5 });
  assert.ok(gather.result.ok, 'gather command should be accepted');
  runSimulationTicks(world, 1, { autoNovel: false, autoNarrative: false, population: { baseBirthChance: 0, baseMortalityChance: 0 } });
  assert.ok(Number(world.entities.hero.resources.wood || 0) >= 5, 'gather command should add resource');

  const join = executePlayerCommand(world, 'p1', { type: 'join_organization', organizationId: org.id, role: 'student', createContract: false });
  assert.ok(join.result.ok, 'join organization should complete');
  assert.ok(world.entities.hero.organizationIds.includes(org.id), 'player entity should join organization');

  const invalid = executePlayerCommand(world, 'p1', { type: 'move', locationId: 'missing_place' });
  assert.strictEqual(invalid.command.status, 'rejected', 'invalid command should be rejected');

  const commands = getPlayerCommands(world, 'p1', 10);
  assert.ok(commands.length >= 5, 'player command history should be queryable');
  assert.ok(getCommandStats(world).submitted >= 5, 'command stats should count submissions');

  const playerQuery = queryWorld(world, { type: 'player', playerId: 'p1' });
  assert.strictEqual(playerQuery.activeEntity.id, 'hero', 'query engine should return player view');

  const entityQuery = queryWorld(world, { type: 'entity', entityId: 'hero' });
  assert.strictEqual(entityQuery.id, 'hero', 'query engine should return entity view');

  const leaderboard = queryWorld(world, { type: 'leaderboard', options: { by: 'overall', limit: 5 } });
  assert.ok(Array.isArray(leaderboard), 'leaderboard query should return an array');
  assert.ok(leaderboard.length >= 1, 'leaderboard should contain at least one entity');

  world.entities.hero.status = 'dead';
  world.entities.hero.stats.health = 0;
  const playerTick = processPlayersTick(world);
  assert.ok(playerTick.changed.includes('p1'), 'player tick should detect dead active character');
  assert.strictEqual(getPlayerView(world, 'p1').player.status, 'dead', 'player should survive as account but active character is dead');

  const summary = getSimulationSummary(world);
  assert.ok(summary.counters.ticks >= 3, 'simulation should count command ticks');

  console.log('player-command integration test passed');
}

main();
