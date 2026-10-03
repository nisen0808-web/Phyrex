'use strict';
const assert = require('assert');
const { createWorld, registerLocation, registerEntity } = require('../core/world-engine');
const { createPlayerWithCharacter, createPlayerCharacter, createPlayer, bindPlayerToEntity,
  switchPlayerCharacter, processPlayersTick, setPlayerObserverMode } = require('../core/player-engine');
const { digest, detachedJson } = require('../storage/postgres/codec');
const world = createWorld({ id: 'lifecycle' });
registerLocation(world, { id: 'town' });
createPlayerWithCharacter(world, { player: { id: 'one' }, character: { id: 'hero', locationId: 'town' } });
createPlayer(world, { id: 'two' });
registerEntity(world, { id: 'npc', locationId: 'town' });
for (const input of [{ id: 'hero' }, { id: 'npc' }, { id: '__proto__' }, { species: 'invalid' },
  { locationId: 'missing' }, { tags: 42 }, { stats: { power: 'bad' } }]) {
  const before = digest(world);
  assert.throws(() => createPlayerCharacter(world, 'two', input));
  assert.strictEqual(digest(world), before);
}
let before = digest(world);
assert.throws(() => bindPlayerToEntity(world, 'two', 'hero'));
assert.strictEqual(digest(world), before);
// Stale/corrupt rosters cannot steal another player's character.
world.players.byId.two.controlledEntityIds.push('hero');
before = digest(world);
assert.throws(() => switchPlayerCharacter(world, 'two', 'hero'));
assert.strictEqual(digest(world), before);
const companion = createPlayerCharacter(world, 'one', { id: 'companion', active: false, meta: { playerId: 'two', control: 'npc' } });
assert.strictEqual(companion.meta.playerId, 'one');
assert.strictEqual(companion.meta.control, 'player');
assert.strictEqual(world.players.byId.one.activeEntityId, 'hero');
setPlayerObserverMode(world, 'one');
createPlayerCharacter(world, 'one', { id: 'third', active: false });
assert.strictEqual(world.players.byId.one.controlMode, 'observer');
switchPlayerCharacter(world, 'one', 'hero');
world.entities.hero.status = 'dead';
processPlayersTick(world);
assert.strictEqual(world.players.byId.one.activeEntityId, 'companion');
assert.throws(() => switchPlayerCharacter(world, 'one', 'hero'));
world.entities.companion.status = world.entities.third.status = 'dead';
processPlayersTick(world);
const deaths = world.players.stats.deathsObserved, count = world.players.byId.one.memory.length;
processPlayersTick(world); processPlayersTick(world);
assert.strictEqual(world.players.stats.deathsObserved, deaths);
assert.strictEqual(world.players.byId.one.memory.length, count);
const loaded = detachedJson(world); processPlayersTick(loaded);
assert.strictEqual(loaded.players.byId.one.status, 'dead');
assert.strictEqual(loaded.players.byId.one.memory.length, count);
console.log('player lifecycle integrity passed: collision-safe creation, exclusive ownership, observer preservation, death succession and restored state');
