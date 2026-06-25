'use strict';

const assert = require('assert');
const { createWorld } = require('../core/world-engine');
const {
  randomFloat,
  randomInt,
  randomBoolean,
  randomChoice,
  randomWeightedChoice,
  shuffleDeterministic,
  captureRandomState,
  restoreRandomState,
  getRandomSummary,
  nextEngineId,
  hashSimulationState,
  canonicalStringify,
} = require('../core/engine-kernel-engine');

function main() {
  const first = createWorld({ id: 'rng_world', seed: 'stable-seed' });
  const second = createWorld({ id: 'rng_world', seed: 'stable-seed' });

  const firstSequence = Array.from({ length: 20 }, () => randomFloat(first, 'population.birth'));
  const secondSequence = Array.from({ length: 20 }, () => randomFloat(second, 'population.birth'));
  assert.deepStrictEqual(firstSequence, secondSequence, 'same seed and stream must produce same sequence');
  assert.ok(firstSequence.every(value => value >= 0 && value < 1));

  const streamOrderA = createWorld({ id: 'stream_world', seed: 44 });
  const alphaA = [randomFloat(streamOrderA, 'alpha'), randomFloat(streamOrderA, 'alpha')];
  const betaA = [randomFloat(streamOrderA, 'beta'), randomFloat(streamOrderA, 'beta')];
  const streamOrderB = createWorld({ id: 'stream_world', seed: 44 });
  const betaB = [randomFloat(streamOrderB, 'beta'), randomFloat(streamOrderB, 'beta')];
  const alphaB = [randomFloat(streamOrderB, 'alpha'), randomFloat(streamOrderB, 'alpha')];
  assert.deepStrictEqual(alphaA, alphaB, 'streams must not depend on creation order');
  assert.deepStrictEqual(betaA, betaB, 'streams must remain isolated');
  assert.notDeepStrictEqual(alphaA, betaA, 'different stream names should derive different states');

  const snapshotWorld = createWorld({ id: 'snapshot_rng', seed: 99 });
  randomFloat(snapshotWorld, 'test');
  const snapshot = captureRandomState(snapshotWorld);
  const expected = Array.from({ length: 8 }, () => randomFloat(snapshotWorld, 'test'));
  restoreRandomState(snapshotWorld, snapshot);
  const restored = Array.from({ length: 8 }, () => randomFloat(snapshotWorld, 'test'));
  assert.deepStrictEqual(restored, expected, 'restoring RNG state must resume exact sequence');

  const utilityA = createWorld({ id: 'utility_rng', seed: 1234 });
  const utilityB = createWorld({ id: 'utility_rng', seed: 1234 });
  const sampleA = {
    ints: Array.from({ length: 100 }, () => randomInt(utilityA, -3, 7, 'utility')),
    booleans: Array.from({ length: 20 }, () => randomBoolean(utilityA, 0.25, 'chance')),
    choices: Array.from({ length: 20 }, () => randomChoice(utilityA, ['a', 'b', 'c'], 'choice')),
    weighted: Array.from({ length: 20 }, () => randomWeightedChoice(utilityA, [
      { value: 'common', weight: 8 },
      { value: 'rare', weight: 2 },
    ], 'weighted')),
    shuffled: shuffleDeterministic(utilityA, [1, 2, 3, 4, 5, 6], 'shuffle'),
  };
  const sampleB = {
    ints: Array.from({ length: 100 }, () => randomInt(utilityB, -3, 7, 'utility')),
    booleans: Array.from({ length: 20 }, () => randomBoolean(utilityB, 0.25, 'chance')),
    choices: Array.from({ length: 20 }, () => randomChoice(utilityB, ['a', 'b', 'c'], 'choice')),
    weighted: Array.from({ length: 20 }, () => randomWeightedChoice(utilityB, [
      { value: 'common', weight: 8 },
      { value: 'rare', weight: 2 },
    ], 'weighted')),
    shuffled: shuffleDeterministic(utilityB, [1, 2, 3, 4, 5, 6], 'shuffle'),
  };
  assert.deepStrictEqual(sampleA, sampleB, 'all RNG helpers must be deterministic');
  assert.ok(sampleA.ints.every(value => value >= -3 && value <= 7));

  const idsA = createWorld({ id: 'id-world', seed: 1 });
  const idsB = createWorld({ id: 'id-world', seed: 1 });
  const generatedA = [nextEngineId(idsA, 'event'), nextEngineId(idsA, 'event'), nextEngineId(idsA, 'action')];
  const generatedB = [nextEngineId(idsB, 'event'), nextEngineId(idsB, 'event'), nextEngineId(idsB, 'action')];
  assert.deepStrictEqual(generatedA, generatedB, 'engine IDs must be deterministic');
  assert.strictEqual(new Set(generatedA).size, generatedA.length, 'engine IDs must be unique');

  assert.strictEqual(
    canonicalStringify({ z: 1, nested: { b: 2, a: 1 } }),
    canonicalStringify({ nested: { a: 1, b: 2 }, z: 1 }),
    'canonical serialization must ignore object insertion order',
  );
  assert.strictEqual(hashSimulationState(idsA), hashSimulationState(idsB));

  const summary = getRandomSummary(first);
  assert.strictEqual(summary.algorithm, 'xoshiro128ss');
  assert.strictEqual(summary.draws, 20);
  assert.strictEqual(summary.streams.population.birth.draws, 20);

  console.log('deterministic RNG engine test passed');
}

main();
