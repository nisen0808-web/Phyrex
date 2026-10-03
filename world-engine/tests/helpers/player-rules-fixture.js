'use strict';
const { createWorld, registerLocation, enqueueAction, advanceWorld } = require('../../core/world-engine');
const { createPlayerWithCharacter } = require('../../core/player-engine');
const { executePlayerCommand } = require('../../core/command-engine');
function fixture() {
  const world = createWorld({ id: 'rules-world', seed: 'action-rules' });
  registerLocation(world, { id: 'home', neighbors: ['away'], resources: { food: 10, wood: 10 } });
  registerLocation(world, { id: 'away', neighbors: ['home'], resources: { food: 10 } });
  for (const id of ['one', 'two']) createPlayerWithCharacter(world, { player: { id }, character: { id: `hero-${id}`, locationId: 'home' } });
  return world;
}
function submit(world, type, payload = {}, playerId = 'one') {
  return executePlayerCommand(world, playerId, { type, payload }, { publicPlayer: true });
}
function act(world, type, payload = {}, playerId = 'one') {
  const command = submit(world, type, payload, playerId).command;
  advanceWorld(world);
  return command;
}
module.exports = { fixture, submit, act, enqueueAction, advanceWorld };
