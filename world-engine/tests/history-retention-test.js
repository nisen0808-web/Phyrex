'use strict';
const assert = require('assert');
const { createWorld, registerEntity, recordMemory } = require('../core/world-engine');
const { recordLifeEvent, pruneHistory, ingestWorldMemory } = require('../core/history-engine');
const { repairLoadedWorld } = require('../core/persistence-engine');
const { digest } = require('../storage/postgres/codec');
const world = createWorld();
for (const id of ['a', 'b']) registerEntity(world, { id });
for (let n = 0; n < 12; n++) recordLifeEvent(world, { entityId: n % 2 ? 'a' : 'b',
  type: 'worked', tick: n, locationId: 'home', summary: 'work' });
const original = digest(world);
pruneHistory(world);
assert.strictEqual(digest(world), original, 'retention is opt-in');
assert.throws(() => pruneHistory(world, { maxTimelineEvents: 0 }));
assert.throws(() => pruneHistory(world, { maxEventsPerEntity: 2.5 }));
assert.strictEqual(digest(world), original, 'invalid limits do not mutate history');
const report = pruneHistory(world, { maxEventsPerEntity: 3, maxTimelineEvents: 5 });
assert.strictEqual(report.removed, 7);
assert.deepStrictEqual(world.history.globalTimeline.map(e => e.tick), [7,8,9,10,11]);
const ids = new Set(world.history.globalTimeline.map(e => e.id));
for (const events of Object.values(world.history.lifeEventsByEntity)) {
  assert.ok(events.length <= 3);
  assert.ok(events.every(e => ids.has(e.id)));
}
for (const index of Object.values(world.history.indexes)) {
  const values = Object.values(index).flat();
  assert.strictEqual(values.length, 5);
  assert.ok(values.every(id => ids.has(id)));
}
for (const arcs of Object.values(world.history.arcsByEntity)) {
  for (const arc of arcs) assert.ok(arc.eventIds.every(id => ids.has(id)));
}
const after = digest(world);
pruneHistory(world, { maxEventsPerEntity: 3, maxTimelineEvents: 5 });
assert.strictEqual(digest(world), after, 'same pruning is idempotent');

world.memory = [];
recordMemory(world, { type: 'entity.registered', entityId: 'a' });
const options = { maxEventsPerEntity: 3, maxTimelineEvents: 5 };
ingestWorldMemory(world, options);
const count = world.history.retention.removedEvents;
const restored = repairLoadedWorld(JSON.parse(JSON.stringify(world)));
assert.deepStrictEqual(ingestWorldMemory(restored, options), [], 'restore does not re-ingest retained input');
assert.strictEqual(restored.history.retention.removedEvents, count);
world.memory = [];
ingestWorldMemory(world, options);
assert.deepStrictEqual(world.history.consumedMemoryIds, [], 'dedup IDs track the rolling input, not all past ticks');
console.log('history retention passed: opt-in limits, indexes, arcs, replay and bounded deduplication');
