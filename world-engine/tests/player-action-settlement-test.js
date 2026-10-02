'use strict';
const assert = require('assert');
const { createWorld, registerLocation, enqueueAction, advanceWorld } = require('../core/world-engine');
const { createPlayerWithCharacter } = require('../core/player-engine');
const { executePlayerCommand } = require('../core/command-engine');
const { detachedJson, digest } = require('../storage/postgres/codec');
function fixture() {
  const world = createWorld({ id: 'settlement', seed: 19 });
  registerLocation(world, { id: 'town', neighbors: ['forest'] });
  registerLocation(world, { id: 'forest', neighbors: ['town'] });
  registerLocation(world, { id: 'island' });
  for (const id of ['one', 'two']) createPlayerWithCharacter(world, { player: { id }, character: { id: `hero-${id}`, locationId: 'town' } });
  return world;
}
const submit = (world, id, type, payload = {}) => executePlayerCommand(world, 'one', { id, type, payload }, { publicPlayer: true });
{
  const world = fixture();
  submit(world, 'earn', 'work', { amount: 7 });
  submit(world, 'move', 'move', { locationId: 'island' });
  const restored = detachedJson(world);
  advanceWorld(world); advanceWorld(restored);
  assert.strictEqual(digest(world), digest(restored));
  assert.strictEqual(world.commands.byId.earn.status, 'completed');
  assert.strictEqual(world.commands.byId.earn.result.value.amount, 7);
  assert.strictEqual(world.commands.byId.move.status, 'rejected');
  assert.strictEqual(world.commands.byId.move.result.reason, 'not_neighbors');
  assert.strictEqual(world.commands.byId.earn.updatedAt, 1);
  const counters = { ...world.commands.stats }; advanceWorld(world);
  assert.deepStrictEqual(world.commands.stats, counters);
}
{
  const world = fixture();
  submit(world, 'transfer', 'transfer', { targetId: 'hero-two', amount: 7 });
  world.entities['hero-two'].locationId = 'forest';
  advanceWorld(world);
  assert.strictEqual(world.commands.byId.transfer.result.reason, 'target_not_at_location');
  assert.strictEqual(world.entities['hero-one'].resources.currency, 100);
  assert.strictEqual(world.entities['hero-two'].resources.currency, 100);
  submit(world, 'work-dead', 'work'); world.entities['hero-one'].status = 'dead'; advanceWorld(world);
  assert.strictEqual(world.commands.byId['work-dead'].result.reason, 'actor_not_alive');
}
{
  const world = fixture();
  enqueueAction(world, { type: 'interact', actorId: 'hero-one', targetId: 'town' });
  enqueueAction(world, { type: 'work', actorId: 'hero-one', payload: { amount: 'bad' } });
  enqueueAction(world, { type: 'constructor', actorId: 'hero-one' });
  submit(world, 'good', 'rest');
  const report = advanceWorld(world)[0];
  assert.strictEqual(report.actions.failed.length, 3);
  assert.strictEqual(world.commands.byId.good.status, 'completed');
  detachedJson(world);
}
console.log('player action settlement passed: actual outcomes, restore equality, no replay and execution-time revalidation');
