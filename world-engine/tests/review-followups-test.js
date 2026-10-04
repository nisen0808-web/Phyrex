'use strict';
const assert = require('assert');
const { createEngineWorld } = require('../demo/engine-v1-world');
const { createWorld } = require('../core/world-engine');
const { worldSummaryView } = require('../core/durable-state-view-engine');
const { processProcessesTick, createProcess } = require('../core/process-engine');
const { applyActionTick, DEFAULT_ACTION_HANDLERS } = require('../core/action-engine');
const { inventoryFixture, grantItem } = require('./helpers/inventory-fixture');
const { act } = require('./helpers/player-rules-fixture');
const { detachedJson, digest } = require('../storage/postgres/codec');

for (const population of [2, 12, 32]) {
  const world = createEngineWorld({ population });
  const org = Object.values(world.organizations.byId)[0];
  assert.strictEqual(org.members.length, population);
  assert.strictEqual(new Set(org.members).size, population);
  assert.strictEqual(org.roles.founder_0, 'leader');
  for (const id of org.members) {
    assert.strictEqual(org.roles[id], id === org.leaderId ? 'leader' : 'member');
    assert.deepStrictEqual(world.entities[id].organizationIds, [org.id]);
    assert.strictEqual(world.entities[id].factionId, org.id);
    assert.deepStrictEqual(world.organizations.indexes.byMember[id], [org.id]);
  }
  assert.strictEqual(Object.keys(world.contracts?.byId || {}).length, 0, 'initial membership does not create service obligations');
  const before = digest(world), summary = worldSummaryView(world, 17);
  assert.strictEqual(summary.counts.organizations, 1); assert.strictEqual(summary.counts.factions, 0);
  assert.strictEqual(summary.revision, 17); assert.strictEqual(digest(world), before);
  assert.deepStrictEqual(worldSummaryView(detachedJson(world), 17), summary);
}
assert.strictEqual(worldSummaryView(createWorld(), 1).counts.organizations, 0);

const world = createWorld({ id: 'retention-override' });
world.simulation = { options: { process: { preserveActive: true } } };
processProcessesTick(world, { preserveActive: false, maxProcesses: 2 });
assert.strictEqual(world.processes.retention.preserveActive, false);
const restored = detachedJson(world);
for (const w of [world, restored]) {
  for (let i = 0; i < 5; i++) createProcess(w, { id: `late-${i}`, status: 'active' });
  assert.deepStrictEqual(Object.keys(w.processes.byId), ['late-3', 'late-4']);
  assert.strictEqual(w.processes.stats.pruned, 3);
  assert.strictEqual(w.simulation.options.process.preserveActive, true, 'tick override does not rewrite stored profile');
  processProcessesTick(w, { preserveActive: true, maxProcesses: 2 });
  createProcess(w, { id: 'protected-late', status: 'active' });
  assert.strictEqual(Object.keys(w.processes.byId).length, 3, 'an explicit true still protects active work');
}
assert.strictEqual(digest(world), digest(restored));

let called = 0;
const action = { id: 'custom-work', type: 'work', remaining: 2, payload: { custom: 'supported' } };
const custom = (w, a, actor) => { called++; assert.strictEqual(actor, null); return { custom: a.payload.custom }; };
const actionWorld = createWorld();
assert.strictEqual(applyActionTick(actionWorld, action, { actionHandlers: { work: custom } }).status, 'active');
assert.strictEqual(called, 0);
assert.deepStrictEqual(applyActionTick(actionWorld, action, { actionHandlers: { work: custom } }).result, { custom: 'supported' });
assert.strictEqual(called, 1);
for (const handlers of [undefined, { work: DEFAULT_ACTION_HANDLERS.work }]) {
  assert.strictEqual(applyActionTick(actionWorld, { type: 'work', remaining: 1, payload: {} }, { actionHandlers: handlers }).reason, 'missing_actor');
}
assert.strictEqual(applyActionTick(actionWorld, { type: 'work', actorId: 'absent', remaining: 1 }, { actionHandlers: { work: custom } }).reason, 'missing_actor');
assert.strictEqual(called, 1, 'custom handlers retain general actor checks');

for (const maxEnergy of [100, 0]) {
  const w = inventoryFixture(), hero = w.entities['hero-one'];
  hero.stats.energy = 0; hero.stats.maxEnergy = maxEnergy;
  const sword = grantItem(w, 'entity', hero.id, 'wooden_sword'), power = hero.stats.power;
  assert.strictEqual(act(w, 'equip_item', { itemId: sword.id }).status, 'completed');
  assert.strictEqual(hero.stats.power, power + 2); assert.strictEqual(hero.stats.energy, 0);
  const copy = detachedJson(w);
  for (const state of [w, copy]) {
    assert.strictEqual(act(state, 'unequip_item', { slot: 'weapon' }).status, 'completed');
    assert.strictEqual(state.entities['hero-one'].stats.power, power);
    assert.strictEqual(state.entities['hero-one'].stats.energy, 0);
  }
  assert.strictEqual(digest(w), digest(copy));
}
console.log('review followups passed: founder membership, retention overrides, admin counts, handler extensions and zero-energy equipment');
