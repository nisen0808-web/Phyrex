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

function main() {
  const world = createWorld({ id: 'contract-smoke', seed: 'contract-smoke-seed' });
  registerLocation(world, {
    id: 'origin',
    name: 'Origin',
    resources: { food: 1000, wood: 1000 },
  });
  const entity = registerEntity(world, {
    id: 'contract_agent',
    name: 'Contract Agent',
    locationId: 'origin',
    stats: {
      health: 100,
      maxHealth: 100,
      energy: 100,
      maxEnergy: 100,
      power: 10,
      social: 50,
    },
    demographics: {
      birthTick: -20,
      age: 20,
      ageGroup: 'adult',
      sex: 'female',
      fertility: 1,
      lifeExpectancy: 80,
      generation: 1,
    },
  });
  assignSpecies(world, entity.id, 'human');

  const options = {
    autoNovel: false,
    autoNarrative: false,
    maxActionPlansPerTick: 20,
    population: {
      ticksPerYear: 1,
      baseBirthChance: 0.02,
      baseMortalityChance: 0.001,
      maxNaturalAge: 110,
    },
    city: { minPopulationForSettlement: 1 },
    seedIndustriesEveryTicks: 1,
  };
  const kernel = createDeterministicSimulationKernel({ contractPolicy: 'error' });
  initializeDeterministicSimulation(world, options);
  const report = runDeterministicSimulationTick(world, { simulation: options }, kernel);

  assert.strictEqual(report.kernel.contracts.violations, 0);
  assert.strictEqual(report.kernel.contracts.failures, 0);
  assert.ok(report.kernel.contracts.systems >= 20, 'enabled pipeline should validate many systems');
  assert.ok(report.kernel.contracts.checks >= 100, 'enabled pipeline should execute a broad contract set');

  const summary = getDeterministicSimulationSummary(world, kernel);
  assert.strictEqual(summary.contracts.violations, 0);
  assert.strictEqual(summary.contracts.failures, 0);
  assert.strictEqual(summary.simulationContracts.contracts, 214);

  console.log('system contract smoke test passed');
}

main();
