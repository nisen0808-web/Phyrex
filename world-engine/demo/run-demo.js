'use strict';

const { createWorld, registerEntity, registerLocation, connectLocations } = require('../core/world-engine');
const { initializeSimulation, runSimulationTicks, getSimulationSummary } = require('../core/simulation-engine');
const { assignSpecies } = require('../core/species-engine');
const { createOrganization } = require('../core/organization-engine');
const { createContract, CONTRACT_TYPES } = require('../core/contract-engine');
const { processCityTick } = require('../core/city-engine');
const { getPopulationStats } = require('../core/population-engine');
const { getCivilizationStats, getCivilizationChronicle } = require('../core/civilization-engine');
const { getTechnologyStats } = require('../core/technology-engine');
const { getInfrastructureStats } = require('../core/infrastructure-engine');
const { getGovernanceStats } = require('../core/governance-engine');
const { getConflictStats } = require('../core/conflict-engine');
const { getProcessStats } = require('../core/process-engine');

const ticks = Number(process.argv[2] || 100);

function main() {
  const world = buildDemoWorld();
  initializeSimulation(world, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0.001, baseMortalityChance: 0.0001 },
    city: { minPopulationForSettlement: 1 },
    information: { maxInformationItems: 1000, maxKnownItemsPerOwner: 120 },
    memory: { maxGlobalMemories: 3000, maxMemoriesPerOwner: 50 },
    process: { maxProcesses: 500, maxInactiveProcesses: 150, staleAfterTicks: 120 },
    opportunity: { discoveryChance: 0.015, crisisChance: 0.005, claimChance: 0.25 },
    conflict: { battleChance: 0.02 },
    technology: { passiveResearch: 20, maxResearchPerTick: 80 },
    infrastructure: { autoPlan: true, buildRate: 40 },
  });

  processCityTick(world, { minPopulationForSettlement: 1 });

  runSimulationTicks(world, ticks, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0.001, baseMortalityChance: 0.0001 },
    city: { minPopulationForSettlement: 1 },
    information: { maxInformationItems: 1000, maxKnownItemsPerOwner: 120 },
    memory: { maxGlobalMemories: 3000, maxMemoriesPerOwner: 50 },
    process: { maxProcesses: 500, maxInactiveProcesses: 150, staleAfterTicks: 120 },
    opportunity: { discoveryChance: 0.015, crisisChance: 0.005, claimChance: 0.25 },
    conflict: { battleChance: 0.02 },
    technology: { passiveResearch: 20, maxResearchPerTick: 80 },
    infrastructure: { autoPlan: true, buildRate: 40 },
  });

  printDemoSummary(world, ticks);
}

