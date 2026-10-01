'use strict';
const { createWorld, registerLocation, registerEntity, connectLocations } = require('../../core/world-engine');
const { initializeDeterministicSimulation } = require('../../core/deterministic-simulation-engine');
const { createOrganization } = require('../../core/organization-engine');
const { createPlayer } = require('../../core/player-engine');

const SIMULATION = Object.freeze({
  autoNovel: false,
  autoNarrative: false,
  population: { ticksPerYear: 10, baseBirthChance: 0.0015, baseMortalityChance: 0.0001,
    environmentMortalityWeight: 0.1 },
  city: { minPopulationForSettlement: 1 },
  maxWorldMemory: 100,
  information: { maxInformationItems: 100, maxKnownItemsPerOwner: 20 },
  memory: { maxGlobalMemories: 200, maxMemoriesPerOwner: 20 },
  history: { maxEventsPerEntity: 100, maxTimelineEvents: 500 },
  opportunity: { maxTerminalOpportunities: 40 },
  conflict: { maxResolvedConflicts: 30 },
  process: { maxProcesses: 100, maxInactiveProcesses: 30, staleAfterTicks: 120 },
  infoFlow: { eventLimit: 100, maxLinksPerTick: 20 },
  cultureBeliefFlow: { eventLimit: 100, maxLinksPerTick: 20 },
});

function createEnduranceWorld(seed = 'engine-endurance-1') {
  const world = createWorld({ id: 'engine-endurance', seed });
  for (const id of ['village', 'forest']) registerLocation(world, { id,
    resources: { food: 2000, water: 2000, wood: 2000, stone: 1000, metal: 500, knowledge: 200 } });
  connectLocations(world, 'village', 'forest');
  for (let n = 0; n < 4; n++) registerEntity(world, { id: `founder_${n}`, locationId: 'village',
    demographics: { age: 24 + n, sex: n % 2 ? 'male' : 'female' },
    traits: { ambition: 30, social: 40 }, resources: { currency: 200, food: 100 },
    stats: { health: 300, maxHealth: 300 } });
  const org = createOrganization(world, { type: 'state', name: 'Village', leaderId: 'founder_0',
    homeLocationId: 'village', currency: 3000 });
  org.members = Object.keys(world.entities);
  createPlayer(world, { id: 'observer', controlMode: 'observer' });
  initializeDeterministicSimulation(world, SIMULATION);
  return world;
}
module.exports = { SIMULATION, createEnduranceWorld };
