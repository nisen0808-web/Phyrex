'use strict';
const assert = require('assert');
const { createWorld, registerLocation, registerEntity, advanceWorld } = require('../core/world-engine');
const { createPlayerWithCharacter, createPlayer } = require('../core/player-engine');
const { executePlayerCommand } = require('../core/command-engine');
const { executeDurableCommands } = require('../runtime/durable-world-runtime');
const { detachedJson, digest } = require('../storage/postgres/codec');
function fixture() {
  const world = createWorld({ id: 'contract-world', seed: 'player-contract' });
  registerLocation(world, { id: 'town', resources: { food: 100 }, neighbors: ['forest'] });
  registerLocation(world, { id: 'forest', neighbors: ['town'] });
  createPlayerWithCharacter(world, { player: { id: 'one' }, character: { id: 'hero', locationId: 'town' } });
  createPlayer(world, { id: 'two' });
  registerEntity(world, { id: 'target', locationId: 'town', resources: { currency: 2 } });
  return world;
}
function run(world, type, payload = {}, id) { return executePlayerCommand(world, 'one', { id, type, payload }, { publicPlayer: true }); }
function gameplay(world) { return digest({ entities: world.entities, locations: world.locations, actions: world.actionQueue, players: world.players, organizations: world.organizations || null }); }
const malformed = [
  ['wait', { ticks: 'not-a-number' }], ['wait', { ticks: 0 }], ['wait', { ticks: 1.5 }],
  ['work', { amount: '1e999' }], ['work', { energyCost: -2 }], ['work', { amount: 101 }],
  ['work', { amount: null }], ['gather', { resource: '__proto__' }], ['gather', { amount: [] }],
  ['rest', { health: true }], ['train', { power: {} }], ['train', { energyCost: Infinity }],
  ['move', { priority: '2', locationId: 'forest' }], ['damage', { targetId: 'target', lethal: 'false' }],
  ['interact', { targetId: 'town' }], ['transfer', { targetId: 'constructor' }],
  ['create_character', { stats: { power: 99999 } }], ['create_character', { id: 'target' }],
  ['create_character', { species: 'missing' }], ['create_character', { locationId: 'missing' }],
  ['join_organization', { organizationId: 'guild', role: 'leader' }],
  ['set_goal', { goalType: 'gain_power', payload: { power: 'NaN' } }],
  ['set_goal', { goalType: 'constructor' }], ['set_goal', { payload: [] }],
  ['observe', { locationId: 'missing' }], ['switch_character', { entityId: 'target' }],
  ['constructor', {}], ['wait', JSON.parse('{"__proto__":{"bad":true}}')],
];
for (const [type, payload] of malformed) {
  const world = fixture(), before = gameplay(world);
  const result = run(world, type, payload);
  assert.strictEqual(result.command.status, 'rejected', `${type}: ${JSON.stringify(payload)}`);
  assert.strictEqual(gameplay(world), before, `${type} mutated gameplay before rejection`);
  detachedJson(world);
  assert.strictEqual(run(world, 'wait').result.ok, true);
}
{
  const world = fixture();
  const currency = world.entities.hero.resources.currency;
  assert.strictEqual(run(world, 'work', { amount: 0, energyCost: 0 }).command.status, 'accepted');
  advanceWorld(world);
  assert.strictEqual(world.entities.hero.resources.currency, currency);
  assert.strictEqual(world.entities.hero.stats.energy, 100);
  run(world, 'observe');
  assert.strictEqual(run(world, 'work').result.reason, 'observer_cannot_act');
  assert.strictEqual(run(world, 'switch_character', { entityId: 'hero' }).result.ok, true);
  world.entities.target.locationId = 'forest';
  assert.strictEqual(run(world, 'damage', { targetId: 'target' }).result.reason, 'target_not_at_location');
}
{
  const world = fixture();
  run(world, 'wait', {}, 'existing');
  const saved = JSON.stringify(world.commands.byId.existing);
  const commands = [
    { id: '__proto__', playerId: 'one', input: { type: 'wait' } },
    { id: 'existing', playerId: 'one', input: { type: 'wait' } },
    { id: 'bad-ticks', playerId: 'one', input: { type: 'wait', ticks: 'abc' } },
    { id: 'good', playerId: 'one', input: { type: 'wait' } },
  ].map((c, i) => ({ ...c, sequence: i + 1, inputDigest: digest(c.input) }));
  const results = executeDurableCommands(world, commands);
  assert.deepStrictEqual(results.map(r => r.result.status), ['rejected', 'rejected', 'rejected', 'completed']);
  assert.strictEqual(JSON.stringify(world.commands.byId.existing), saved);
  assert.strictEqual(Object.hasOwn(world.commands.byId, '__proto__'), false);
  detachedJson(world);
}
{
  const world = fixture();
  world.entities.hero.goals = Array.from({ length: 100 }, () => ({ status: 'active' }));
  assert.strictEqual(run(world, 'train').result.reason, 'goal_limit');
  assert.strictEqual(world.actionQueue.length, 0);
  world.entities.hero.goals = [];
  for (let i = 0; i < 100; i++) assert.strictEqual(run(world, 'rest').command.status, 'accepted');
  assert.strictEqual(run(world, 'rest').result.reason, 'action_limit');
  assert.strictEqual(world.actionQueue.length, 100);
}
console.log('player command contracts passed: malformed inputs, no partial mutations, finite state, bounded admission and FIFO continuation');
module.exports = { fixture, run };
