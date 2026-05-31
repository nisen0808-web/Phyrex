'use strict';

const assert = require('assert');
const { createWorld, registerEntity, registerLocation } = require('../core/world-engine');
const { initializeSimulation, runSimulationTicks, getSimulationSummary } = require('../core/simulation-engine');
const { assignSpecies } = require('../core/species-engine');
const { getKnownInformation } = require('../core/information-engine');
const { getMemories } = require('../core/memory-engine');

function main() {
  const world = createWorld({ id: 'info-memory-test-world' });
  registerLocation(world, { id: 'square', name: 'Square', resources: { food: 100 } });

  registerEntity(world, {
    id: 'a',
    name: 'A',
    locationId: 'square',
    stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10, defense: 5, speed: 10, intelligence: 10, social: 10 },
    resources: { currency: 10 },
    traits: { ambition: 50 },
  });

  registerEntity(world, {
    id: 'b',
    name: 'B',
    locationId: 'square',
    stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10, defense: 5, speed: 10, intelligence: 10, social: 10 },
    resources: { currency: 10 },
    traits: { ambition: 50 },
  });

  assignSpecies(world, 'a', 'human');
  assignSpecies(world, 'b', 'human');

  initializeSimulation(world, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0 },
    maxActionPlansPerTick: 10,
  });

  const reports = runSimulationTicks(world, 3, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0 },
  });

  assert.strictEqual(reports.length, 3);
  assert.ok(reports.every(report => report.information));
  assert.ok(reports.every(report => report.memories));
  assert.ok(world.information);
  assert.ok(world.memories);
  assert.ok(Array.isArray(getKnownInformation(world, 'entity', 'a')));
  assert.ok(Array.isArray(getMemories(world, 'entity', 'a')));

  const summary = getSimulationSummary(world);
  assert.ok(summary.counters.informationCreated >= 1);
  assert.ok(summary.counters.memoriesCreated >= 1);

  console.log('information-memory integration test passed');
}

main();
