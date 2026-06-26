'use strict';

const assert = require('assert');
const { createWorld, registerLocation, connectLocations, registerEntity } = require('../core/world-engine');
const { assignSpecies } = require('../core/species-engine');
const { processNaturalWorldTick } = require('../core/natural-world-engine');
const {
  ensureEcologyState,
  processEcologyTick,
  processHabitats,
  seedEcologyPopulations,
  processPopulations,
  processFoodWeb,
  processDisease,
  processMigration,
  getEcologySummary,
  populationKey,
} = require('../core/ecology-engine');

function main() {
  const world = buildWorld('ecology-basic');
  const random = deterministicRandom();
  processNaturalWorldTick(world, { disasterChance: 0 }, random);
  const state = ensureEcologyState(world);
  assert.strictEqual(state.version, 1);

  const habitats = processHabitats(world, {});
  assert.strictEqual(Object.keys(habitats.habitats).length, 3);
  assert.ok(habitats.habitats.forest.suitability.deer > habitats.habitats.desert.suitability.deer);
  assert.ok(habitats.habitats.desert.suitability.dragon >= habitats.habitats.forest.suitability.dragon);

  const seeded = seedEcologyPopulations(world, {}, deterministicRandom());
  assert.ok(seeded.length > 0);
  assert.ok(state.populations.byKey[populationKey('forest', 'deer')]);
  assert.ok(state.populations.byKey[populationKey('forest', 'rabbit')]);

  const beforeRabbit = state.populations.byKey[populationKey('forest', 'rabbit')].population;
  const populations = processPopulations(world, {}, deterministicRandom());
  assert.ok(populations.updated.length > 0);

  const foodWeb = processFoodWeb(world, {}, deterministicRandom());
  assert.ok(foodWeb.interactions.length > 0);
  assert.ok(state.populations.byKey[populationKey('forest', 'rabbit')].population <= beforeRabbit + 50);

  state.populations.byKey[populationKey('forest', 'rabbit')].population = 1000;
  state.populations.byKey[populationKey('forest', 'rabbit')].carryingCapacity = 100;
  state.populations.byKey[populationKey('forest', 'rabbit')].pressure = 10;
  const disease = processDisease(world, { baseDiseaseRisk: 1 }, deterministicRandom());
  assert.ok(disease.outbreaks.length > 0);

  const migration = processMigration(world, { migrationRate: 0.2, maxMigrationsPerTick: 5 }, deterministicRandom());
  assert.ok(migration.events.length > 0);
  assert.ok(getEcologySummary(world).populations.populations > 0);

  const second = buildWorld('ecology-full');
  const full = processEcologyTick(second, {}, deterministicRandom());
  assert.ok(full.habitats);
  assert.ok(full.populations.updated.length > 0);
  assert.ok(full.foodWeb);
  assert.ok(full.disease);
  assert.ok(full.migration);

  console.log('ecology engine test passed');
}

function buildWorld(id) {
  const world = createWorld({ id, seed: 'ecology-seed' });
  registerLocation(world, { id: 'forest', name: 'Old Forest', resources: { food: 180, water: 160, wood: 100, herbs: 40 }, neighbors: ['plains'] });
  registerLocation(world, { id: 'plains', name: 'Green Plains', resources: { food: 150, water: 120, herbs: 20 }, neighbors: ['forest', 'desert'] });
  registerLocation(world, { id: 'desert', name: 'Red Desert', resources: { food: 20, water: 15, stone: 120, ore: 60 }, neighbors: ['plains'] });
  connectLocations(world, 'forest', 'plains');
  connectLocations(world, 'plains', 'desert');
  const human = registerEntity(world, {
    id: `${id}_human`,
    name: 'Ecology Human',
    locationId: 'forest',
    stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10 },
  });
  assignSpecies(world, human.id, 'human');
  return world;
}

function deterministicRandom() {
  let cursor = 0;
  const values = [0.11, 0.23, 0.37, 0.49, 0.61, 0.73, 0.87, 0.97];
  const next = () => {
    const value = values[cursor % values.length];
    cursor += 1;
    return value;
  };
  return {
    float: () => next(),
    chance: probability => next() < Number(probability || 0),
    weightedPick: entries => {
      const valid = (entries || []).filter(entry => Number(entry[1]) > 0);
      return valid.length ? valid[Math.floor(next() * valid.length) % valid.length][0] : null;
    },
  };
}

main();
