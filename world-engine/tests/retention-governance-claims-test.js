'use strict';
const assert = require('assert');
const { createWorld, registerEntity } = require('../core/world-engine');
const { createOpportunity, OPPORTUNITY_TYPES, claimOpportunity, pruneOpportunities } = require('../core/opportunity-engine');
const { generateGovernanceOpportunities } = require('../core/opportunity-governance-engine');
const { createProcess } = require('../core/process-engine');
const { createConflict, resolveConflict, pruneConflicts } = require('../core/conflict-engine');
const { repairLoadedWorld } = require('../core/persistence-engine');
const { digest } = require('../storage/postgres/codec');

const world = createWorld({ seed: 'retention-claims' });
registerEntity(world, { id: 'hero' });
world.governance = { governments: { g: { id: 'g', cityIds: [] } },
  environment: { byGovernment: { g: { totalRisk: 0.9 } } } };
const source = createProcess(world, { type: 'governance_response', ownerId: 'g',
  payload: { governmentId: 'g', responseType: 'disaster_relief' } });
const conflict = createConflict(world, { status: 'active', intensity: 100 });
const generate = target => generateGovernanceOpportunities(target, {}, { createOpportunity, OPPORTUNITY_TYPES });
const offers = generate(world);
assert.strictEqual(offers.length, 3);
for (const offer of offers) claimOpportunity(world, offer.id, 'hero');
const reward = digest(world.entities.hero);
const first = pruneOpportunities(world, { maxTerminalOpportunities: 0 });
assert.strictEqual(first.protectedTerminal, 3);
assert.strictEqual(first.overLimit, 3);
assert.deepStrictEqual(generate(world), [], 'cleanup must not offer the same governance rewards again');
assert.strictEqual(digest(world.entities.hero), reward);

const restored = repairLoadedWorld(JSON.parse(JSON.stringify(world)));
assert.deepStrictEqual(generate(restored), [], 'claim protection survives persistence');
restored.processes.byId[source.id].status = 'resolved';
resolveConflict(restored, conflict.id);
const second = pruneOpportunities(restored, { maxTerminalOpportunities: 0 });
assert.strictEqual(second.removedIds.length, 2, 'ended sources release their terminal offer');
assert.strictEqual(second.protectedTerminal, 1, 'recurring government environment claim stays protected');
for (const process of Object.values(restored.processes.byId)) process.status = 'resolved';
pruneConflicts(restored, { maxResolvedConflicts: 0 });
assert.strictEqual(restored.conflicts.byId[conflict.id], undefined);
assert.deepStrictEqual(generate(restored), []);
const nextSource = createProcess(restored, { type: 'governance_response', ownerId: 'g',
  payload: { governmentId: 'g', responseType: 'disaster_relief' } });
assert.notStrictEqual(nextSource.id, source.id, 'cleanup cannot recycle source IDs');
assert.strictEqual(generate(restored).length, 1, 'a new governance process can legitimately offer new work');
const unknown = createOpportunity(restored, { status: 'claimed', payload: { governanceOpportunityKey: 'future:type' } });
pruneOpportunities(restored, { maxTerminalOpportunities: 0 });
assert.ok(restored.opportunities.byId[unknown.id], 'unknown deduplication keys fail closed');
console.log('retention governance claims passed: no duplicate rewards, persistence, lifecycle release and new source IDs');
