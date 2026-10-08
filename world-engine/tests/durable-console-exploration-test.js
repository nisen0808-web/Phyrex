'use strict';
const assert = require('node:assert/strict');
const { consoleFixture } = require('./helpers/console-fixture');
const { inventoryFixture } = require('./helpers/inventory-fixture');
const { playerStateView } = require('../core/durable-state-view-engine');
const { registerLocation, registerEntity, connectLocations } = require('../core/world-engine');
const { createOrganization } = require('../core/organization-engine');
async function main() {
  const world = inventoryFixture(), player = world.players.byId.one;
  createOrganization(world, { id: 'local', name: '当地商会', type: 'guild', homeLocationId: 'home', meta: { secret: 'private-organization' } });
  world.entities['hero-two'].meta.secret = 'private-person';
  player.controlledEntityIds.push('hero-two'); // Corrupt roster alone never grants disclosure or control.
  world.locations.home.meta = { secret: 'private-location' };
  world.events.push({ id: 'public', status: 'resolved', type: 'entity.worked', locationId: 'home', tick: 1, actorIds: ['hero-two'], payload: { secret: 'private-payload' }, result: { secret: 'private-result' } },
    { id: 'private-event', status: 'resolved', type: 'account.administration', locationId: 'home', tick: 1, actorIds: [] },
    { id: 'remote-event', status: 'resolved', type: 'entity.worked', locationId: 'away', tick: 1, actorIds: [] },
    { id: 'pending-event', status: 'pending', type: 'entity.worked', locationId: 'home', tick: 1, actorIds: [] });
  const before = JSON.stringify(world), view = playerStateView(world, 9, 'one');
  assert.equal(JSON.stringify(world), before, 'reads cannot mutate committed state');
  assert.deepEqual(view.characters.map(row => row.id), ['hero-one']);
  assert.deepEqual(view.surroundings.neighbors.map(row => row.id), ['away']);
  assert.deepEqual(view.surroundings.events.map(row => row.id), ['public']);
  assert.equal(view.surroundings.organizations[0].name, '当地商会');
  assert.ok(!JSON.stringify(view).includes('private-')); assert.ok(!JSON.stringify(view).includes('remote-event'));
  view.characters[0].location.name = 'modified'; assert.notEqual(world.locations.home.name, 'modified');
  player.controlMode = 'observer'; player.observerLocationId = 'away';
  assert.equal(playerStateView(world, 9, 'one').location.id, 'away', 'observer location wins over retained active character');
  assert.equal(playerStateView(world, 9, 'one').characters[0].active, false);
  assert.equal(playerStateView(world, 9, 'one').character, null, 'observer mode must not present the retained active character as controlled');
  assert.equal(playerStateView(world, 9, 'one').inventory.shops.length, 0, 'do not mix retained character shops with the observer location');
  player.controlMode = 'character';
  player.activeEntityId = 'hero-two'; assert.equal(playerStateView(world, 9, 'one').character, null, 'active DTO also requires all ownership indexes');
  player.controlMode = 'character'; player.activeEntityId = 'hero-one';
  for (let i = 0; i < 140; i++) { registerLocation(world, { id: `loc-${i}`, name: 'x'.repeat(500) }); connectLocations(world, 'home', `loc-${i}`); }
  for (let i = 0; i < 40; i++) registerEntity(world, { id: `person-${i}`, locationId: 'home', meta: { secret: 'private-person' } });
  for (let i = 0; i < 25; i++) world.events.push({ id: `public-${i}`, status: 'resolved', type: 'entity.moved', locationId: 'home', tick: i, actorIds: [] });
  const bounded = playerStateView(world, 10, 'one');
  assert.equal(bounded.characterCreation.locations.length, 128); assert.equal(bounded.characterCreation.locationCount, 142);
  assert.equal(bounded.surroundings.neighbors.length, 128); assert.equal(bounded.surroundings.neighborCount, 141);
  assert.equal(bounded.surroundings.people.length, 32); assert.equal(bounded.surroundings.peopleCount, 42);
  assert.equal(bounded.surroundings.events.length, 20); assert.equal(bounded.surroundings.events[0].id, 'public-24');
  assert.ok(bounded.characterCreation.locations.every(row => !row.name || row.name.length <= 256));

  const f = await consoleFixture(), base = `http://127.0.0.1:${f.port}`;
  const { ConsoleSession } = await import('../client/durable/session.mjs');
  const map = new Map(), storage = { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
  let lose = true;
  const client = new ConsoleSession({ storage, fetcher: async (url, options) => {
    const response = await fetch(base + url, options);
    if (options.method === 'POST' && lose) { lose = false; await response.text(); f.step(); throw new Error('lost acknowledgment'); }
    return response;
  } });
  try {
    client.connect('console-test', 'one', 'console-player-fixture');
    await assert.rejects(client.submit('create_character', { name: '<img src=x onerror=alert(1)>', species: 'human', locationId: 'home', active: true }), { code: 'connection_unknown' });
    const id = client.pending.id; client.disconnect(); client.connect('console-test', 'one', 'console-player-fixture');
    assert.equal(client.pending.id, id);
    assert.equal((await client.submit()).idempotent, true);
    const created = await client.state(); assert.equal(created.characters.length, 2); assert.equal(f.rows.length, 1);
    assert.equal(created.character.name, '<img src=x onerror=alert(1)>');
    const move = await client.submit('move', { locationId: 'away' });
    assert.equal((await client.state()).location.id, 'home', 'pending movement is never optimistically published');
    f.step(); assert.equal((await client.receipt(move.id)).result.status, 'completed');
    const arrived = await client.state(); assert.equal(arrived.location.id, 'away');
    assert.deepEqual(arrived.inventory.shops.map(row => row.id), ['remote-market']);
    assert.ok(arrived.surroundings.events.some(row => row.type === 'entity.moved'));
    const switched = await client.submit('switch_character', { entityId: 'hero-one' }); f.step();
    assert.equal((await client.receipt(switched.id)).result.status, 'completed'); assert.equal((await client.state()).character.id, 'hero-one');
    const steal = await client.submit('switch_character', { entityId: 'hero-two' }); f.step();
    assert.equal((await client.receipt(steal.id)).result.outcome.reason, 'character_not_owned');
    assert.equal((await client.state()).character.id, 'hero-one');
    await assert.rejects(client.request('/players/two/state'), { status: 403 });
    assert.ok(!JSON.stringify(f.audits).includes('<img'), 'audit never stores submitted names');
  } finally { client.disconnect(); await f.api.close(); }
  console.log('durable console exploration passed: bounded public views, ownership, observer location, lost create acknowledgment, committed movement and switching');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
