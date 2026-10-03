'use strict';
const assert = require('assert');
const { createWorld, registerEntity, recordCausality, emitEvent } = require('../core/world-engine');
const { pruneCausality } = require('../core/causality-retention-engine');
const { calculateCausalityScore } = require('../core/narrative-score-engine');
const { createContract, completeContract, pruneContracts } = require('../core/contract-engine');
const { createProcess, pruneProcesses, processProcessesTick } = require('../core/process-engine');
const { processEvents } = require('../core/event-engine');
const { repairLoadedWorld } = require('../core/persistence-engine');
const { digest } = require('../storage/postgres/codec');
const { pruneWorldGoalHistory } = require('../core/goal-retention-engine');
const { assignGoal, chooseActiveGoal } = require('../core/goal-engine');
const { createEnduranceWorld } = require('./fixtures/engine-endurance-world');
const { advanceDeterministicBatch } = require('../runtime/durable-world-runtime');

const world = createWorld({ seed: 'operational-retention' });
registerEntity(world, { id: 'a' }); registerEntity(world, { id: 'b' });
for (let n = 0; n < 30; n++) recordCausality(world, { sourceId: 'a', targetId: n % 2 ? 'a' : 'b', weight: n % 3 ? 0.1 : 0.7 });
const expected = ['a', 'b'].map(id => calculateCausalityScore(world, id));
const original = digest(world);
assert.strictEqual(pruneCausality(world), null); assert.strictEqual(digest(world), original);
for (const bad of [-1, null, '2', 1.5]) assert.throws(() => pruneCausality(world, { maxCausalityRecords: bad }));
assert.strictEqual(digest(world), original);
const pin = world.causality[2].id;
world.actionQueue.push({ causeIds: [pin] });
assert.deepStrictEqual(pruneCausality(world, { maxCausalityRecords: 3 }), { removed: 2, retained: 28, overLimit: 25 });
assert.deepStrictEqual(['a', 'b'].map(id => calculateCausalityScore(world, id)), expected);
world.actionQueue = [];
pruneCausality(world, { maxCausalityRecords: 3 });
assert.strictEqual(world.causality.length, 3);
assert.deepStrictEqual(['a', 'b'].map(id => calculateCausalityScore(world, id)), expected, 'prefix sums preserve floating-point addition order');
const after = digest(world); pruneCausality(world, { maxCausalityRecords: 3 }); assert.strictEqual(digest(world), after);
const loaded = repairLoadedWorld(JSON.parse(JSON.stringify(world)));
assert.deepStrictEqual(['a', 'b'].map(id => calculateCausalityScore(loaded, id)), expected);

for (let n = 0; n < 1100; n++) emitEvent(world, { type: 'unit.event', actorIds: ['a'], payload: { intensity: 1 } });
processEvents(world, { relationshipDecay: false });
assert.strictEqual(new Set(world.memory.map(row => row.id)).size, world.memory.length, 'rolling memory never recycles IDs within a tick');
const firstCauseIds = new Set(world.causality.map(row => row.id));
pruneCausality(world, { maxCausalityRecords: 0 });
emitEvent(world, { type: 'unit.event', actorIds: ['a'] }); processEvents(world, { relationshipDecay: false });
assert.ok(world.causality.every(row => !firstCauseIds.has(row.id)), 'same-tick append after compaction uses fresh cause IDs');

for (const id of ['c1', 'c2', 'c3']) {
  createContract(world, { id, type: 'employment', controllerId: 'a', subjectId: 'b' }); completeContract(world, id);
}
createContract(world, { id: 'live-contract', type: 'employment', controllerId: 'a', subjectId: 'b' });
createProcess(world, { id: 'reader', payload: { key: 'contract:c1' } });
const contracts = pruneContracts(world, { maxTerminalContracts: 0 });
assert.strictEqual(contracts.protectedTerminal, 1); assert.strictEqual(contracts.overLimit, 1);
assert.ok(world.contracts.byId.c1 && world.contracts.byId['live-contract']);
assert.strictEqual(world.contracts.byId.c2, undefined);
for (const index of Object.values(world.contracts.indexes)) assert.ok(Object.values(index).flat().every(id => world.contracts.byId[id]));

