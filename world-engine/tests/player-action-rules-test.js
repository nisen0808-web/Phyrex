'use strict';
const assert = require('assert');
const { fixture, submit, act, advanceWorld, enqueueAction } = require('./helpers/player-rules-fixture');
const { planAllEntityActions, assignGoal } = require('../core/goal-engine');
const { configurePlayerActionRules, preparePlayerAction } = require('../core/player-action-rules-engine');
const { digest, detachedJson } = require('../storage/postgres/codec');
{
  const world = fixture(), hero = world.entities['hero-one'];
  for (const [type, payload] of [['work', { energyCost: 0 }], ['work', { amount: 100 }], ['work', { resource: 'diamonds' }],
    ['rest', { energy: 100 }], ['move', { locationId: 'away', priority: 100 }], ['gather', { resource: 'invented' }], ['train', { power: 1000 }]]) {
    const before = digest({ entities: world.entities, locations: world.locations, queue: world.actionQueue });
    assert.strictEqual(submit(world, type, payload).command.status, 'rejected');
    assert.strictEqual(digest({ entities: world.entities, locations: world.locations, queue: world.actionQueue }), before);
  }
  const work = submit(world, 'work').command;
  assert.strictEqual(submit(world, 'rest').result.reason, 'character_busy');
  const plans = planAllEntityActions(world);
  assert.ok(!plans.some(plan => plan.entityId === hero.id), 'AI must not add a second action behind a player command');
  advanceWorld(world);
  assert.strictEqual(work.result.value.amount, 10); assert.strictEqual(hero.resources.currency, 110); assert.strictEqual(hero.stats.energy, 94);
  hero.stats.energy = 5;
  assert.strictEqual(submit(world, 'work').result.reason, 'insufficient_energy');
  assert.strictEqual(act(world, 'rest').status, 'completed'); assert.strictEqual(hero.stats.energy, 25);
}
{
  const world = fixture(), hero = world.entities['hero-one'];
  world.locations.home.resources.wood = 2;
  const result = act(world, 'gather', { resource: 'wood' });
  assert.strictEqual(result.result.value.amount, 2); assert.strictEqual(world.locations.home.resources.wood, 0);
  assert.strictEqual(hero.resources.wood, 2); assert.strictEqual(hero.stats.energy, 96);
  assert.strictEqual(submit(world, 'gather', { resource: 'wood' }).result.reason, 'resource_unavailable');
  assert.strictEqual(submit(world, 'transfer', { targetId: 'hero-two', amount: 101 }).result.reason, 'insufficient_resource');
  const total = hero.resources.currency + world.entities['hero-two'].resources.currency;
  assert.strictEqual(act(world, 'transfer', { targetId: 'hero-two', amount: 20 }).status, 'completed');
  assert.strictEqual(hero.resources.currency + world.entities['hero-two'].resources.currency, total);
  configurePlayerActionRules(world, { maxResourceKinds: 2 });
  assert.strictEqual(submit(world, 'gather', { resource: 'food' }).command.status, 'accepted');
  advanceWorld(world);
  world.locations.home.resources.ore = 5;
  assert.strictEqual(submit(world, 'gather', { resource: 'ore' }).result.reason, 'resource_capacity');
  assert.ok(!Object.hasOwn(hero.resources, 'ore'));
}
{
  const world = fixture(), hero = world.entities['hero-one'];
  const first = preparePlayerAction(world, hero, 'work').action;
  enqueueAction(world, { ...first, playerActionRuleVersion: 1 }); enqueueAction(world, { ...first, playerActionRuleVersion: 1 });
  const copy = detachedJson(world), report = advanceWorld(world)[0]; advanceWorld(copy);
  assert.strictEqual(report.actions.completed.length, 1); assert.strictEqual(report.actions.failed[0].reason, 'action_budget_exhausted');
  assert.strictEqual(hero.resources.currency, 110); assert.strictEqual(digest(world), digest(copy));
}
{
  const world = fixture(), hero = world.entities['hero-one'];
  assignGoal(world, hero.id, { type: 'gain_power', priority: 100, payload: { power: 50 } });
  const plan = planAllEntityActions(world).find(item => item.entityId === hero.id);
  assert.strictEqual(plan.action.type, 'train'); assert.strictEqual(plan.action.playerActionRuleVersion, 1);
  enqueueAction(world, plan.action); advanceWorld(world);
  assert.strictEqual(hero.playerActionState.experience, 2);
  hero.stats.energy = 0;
  const tired = planAllEntityActions(world).find(item => item.entityId === hero.id);
  assert.strictEqual(tired.action.type, 'rest');
}
console.log('player action rules passed: server authority, energy, local stocks, conservation, bounded resource keys, tick budgets and autonomous planning');