function buildDemoWorld() {
  const world = createWorld({ id: 'demo-world' });

  registerLocation(world, { id: 'qingyun_city', name: 'Qingyun City', resources: { food: 4000, wood: 2500, stone: 1800, metal: 800, knowledge: 500 } });
  registerLocation(world, { id: 'mist_forest', name: 'Mist Forest', resources: { food: 2500, wood: 4000, herbs: 1200 } });
  registerLocation(world, { id: 'black_iron_mine', name: 'Black Iron Mine', resources: { stone: 2500, metal: 3000, fuel: 1000 } });
  connectLocations(world, 'qingyun_city', 'mist_forest');
  connectLocations(world, 'qingyun_city', 'black_iron_mine');

  for (let i = 0; i < 36; i += 1) {
    const locationId = i % 3 === 0 ? 'qingyun_city' : i % 3 === 1 ? 'mist_forest' : 'black_iron_mine';
    const entity = registerEntity(world, {
      id: `cultivator_${i}`,
      name: `Cultivator ${i}`,
      locationId,
      traits: { ambition: 35 + (i % 60), social: 25 + (i % 50) },
      stats: {
        health: 100,
        maxHealth: 100,
        energy: 100,
        maxEnergy: 100,
        power: 10 + (i % 25),
        defense: 5 + (i % 8),
        speed: 10,
        intelligence: 20 + (i % 60),
        social: 25 + (i % 50),
      },
      resources: { currency: 120 + i * 5, food: 10 },
      demographics: { age: 18 + (i % 45), generation: 1, sex: i % 2 === 0 ? 'male' : 'female' },
    });
    assignSpecies(world, entity.id, 'human');
  }

  const sect = createOrganization(world, {
    type: 'sect',
    name: 'Qingyun Sect',
    leaderId: 'cultivator_0',
    homeLocationId: 'qingyun_city',
    currency: 6000,
  });
  const mineGuild = createOrganization(world, {
    type: 'guild',
    name: 'Black Iron Guild',
    leaderId: 'cultivator_12',
    homeLocationId: 'black_iron_mine',
    currency: 4000,
  });
  const forestClan = createOrganization(world, {
    type: 'gang',
    name: 'Mist Forest Clan',
    leaderId: 'cultivator_24',
    homeLocationId: 'mist_forest',
    currency: 2500,
  });

  for (let i = 1; i < 12; i += 1) if (!sect.members.includes(`cultivator_${i}`)) sect.members.push(`cultivator_${i}`);
  for (let i = 13; i < 24; i += 1) if (!mineGuild.members.includes(`cultivator_${i}`)) mineGuild.members.push(`cultivator_${i}`);
  for (let i = 25; i < 36; i += 1) if (!forestClan.members.includes(`cultivator_${i}`)) forestClan.members.push(`cultivator_${i}`);

  sect.rivals[mineGuild.id] = 70;
  mineGuild.rivals[sect.id] = 55;
  forestClan.rivals[sect.id] = 65;

  createContract(world, {
    type: CONTRACT_TYPES.APPRENTICESHIP,
    controllerId: 'cultivator_0',
    subjectId: 'cultivator_1',
    durationTicks: 1000,
  });
  createContract(world, {
    type: CONTRACT_TYPES.EMPLOYMENT,
    controllerId: 'cultivator_12',
    subjectId: 'cultivator_13',
    durationTicks: 1000,
  });

  return world;
}

function printDemoSummary(world, ticks) {
  const summary = getSimulationSummary(world);
  const population = getPopulationStats(world);
  const civilizationStats = getCivilizationStats(world);
  const technologyStats = getTechnologyStats(world);
  const infrastructureStats = getInfrastructureStats(world);
  const governanceStats = getGovernanceStats(world);
  const conflictStats = getConflictStats(world);
  const processStats = getProcessStats(world);
  const cityCount = Object.keys(world.cities?.byId || {}).length;
  const orgCount = Object.keys(world.organizations?.byId || {}).length;
  const infoCount = Object.keys(world.information?.items || {}).length;
  const memoryCount = Object.keys(world.memories?.byId || {}).length;
  const civ = Object.values(world.civilizations?.byId || {})[0];
  const civChronicle = civ ? getCivilizationChronicle(world, civ.id) : null;

  console.log('\n=== World Engine Demo ===');
  console.log(`Requested ticks: ${ticks}`);
  console.log(`World tick: ${world.tick}`);
  console.log(`Alive population: ${population.alive}`);
  console.log(`Cities: ${cityCount}`);
  console.log(`Organizations: ${orgCount}`);
  console.log(`Civilizations: ${civilizationStats.total}`);
  if (civChronicle) {
    console.log(`Top civilization: ${civChronicle.name} / ${civChronicle.level} / score ${civChronicle.score}`);
  }
  console.log(`Technologies unlocked: ${technologyStats.unlocked}`);
  console.log(`Infrastructure total/active: ${infrastructureStats.total}/${infrastructureStats.active}`);
  console.log(`Governments total/unstable: ${governanceStats.total}/${governanceStats.unstable}`);
  console.log(`Conflicts total/active: ${conflictStats.total}/${conflictStats.active}`);
  console.log(`Processes total/active: ${processStats.total}/${processStats.active}`);
  console.log(`World memory: ${world.memory.length}/1000`);
  console.log(`Information items: ${infoCount}/1000`);
  console.log(`Structured memories: ${memoryCount}/3000`);
  console.log(`Simulation reports: ${world.simulation.reports.length}/200`);
  console.log('\nCounters:');
  console.log(JSON.stringify(summary.counters, null, 2));
  console.log('\nDemo completed.');
}

main();