const processes = createWorld({ seed: 'process-pressure' });
processProcessesTick(processes, { preserveActive: true, maxProcesses: 2, maxInactiveProcesses: 0 });
for (let n = 0; n < 5; n++) createProcess(processes, { id: `p${n}` });
assert.strictEqual(Object.keys(processes.processes.byId).length, 5);
assert.strictEqual(processes.processes.capacity.overLimit, 3);
processes.processes.byId.p0.status = 'resolved'; processes.processes.byId.p1.status = 'stalled';
processes.opportunities = { byId: { reader: { status: 'active', payload: { processId: 'p1' } } } };
assert.deepStrictEqual(pruneProcesses(processes, { preserveActive: true, maxProcesses: 2, maxInactiveProcesses: 0 }), ['p0']);
assert.ok(processes.processes.byId.p1);
processes.opportunities.byId.reader.status = 'expired';
pruneProcesses(processes, { preserveActive: true, maxProcesses: 2, maxInactiveProcesses: 0 });
assert.strictEqual(Object.keys(processes.processes.byId).length, 3);
assert.strictEqual(processes.processes.capacity.overLimit, 1);
const goals = createWorld({ seed: 'goal-retention' }); registerEntity(goals, { id: 'hero' });
for (let n = 0; n < 20; n++) assignGoal(goals, 'hero', { id: `old-${n}`, type: 'gain_resources', status: 'completed' });
assignGoal(goals, 'hero', { id: 'active', type: 'survive' });
assignGoal(goals, 'hero', { id: 'unknown', type: 'future', status: 'future' });
const selected = chooseActiveGoal(goals, 'hero').id;
goals.memory = goals.memory.slice(-3);
goals.actionQueue = [{ payload: { goalId: 'old-0' } }];
const entropy = digest({ random: goals.random, engineIds: goals.engineIds });
const goalReport = pruneWorldGoalHistory(goals, { maxTerminalGoalsPerEntity: 0 });
assert.strictEqual(goalReport.removed, 19); assert.strictEqual(goalReport.overLimit, 1);
assert.deepStrictEqual(goals.entities.hero.goals.map(row => row.id), ['old-0', 'active', 'unknown']);
assert.strictEqual(chooseActiveGoal(goals, 'hero').id, selected);
assert.strictEqual(goals.entities.hero.goalMemory.length, 3);
assert.strictEqual(digest({ random: goals.random, engineIds: goals.engineIds }), entropy);
const goalState = digest(goals); pruneWorldGoalHistory(goals, { maxTerminalGoalsPerEntity: 0 }); assert.strictEqual(digest(goals), goalState);
goals.actionQueue = []; pruneWorldGoalHistory(goals, { maxTerminalGoalsPerEntity: 0 });
assert.deepStrictEqual(goals.entities.hero.goals.map(row => row.id), ['active', 'unknown']);
const fullHistory = createEnduranceWorld('goal-retention-behavior');
const boundedHistory = JSON.parse(JSON.stringify(fullHistory));
boundedHistory.simulation.options.retention = { maxTerminalGoalsPerEntity: 0 };
const entityBehavior = target => Object.fromEntries(Object.entries(target.entities).map(([id, entity]) => {
  const { goalRetention: _retention, goalMemory: _memory, goals: allGoals, ...rest } = entity;
  return [id, { ...rest, goals: (allGoals || []).filter(goal => goal.status === 'active') }];
}));
for (let batch = 0; batch < 3; batch++) {
  advanceDeterministicBatch(fullHistory, 10); advanceDeterministicBatch(boundedHistory, 10);
  assert.strictEqual(digest(entityBehavior(fullHistory)), digest(entityBehavior(boundedHistory)), 'terminal goal retention cannot change ongoing entity behavior');
  for (const key of ['random', 'engineIds', 'relationships', 'population', 'governance', 'processes', 'opportunities', 'conflicts']) assert.strictEqual(digest(fullHistory[key]), digest(boundedHistory[key]), key);
}
assert.ok(Object.values(boundedHistory.entities).some(entity => entity.goalRetention?.removed > 0));
console.log('operational retention passed: exact cumulative scores, live reference pins, unique IDs, contract indexes and active process pressure');
