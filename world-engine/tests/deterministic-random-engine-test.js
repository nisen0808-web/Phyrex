'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createWorld,
  enqueueAction,
  emitEvent,
  recordMemory,
  recordCausality,
} = require('../core/world-engine');
const {
  randomFloat,
  randomInt,
  randomChance,
  randomPick,
  randomWeightedPick,
  shuffleDeterministic,
  withDeterministicGlobals,
  snapshotRandomState,
  restoreRandomState,
  getRandomSummary,
} = require('../core/random-engine');
const { hashWorldState, compareStates } = require('../core/state-integrity-engine');
const { saveWorld, loadWorld } = require('../core/persistence-engine');

function main() {
  const left = createWorld({ id: 'deterministic-left', seed: 'same-seed' });
  const right = createWorld({ id: 'deterministic-left', seed: 'same-seed' });

  const leftValues = drawSample(left);
  const rightValues = drawSample(right);
  assert.deepStrictEqual(leftValues, rightValues, 'same seed and stream order should produce identical values');
  assert.strictEqual(hashWorldState(left), hashWorldState(right), 'same random draws should preserve identical world state');

  const other = createWorld({ id: 'deterministic-left', seed: 'other-seed' });
  assert.notDeepStrictEqual(drawSample(other), leftValues, 'different seed should produce a different stream');

  const streamBase = createWorld({ seed: 42 });
  const streamExtended = createWorld({ seed: 42 });
  const firstBase = randomFloat(streamBase, 'system.alpha');
  const secondBase = randomFloat(streamBase, 'system.alpha');
  const firstExtended = randomFloat(streamExtended, 'system.alpha');
  randomFloat(streamExtended, 'system.unrelated');
  randomFloat(streamExtended, 'system.unrelated');
  const secondExtended = randomFloat(streamExtended, 'system.alpha');
  assert.strictEqual(firstBase, firstExtended, 'named streams should start identically');
  assert.strictEqual(secondBase, secondExtended, 'unrelated stream draws should not perturb another stream');

  const snapshotWorld = createWorld({ seed: 99 });
  randomFloat(snapshotWorld, 'snapshot');
  const snapshot = snapshotRandomState(snapshotWorld);
  const expected = randomFloat(snapshotWorld, 'snapshot');
  restoreRandomState(snapshotWorld, snapshot);
  assert.strictEqual(randomFloat(snapshotWorld, 'snapshot'), expected, 'restoring random state should resume the exact stream');

  const globalsA = createWorld({ seed: 7 });
  const globalsB = createWorld({ seed: 7 });
  const sampleA = withDeterministicGlobals(globalsA, 'compatibility', () => [
    Math.random(),
    Date.now(),
    Math.random(),
    Date.now(),
  ]);
  const sampleB = withDeterministicGlobals(globalsB, 'compatibility', () => [
    Math.random(),
    Date.now(),
    Math.random(),
    Date.now(),
  ]);
  assert.deepStrictEqual(sampleA, sampleB, 'compatibility scope should make Math.random and Date.now reproducible');

  const idA = createWorld({ id: 'id-world', seed: 11 });
  const idB = createWorld({ id: 'id-world', seed: 11 });
  const artifactsA = createArtifacts(idA);
  const artifactsB = createArtifacts(idB);
  assert.deepStrictEqual(artifactsA, artifactsB, 'world-owned identifiers should be deterministic');
  assert.strictEqual(hashWorldState(idA), hashWorldState(idB));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-deterministic-rng-'));
  const savePath = path.join(directory, 'world.json');
  try {
    const persisted = createWorld({ id: 'persisted-rng', seed: 1234 });
    randomFloat(persisted, 'persist');
    saveWorld(persisted, savePath, { createBackup: false });
    const loaded = loadWorld(savePath).world;
    assert.strictEqual(
      randomFloat(persisted, 'persist'),
      randomFloat(loaded, 'persist'),
      'save/load should preserve random stream position',
    );
    assert.strictEqual(getRandomSummary(loaded).version, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  const comparison = compareStates(left, right);
  assert.strictEqual(comparison.equal, true);
  assert.deepStrictEqual(comparison.differences, []);

  console.log('deterministic random engine test passed');
}

function drawSample(world) {
  return {
    floats: [randomFloat(world, 'sample'), randomFloat(world, 'sample')],
    integer: randomInt(world, 3, 19, 'integer'),
    chance: randomChance(world, 0.75, 'chance'),
    pick: randomPick(world, ['a', 'b', 'c', 'd'], 'pick'),
    weighted: randomWeightedPick(world, [
      { value: 'common', weight: 10 },
      { value: 'rare', weight: 1 },
    ], 'weighted'),
    shuffled: shuffleDeterministic(world, [1, 2, 3, 4, 5], 'shuffle'),
  };
}

function createArtifacts(world) {
  const action = enqueueAction(world, { type: 'rest', actorId: 'actor', duration: 1 });
  const event = emitEvent(world, { type: 'test.event', actorIds: ['actor'] });
  const memory = recordMemory(world, { type: 'test.memory', payload: { eventId: event.id } });
  const cause = recordCausality(world, { type: 'test.cause', eventId: event.id, actionId: action.id });
  return {
    actionId: action.id,
    eventId: event.id,
    memoryId: memory.id,
    causeId: cause.id,
  };
}

main();
