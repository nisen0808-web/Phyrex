'use strict';
const assert = require('assert');
const { createWorld } = require('../core/world-engine');
const { createOpportunity, pruneOpportunities, processOpportunityTick } = require('../core/opportunity-engine');
const { createConflict, resolveConflict, pruneConflicts, processConflictTick } = require('../core/conflict-engine');
const { createProcess } = require('../core/process-engine');
const { digest } = require('../storage/postgres/codec');

const world = createWorld({ seed: 'terminal-retention' });
for (const id of ['old_b', 'old_a', 'new_c']) {
  world.tick = id === 'new_c' ? 2 : 1;
  createOpportunity(world, { id, status: 'expired', expiresAt: world.tick });
  createConflict(world, { id, status: 'resolved' });
}
createOpportunity(world, { id: 'live' });
createConflict(world, { id: 'live' });
createOpportunity(world, { id: 'future', status: 'future_status' });
// Resolved process records are historical provenance and do not pin records.
for (const process of Object.values(world.processes.byId)) process.status = 'resolved';
const original = digest(world);
assert.strictEqual(pruneOpportunities(world), null);
assert.strictEqual(pruneConflicts(world), null);
assert.strictEqual(digest(world), original, 'no retention option preserves the world byte-for-byte');
for (const bad of [-1, null, '2', 1.5, Infinity, NaN, 1000001]) {
  assert.throws(() => pruneOpportunities(world, { maxTerminalOpportunities: bad }), RangeError);
  assert.throws(() => pruneConflicts(world, { maxResolvedConflicts: bad }), RangeError);
  assert.throws(() => processOpportunityTick(world, { maxTerminalOpportunities: bad }), RangeError);
  assert.throws(() => processConflictTick(world, { maxResolvedConflicts: bad }), RangeError);
  assert.strictEqual(digest(world), original, 'reject invalid limits before subsystem mutation');
}
const reordered = JSON.parse(JSON.stringify(world));
for (const key of ['opportunities', 'conflicts']) {
  reordered[key].byId = Object.fromEntries(Object.entries(reordered[key].byId).reverse());
}
const entropy = JSON.stringify({ random: world.random, engineIds: world.engineIds });
for (const target of [world, reordered]) {
  assert.deepStrictEqual(pruneOpportunities(target, { maxTerminalOpportunities: 2 }).removedIds, ['old_a']);
  assert.deepStrictEqual(pruneConflicts(target, { maxResolvedConflicts: 2 }).removedIds, ['old_a']);
  assert.ok(target.opportunities.byId.live && target.opportunities.byId.future && target.conflicts.byId.live);
  for (const key of ['opportunities', 'conflicts']) {
    assert.strictEqual(target[key].stats.created, key === 'opportunities' ? 5 : 4, 'lifetime counters survive cleanup');
    for (const index of Object.values(target[key].indexes)) {
      assert.ok(Object.values(index).flat().every(id => Object.hasOwn(target[key].byId, id)), 'indexes have no removed IDs');
    }
  }
}
assert.strictEqual(digest(world), digest(reordered), 'JSONB insertion ordering cannot choose different survivors');
assert.strictEqual(JSON.stringify({ random: world.random, engineIds: world.engineIds }), entropy);
const after = digest(world);
pruneOpportunities(world, { maxTerminalOpportunities: 2 });
pruneConflicts(world, { maxResolvedConflicts: 2 });
assert.strictEqual(digest(world), after, 'cleanup is idempotent');

createProcess(world, { id: 'op-reader', ownerType: 'opportunity', ownerId: 'old_b' });
createProcess(world, { id: 'conflict-reader', payload: { conflictId: 'old_b' } });
createOpportunity(world, { id: 'mediation', targetId: 'new_c' });
let opportunityReport = pruneOpportunities(world, { maxTerminalOpportunities: 0 });
let conflictReport = pruneConflicts(world, { maxResolvedConflicts: 0 });
assert.strictEqual(opportunityReport.protectedTerminal, 1);
assert.strictEqual(opportunityReport.overLimit, 1);
assert.strictEqual(conflictReport.protectedTerminal, 2);
assert.strictEqual(conflictReport.overLimit, 2);
assert.ok(world.opportunities.byId.old_b && world.conflicts.byId.old_b && world.conflicts.byId.new_c);
world.processes.byId['op-reader'].status = 'resolved';
world.processes.byId['conflict-reader'].status = 'resolved';
world.opportunities.byId.mediation.status = 'expired';
opportunityReport = pruneOpportunities(world, { maxTerminalOpportunities: 0 });
conflictReport = pruneConflicts(world, { maxResolvedConflicts: 0 });
assert.strictEqual(opportunityReport.retainedTerminal, 0);
assert.strictEqual(conflictReport.retainedTerminal, 0);
assert.ok(world.conflicts.byId.live, 'a zero terminal budget cannot cancel live conflicts');
resolveConflict(world, 'live');
pruneConflicts(world, { maxResolvedConflicts: 0 });
assert.strictEqual(Object.keys(world.conflicts.byId).length, 0);
console.log('terminal retention passed: default compatibility, strict config, deterministic eviction, live references and pressure');
