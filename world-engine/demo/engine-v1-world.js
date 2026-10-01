'use strict';
const { createWorld, registerLocation, registerEntity, connectLocations } = require('../core/world-engine');
const { createOrganization } = require('../core/organization-engine');
const { createPlayer } = require('../core/player-engine');
const { initializeDeterministicSimulation } = require('../core/deterministic-simulation-engine');
const { ENGINE_V1_PROFILE } = require('../runtime/engine-v1-profile');

function createEngineWorld(options = {}) {
  const population = options.population ?? 12;
  if (!Number.isSafeInteger(population) || population < 2 || population > 1000) throw new Error('Initial population must be 2..1000');
  const world = createWorld({ id: options.worldId ?? 'engine-world', seed: options.seed ?? 'engine-v1' });
  for (const id of ['village', 'forest', 'lake', 'hills']) registerLocation(world, { id,
    resources: { food: 3000, water: 3000, wood: 2000, stone: 1000, metal: 500, knowledge: 200 } });
  for (const id of ['forest', 'lake', 'hills']) connectLocations(world, 'village', id);
  for (let n = 0; n < population; n++) registerEntity(world, { id: `founder_${n}`, locationId: 'village',
    demographics: { age: 24 + n % 25, sex: n % 2 ? 'male' : 'female' },
    traits: { ambition: 30, social: 40 }, resources: { currency: 200, food: 100 },
    stats: { health: 300, maxHealth: 300 } });
  const organization = createOrganization(world, { type: 'state', name: 'Village', leaderId: 'founder_0',
    homeLocationId: 'village', currency: population * 750 });
  organization.members = Object.keys(world.entities);
  createPlayer(world, { id: 'observer', controlMode: 'observer' });
  initializeDeterministicSimulation(world, JSON.parse(JSON.stringify({ ...ENGINE_V1_PROFILE, ...(options.simulation || {}) })));
  return world;
}
module.exports = { createEngineWorld };
