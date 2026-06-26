'use strict';

const assert = require('assert');
const {
  createWorld,
  registerLocation,
  registerEntity,
} = require('../core/world-engine');
const { assignSpecies } = require('../core/species-engine');
const {
  createDeterministicSimulationKernel,
  initializeDeterministicSimulation,
  runDeterministicSimulationTick,
  getDeterministicSimulationSummary,
} = require('../core/deterministic-simulation-engine');
const {
  createReplayTape,
  recordReplayStep,
  replayTape,
  verifyDeterministicExecution,
} = require('../core/replay-engine');
const { hashWorldState } = require('../core/state-integrity-engine');

function main() {
  const world = buildReplayWorld();
  const kernel = createDeterministicSimulationKernel();
  const tape = createReplayTape(world, { name: 'full-simulation-replay' });
  const input = {
    simulation: simulationOptions(),
  };

  for (let index = 0; index < 6; index += 1) {
    const report = runDeterministicSimulationTick(world, input, kernel);
    recordReplayStep(tape, world, input, report);
  }

  assert.strictEqual(tape.steps.length, 6);
  assert.strictEqual(tape.steps[5].tick, world.tick);
  const expectedDigest = hashWorldState(world);

  const replayKernel = createDeterministicSimulationKernel();
  const replay = replayTape(
    tape,
    (replayWorld, replayInput) => runDeterministicSimulationTick(replayWorld, replayInput, replayKernel),
  );
  assert.strictEqual(replay.ok, true, JSON.stringify(replay.divergences, null, 2));
  assert.strictEqual(replay.executedSteps, 6);
  assert.strictEqual(hashWorldState(replay.world), expectedDigest);

  const verification = verifyDeterministicExecution(
    tape.initialWorld,
    Array.from({ length: 4 }, () => input),
    (candidateWorld, candidateInput) => runDeterministicSimulationTick(
      candidateWorld,
      candidateInput,
      createDeterministicSimulationKernel(),
    ),
  );
  assert.strictEqual(verification.ok, true, JSON.stringify(verification.divergences, null, 2));

  const tampered = JSON.parse(JSON.stringify(tape));
  tampered.steps[2].worldDigest = '0'.repeat(64);
  const divergence = replayTape(
    tampered,
    (candidateWorld, candidateInput) => runDeterministicSimulationTick(
      candidateWorld,
      candidateInput,
      createDeterministicSimulationKernel(),
    ),
  );
  assert.strictEqual(divergence.ok, false);
  assert.strictEqual(divergence.divergences[0].step, 2);
  assert.strictEqual(divergence.divergences[0].type, 'step_digest_mismatch');

  const summary = getDeterministicSimulationSummary(world, kernel);
  assert.ok(summary.random.draws > 0, 'simulation should consume deterministic random streams');
  assert.ok(summary.scheduler.runs >= 6, 'scheduler should record deterministic ticks');
  assert.strictEqual(summary.pipeline, 'modular');
  assert.strictEqual(summary.registry.order.includes('natural.world'), true);
  assert.strictEqual(summary.registry.order.includes('ecology.world'), true);
  assert.strictEqual(summary.registry.order.includes('world.advance'), true);
  assert.strictEqual(summary.registry.order.includes('finalize.report'), true);
  assert.strictEqual(summary.modularPipeline.systems, 30);
  assert.strictEqual(summary.contractCoverage.systems, 30);
  assert.strictEqual(summary.contractCoverage.uncontracted, 0);
  assert.strictEqual(summary.worldDigest, expectedDigest);

  console.log('replay determinism integration test passed');
}

function buildReplayWorld() {
  const world = createWorld({ id: 'replay-world', seed: 'replay-seed' });
  registerLocation(world, {
    id: 'origin',
    name: 'Origin',
    resources: { food: 500, water: 500, wood: 500 },
  });
  const first = registerEntity(world, {
    id: 'replay_alice',
    name: 'Replay Alice',
    locationId: 'origin',
    traits: { ambition: 75, social: 70 },
    stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 12, social: 60 },
    resources: { currency: 20 },
    demographics: {
      birthTick: -25,
      age: 25,
      ageGroup: 'adult',
      sex: 'female',
      fertility: 1,
      lifeExpectancy: 80,
      generation: 1,
    },
  });
  const second = registerEntity(world, {
    id: 'replay_bob',
    name: 'Replay Bob',
    locationId: 'origin',
    traits: { ambition: 65, social: 55 },
    stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10, social: 50 },
    resources: { currency: 15 },
    demographics: {
      birthTick: -27,
      age: 27,
      ageGroup: 'adult',
      sex: 'male',
      fertility: 1,
      lifeExpectancy: 78,
      generation: 1,
    },
  });
  assignSpecies(world, first.id, 'human');
  assignSpecies(world, second.id, 'human');
  initializeDeterministicSimulation(world, simulationOptions());
  return world;
}

function simulationOptions() {
  return {
    autoNovel: false,
    autoNarrative: false,
    maxActionPlansPerTick: 20,
    population: {
      ticksPerYear: 1,
      baseBirthChance: 0.12,
      baseMortalityChance: 0.01,
      maxNaturalAge: 110,
    },
    city: { minPopulationForSettlement: 1 },
    seedIndustriesEveryTicks: 1,
    ecology: { baseDiseaseRisk: 0.02 },
  };
}

main();
