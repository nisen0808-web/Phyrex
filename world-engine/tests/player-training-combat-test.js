'use strict';
const assert = require('assert');
const { fixture, submit, act, advanceWorld } = require('./helpers/player-rules-fixture');
const { configurePlayerActionRules } = require('../core/player-action-rules-engine');
const { processPlayersTick } = require('../core/player-engine');
const { detachedJson, digest } = require('../storage/postgres/codec');
{
  const world = fixture(), hero = world.entities['hero-one'];
  for (let i = 0; i < 5; i++) assert.strictEqual(act(world, 'train').status, 'completed');
  assert.strictEqual(hero.stats.power, 13); assert.strictEqual(hero.stats.energy, 60);
  assert.strictEqual(hero.playerActionState.experience, 10); assert.strictEqual(hero.resources.training, undefined);
  assert.strictEqual(hero.goals, undefined, 'training must not manufacture goals per action');
  const restored = detachedJson(world);
  act(world, 'train'); act(restored, 'train'); assert.strictEqual(digest(world), digest(restored));
  configurePlayerActionRules(world, { trainingPowerCap: 13 });
  const before = digest(hero);
  assert.strictEqual(submit(world, 'train').result.reason, 'training_cap'); assert.strictEqual(digest(hero), before);
}
{
  const world = fixture(), hero = world.entities['hero-one'], target = world.entities['hero-two'];
  assert.strictEqual(submit(world, 'damage', { targetId: target.id, amount: 100 }).result.reason, 'invalid_quantity');
  let result = act(world, 'damage', { targetId: target.id });
  assert.strictEqual(result.result.value.amount, 7); assert.strictEqual(target.stats.health, 93); assert.strictEqual(hero.stats.energy, 92);
  target.stats.health = 3;
  result = act(world, 'damage', { targetId: target.id, lethal: false });
  assert.strictEqual(result.result.value.amount, 2); assert.strictEqual(target.stats.health, 1); assert.strictEqual(target.status, 'alive');
  result = act(world, 'damage', { targetId: target.id });
  assert.strictEqual(target.stats.health, 0); assert.strictEqual(target.status, 'dead');
  processPlayersTick(world); assert.strictEqual(world.players.byId.two.status, 'dead');
  assert.strictEqual(world.events.filter(event => event.type === 'entity.dead').length, 1);
  assert.strictEqual(submit(world, 'damage', { targetId: target.id }).result.reason, 'target_not_alive');
}
{
  const world = fixture(), hero = world.entities['hero-one'], target = world.entities['hero-two'];
  const pending = submit(world, 'damage', { targetId: target.id }).command;
  hero.stats.energy = 0;
  const before = digest(target); advanceWorld(world);
  assert.strictEqual(pending.result.reason, 'insufficient_energy'); assert.strictEqual(digest(target), before);
  hero.stats.energy = 100;
  const rest = submit(world, 'rest').command; hero.stats.health = 98; hero.stats.energy = 99; advanceWorld(world);
  assert.strictEqual(rest.result.value.healthGain, 2); assert.strictEqual(rest.result.value.energyGain, 1);
  assert.strictEqual(hero.stats.health, 100); assert.strictEqual(hero.stats.energy, 100);
}
{
  const world = fixture(), hero = world.entities['hero-one'], target = world.entities['hero-two'];
  hero.stats.health = 0;
  assert.strictEqual(submit(world, 'rest').result.reason, 'invalid_actor_state');
  assert.strictEqual(hero.stats.health, 0, 'rest cannot revive a zero-health actor');
  hero.stats.health = 100; target.stats.health = 0;
  assert.strictEqual(submit(world, 'damage', { targetId: target.id, lethal: false }).result.reason, 'invalid_target_state');
  assert.strictEqual(target.stats.health, 0);
}
console.log('player training and combat passed: cumulative growth, save/restore, caps, defense, nonlethal survival, death and execution-time costs');
