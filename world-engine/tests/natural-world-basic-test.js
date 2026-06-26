'use strict';

const assert = require('assert');
const { createWorld, registerLocation } = require('../core/world-engine');
const {
  ensureNaturalWorldState,
  processCalendarTick,
  processClimateTick,
  processWeatherTick,
  processResourceRegenerationTick,
  getNaturalWorldSummary,
  seasonForMonth,
  normalizeBiome,
} = require('../core/natural-world-engine');

const world = createWorld({ id: 'natural-basic', seed: 'natural-seed' });
registerLocation(world, { id: 'forest', name: 'Old Forest', biome: 'forest', resources: { food: 80, water: 120, wood: 100 } });
registerLocation(world, { id: 'desert', name: 'Red Desert', biome: 'desert', resources: { food: 5, water: 4, stone: 60 } });

const state = ensureNaturalWorldState(world, { ticksPerDay: 4, daysPerMonth: 2, monthsPerYear: 4 });
assert.strictEqual(state.version, 1);
assert.strictEqual(seasonForMonth(0, 4), 'spring');
assert.strictEqual(seasonForMonth(3, 4), 'winter');
assert.strictEqual(normalizeBiome('unknown'), 'plains');

world.tick = 9;
const calendar = processCalendarTick(world, { ticksPerDay: 4, daysPerMonth: 2, monthsPerYear: 4 });
assert.strictEqual(calendar.dayIndex, 2);
assert.strictEqual(calendar.month, 2);
assert.strictEqual(calendar.season, 'summer');

const random = { float: () => 0.5, int: (min, max) => Math.floor((Number(min) + Number(max)) / 2), chance: () => false, weightedPick: entries => entries[0][0] };
const climate = processClimateTick(world, {}, random);
assert.strictEqual(Object.keys(climate.zones).length, 2);
assert.ok(climate.zones.forest.humidity > climate.zones.desert.humidity);

const weather = processWeatherTick(world, {}, random);
assert.strictEqual(weather.updated.length, 2);
const beforeFood = world.locations.forest.resources.food;
const resources = processResourceRegenerationTick(world, { resourceRegenerationRate: 0.1 }, random);
assert.ok(resources.regenerated.length > 0);
assert.ok(world.locations.forest.resources.food >= beforeFood);
assert.ok(getNaturalWorldSummary(world).resources.regenerated.food >= 0);

console.log('natural world basic test passed');
