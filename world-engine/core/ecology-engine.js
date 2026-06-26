'use strict';

const ECOLOGY_VERSION = 1;

const DEFAULT_ECOLOGY_OPTIONS = {
  seedPopulation: true,
  habitatMemory: 120,
  migrationMemory: 100,
  diseaseMemory: 100,
  maxMigrationsPerTick: 12,
  baseDiseaseRisk: 0.01,
  densityDiseaseMultiplier: 0.08,
  migrationRate: 0.12,
  growthRateMultiplier: 0.04,
  minimumViablePopulation: 2,
  speciesProfiles: {
    human: {
      role: 'sentient', trophicLevel: 3, basePopulation: 18, baseCapacity: 80, growthRate: 0.025,
      diet: { food: 0.7, water: 0.3 }, habitats: ['plains', 'forest', 'coast', 'urban'], prey: [], predators: ['demon'], diseaseSensitivity: 0.7,
    },
    spirit_beast: {
      role: 'megafauna', trophicLevel: 4, basePopulation: 8, baseCapacity: 35, growthRate: 0.018,
      diet: { food: 0.5, water: 0.25, herbs: 0.25 }, habitats: ['forest', 'mountain', 'wetland'], prey: ['rabbit', 'deer'], predators: ['dragon', 'demon'], diseaseSensitivity: 0.45,
    },
    demon: {
      role: 'apex', trophicLevel: 5, basePopulation: 2, baseCapacity: 8, growthRate: 0.006,
      diet: { food: 0.35 }, habitats: ['mountain', 'desert', 'urban'], prey: ['human', 'spirit_beast', 'deer'], predators: ['dragon'], diseaseSensitivity: 0.25,
    },
    dragon: {
      role: 'ancient_apex', trophicLevel: 6, basePopulation: 1, baseCapacity: 3, growthRate: 0.002,
      diet: { food: 0.2, ore: 0.1 }, habitats: ['mountain', 'desert'], prey: ['demon', 'spirit_beast'], predators: [], diseaseSensitivity: 0.08,
    },
    deer: {
      role: 'herbivore', trophicLevel: 2, basePopulation: 35, baseCapacity: 160, growthRate: 0.08,
      diet: { food: 0.6, water: 0.25, herbs: 0.15 }, habitats: ['forest', 'plains', 'wetland'], prey: [], predators: ['wolf', 'spirit_beast', 'human'], diseaseSensitivity: 0.55,
    },
    rabbit: {
      role: 'small_herbivore', trophicLevel: 2, basePopulation: 80, baseCapacity: 300, growthRate: 0.16,
      diet: { food: 0.75, water: 0.2, herbs: 0.05 }, habitats: ['plains', 'forest', 'coast'], prey: [], predators: ['wolf', 'spirit_beast'], diseaseSensitivity: 0.75,
    },
    wolf: {
      role: 'predator', trophicLevel: 4, basePopulation: 10, baseCapacity: 45, growthRate: 0.035,
      diet: { food: 0.6, water: 0.2 }, habitats: ['forest', 'plains', 'mountain'], prey: ['rabbit', 'deer'], predators: ['spirit_beast', 'dragon'], diseaseSensitivity: 0.45,
    },
  },
};

function ensureEcologyState(world, options = {}) {
  if (!world.ecology || typeof world.ecology !== 'object') world.ecology = createEcologyState(world, options);
  const state = world.ecology;
  if (state.version !== ECOLOGY_VERSION) throw new Error(`Unsupported ecology state version ${state.version}`);
  if (!state.habitats || typeof state.habitats !== 'object') state.habitats = { byLocation: {}, history: [], stats: emptyStats() };
  if (!state.populations || typeof state.populations !== 'object') state.populations = { byKey: {}, byLocation: {}, stats: emptyStats() };
  if (!state.foodWeb || typeof state.foodWeb !== 'object') state.foodWeb = { interactions: [], stats: emptyStats() };
  if (!state.migration || typeof state.migration !== 'object') state.migration = { events: [], pressure: {}, stats: emptyStats() };
  if (!state.disease || typeof state.disease !== 'object') state.disease = { outbreaks: [], byPopulation: {}, stats: emptyStats() };
  if (!state.stats || typeof state.stats !== 'object') state.stats = emptyStats();
  return state;
}

function createEcologyState(world, _options = {}) {
  return {
    version: ECOLOGY_VERSION,
    createdAtTick: Number(world?.tick || 0),
    habitats: { byLocation: {}, history: [], stats: emptyStats() },
    populations: { byKey: {}, byLocation: {}, stats: emptyStats() },
    foodWeb: { interactions: [], stats: emptyStats() },
    migration: { events: [], pressure: {}, stats: emptyStats() },
    disease: { outbreaks: [], byPopulation: {}, stats: emptyStats() },
    stats: emptyStats(),
  };
}

function processEcologyTick(world, options = {}, context = {}) {
  const state = ensureEcologyState(world, options);
  const config = mergeEcologyOptions(options);
  const random = context.random || fallbackRandom();
  const habitats = processHabitats(world, config);
  const seeded = config.seedPopulation ? seedEcologyPopulations(world, config, random) : [];
  const populations = processPopulations(world, config, random);
  const foodWeb = processFoodWeb(world, config, random);
  const disease = processDisease(world, config, random);
  const migration = processMigration(world, config, random);
  state.stats.ticks = Number(state.stats.ticks || 0) + 1;
  return { habitats, seeded, populations, foodWeb, disease, migration };
}

function processHabitats(world, options = {}) {
  const state = ensureEcologyState(world, options);
  const config = mergeEcologyOptions(options);
  const habitats = {};
  for (const location of Object.values(world.locations || {})) {
    const zone = world.natural?.climate?.zones?.[location.id] || {};
    const biome = zone.biome || inferBiome(location);
    const resources = location.resources || {};
    const food = Number(resources.food || 0);
    const water = Number(resources.water || 0);
    const fertility = clamp(Number(zone.fertility ?? 0.45), 0, 1);
    const aridity = clamp(Number(zone.aridity ?? 0.4), 0, 1);
    const weather = world.natural?.weather?.byLocation?.[location.id] || { type: 'clear', severity: 0 };
    const hazard = weatherHazard(weather.type, weather.severity) + activeDisasterHazard(world, location.id);
    habitats[location.id] = {
      locationId: location.id,
      biome,
      fertility: round(fertility, 3),
      aridity: round(aridity, 3),
      food: round(food, 3),
      water: round(water, 3),
      hazard: round(clamp(hazard, 0, 1), 3),
      suitability: {},
    };
    for (const [speciesId, profile] of Object.entries(config.speciesProfiles)) {
      habitats[location.id].suitability[speciesId] = round(habitatSuitability(habitats[location.id], profile), 3);
    }
  }
  state.habitats.byLocation = habitats;
  state.habitats.history.push({ tick: Number(world.tick || 0), locations: Object.keys(habitats).length });
  trimArray(state.habitats.history, config.habitatMemory);
  state.habitats.stats = {
    ticks: Number(state.habitats.stats?.ticks || 0) + 1,
    locations: Object.keys(habitats).length,
    averageFertility: round(average(Object.values(habitats).map(item => item.fertility)), 3),
    averageHazard: round(average(Object.values(habitats).map(item => item.hazard)), 3),
  };
  return { habitats, stats: { ...state.habitats.stats } };
}

function seedEcologyPopulations(world, options = {}, random = null) {
  const state = ensureEcologyState(world, options);
  const config = mergeEcologyOptions(options);
  const seeded = [];
  for (const habitat of Object.values(state.habitats.byLocation || {})) {
    for (const [speciesId, profile] of Object.entries(config.speciesProfiles)) {
      const key = populationKey(habitat.locationId, speciesId);
      if (state.populations.byKey[key]) continue;
      const suitability = Number(habitat.suitability?.[speciesId] || 0);
      if (suitability < 0.18 && !entitiesOfSpeciesAt(world, habitat.locationId, speciesId)) continue;
      const entityCount = entitiesOfSpeciesAt(world, habitat.locationId, speciesId);
      const noise = 0.85 + (random || fallbackRandom()).float(`seed:${key}`) * 0.3;
      const population = Math.max(entityCount, Math.round(Number(profile.basePopulation || 1) * suitability * noise));
      const carryingCapacity = calculateCarryingCapacity(habitat, profile, options);
      state.populations.byKey[key] = createPopulationRecord(habitat.locationId, speciesId, population, carryingCapacity);
      seeded.push({ locationId: habitat.locationId, speciesId, population, carryingCapacity });
    }
  }
  rebuildPopulationLocationIndex(state);
  return seeded;
}

function processPopulations(world, options = {}, random = null) {
  const state = ensureEcologyState(world, options);
  const config = mergeEcologyOptions(options);
  const updated = [];
  const collapsed = [];
  for (const population of Object.values(state.populations.byKey || {})) {
    const profile = config.speciesProfiles[population.speciesId];
    const habitat = state.habitats.byLocation[population.locationId];
    if (!profile || !habitat) continue;
    const carryingCapacity = calculateCarryingCapacity(habitat, profile, config);
    const pressure = carryingCapacity > 0 ? population.population / carryingCapacity : 2;
    const growth = calculatePopulationGrowth(population, profile, habitat, pressure, random || fallbackRandom());
    population.population = round(Math.max(0, population.population + growth), 3);
    population.carryingCapacity = round(carryingCapacity, 3);
    population.pressure = round(pressure, 3);
    population.health = round(clamp(population.health + (pressure > 1 ? -0.03 : 0.015) - habitat.hazard * 0.04, 0, 1), 3);
    population.updatedAtTick = Number(world.tick || 0);
    if (population.population < Number(config.minimumViablePopulation)) collapsed.push({ ...population });
    updated.push({ ...population, growth: round(growth, 3) });
  }
  for (const pop of collapsed) delete state.populations.byKey[populationKey(pop.locationId, pop.speciesId)];
  rebuildPopulationLocationIndex(state);
  state.populations.stats = {
    ticks: Number(state.populations.stats?.ticks || 0) + 1,
    populations: Object.keys(state.populations.byKey).length,
    collapsed: collapsed.length,
    totalIndividuals: round(Object.values(state.populations.byKey).reduce((sum, pop) => sum + Number(pop.population || 0), 0), 3),
  };
  return { updated, collapsed, stats: { ...state.populations.stats } };
}

function processFoodWeb(world, options = {}, random = null) {
  const state = ensureEcologyState(world, options);
  const config = mergeEcologyOptions(options);
  const interactions = [];
  for (const [locationId, speciesIds] of Object.entries(state.populations.byLocation || {})) {
    for (const predatorId of speciesIds) {
      const predator = state.populations.byKey[populationKey(locationId, predatorId)];
      const predatorProfile = config.speciesProfiles[predatorId];
      if (!predator || !predatorProfile?.prey?.length) continue;
      for (const preyId of predatorProfile.prey) {
        const prey = state.populations.byKey[populationKey(locationId, preyId)];
        if (!prey || prey.population <= 0 || predator.population <= 0) continue;
        const appetite = Math.min(prey.population * 0.12, predator.population * 0.035 * (0.75 + (random || fallbackRandom()).float(`predation:${locationId}:${predatorId}:${preyId}`) * 0.5));
        if (appetite <= 0) continue;
        prey.population = round(Math.max(0, prey.population - appetite), 3);
        predator.health = round(clamp(Number(predator.health || 0.5) + appetite / Math.max(1, predator.carryingCapacity) * 0.25, 0, 1), 3);
        interactions.push({ locationId, predatorId, preyId, amount: round(appetite, 3) });
      }
    }
  }
  rebuildPopulationLocationIndex(state);
  state.foodWeb.interactions.push(...interactions.map(item => ({ tick: Number(world.tick || 0), ...item })));
  trimArray(state.foodWeb.interactions, 300);
  state.foodWeb.stats = {
    ticks: Number(state.foodWeb.stats?.ticks || 0) + 1,
    interactions: interactions.length,
    biomassMoved: round(interactions.reduce((sum, item) => sum + item.amount, 0), 3),
  };
  return { interactions, stats: { ...state.foodWeb.stats } };
}

function processDisease(world, options = {}, random = null) {
  const state = ensureEcologyState(world, options);
  const config = mergeEcologyOptions(options);
  const outbreaks = [];
  const diseaseUpdates = [];
  for (const population of Object.values(state.populations.byKey || {})) {
    const profile = config.speciesProfiles[population.speciesId] || {};
    const density = population.carryingCapacity > 0 ? population.population / population.carryingCapacity : 1;
    const risk = clamp(Number(config.baseDiseaseRisk) + Math.max(0, density - 0.75) * Number(config.densityDiseaseMultiplier) + (1 - Number(population.health || 0.5)) * 0.05, 0, 0.85);
    const randomContext = random || fallbackRandom();
    if (randomContext.chance(risk * Number(profile.diseaseSensitivity ?? 0.5), `disease:${population.locationId}:${population.speciesId}`)) {
      const severity = clamp(0.1 + risk + randomContext.float(`disease:${population.locationId}:${population.speciesId}:severity`) * 0.25, 0, 1);
      const loss = Math.min(population.population, population.population * severity * 0.025);
      population.population = round(Math.max(0, population.population - loss), 3);
      population.health = round(clamp(population.health - severity * 0.08, 0, 1), 3);
      population.diseaseLoad = round(clamp(Number(population.diseaseLoad || 0) + severity * 0.2, 0, 1), 3);
      const outbreak = { tick: Number(world.tick || 0), locationId: population.locationId, speciesId: population.speciesId, severity: round(severity, 3), loss: round(loss, 3) };
      outbreaks.push(outbreak);
      state.disease.outbreaks.push(outbreak);
    } else {
      population.diseaseLoad = round(clamp(Number(population.diseaseLoad || 0) * 0.92, 0, 1), 3);
    }
    state.disease.byPopulation[populationKey(population.locationId, population.speciesId)] = population.diseaseLoad || 0;
    diseaseUpdates.push({ locationId: population.locationId, speciesId: population.speciesId, risk: round(risk, 3), diseaseLoad: population.diseaseLoad || 0 });
  }
  trimArray(state.disease.outbreaks, config.diseaseMemory);
  state.disease.stats = { ticks: Number(state.disease.stats?.ticks || 0) + 1, outbreaks: outbreaks.length };
  return { outbreaks, updates: diseaseUpdates, stats: { ...state.disease.stats } };
}

function processMigration(world, options = {}, random = null) {
  const state = ensureEcologyState(world, options);
  const config = mergeEcologyOptions(options);
  const events = [];
  const randomContext = random || fallbackRandom();
  const candidates = Object.values(state.populations.byKey || {})
    .filter(pop => pop.pressure > 1.05 || pop.health < 0.35 || pop.diseaseLoad > 0.45)
    .sort((a, b) => b.pressure - a.pressure || a.locationId.localeCompare(b.locationId));
  for (const population of candidates) {
    if (events.length >= Number(config.maxMigrationsPerTick)) break;
    const destinationId = chooseMigrationDestination(world, state, population, config, randomContext);
    if (!destinationId) continue;
    const amount = round(Math.max(0, population.population * Number(config.migrationRate) * migrationPressure(population)), 3);
    if (amount <= 0) continue;
    const fromKey = populationKey(population.locationId, population.speciesId);
    const toKey = populationKey(destinationId, population.speciesId);
    population.population = round(Math.max(0, population.population - amount), 3);
    if (!state.populations.byKey[toKey]) {
      const habitat = state.habitats.byLocation[destinationId];
      const profile = config.speciesProfiles[population.speciesId];
      state.populations.byKey[toKey] = createPopulationRecord(destinationId, population.speciesId, 0, calculateCarryingCapacity(habitat, profile, config));
    }
    state.populations.byKey[toKey].population = round(state.populations.byKey[toKey].population + amount, 3);
    const event = { tick: Number(world.tick || 0), speciesId: population.speciesId, fromLocationId: population.locationId, toLocationId: destinationId, amount };
    events.push(event);
    state.migration.events.push(event);
    state.migration.pressure[fromKey] = round(migrationPressure(population), 3);
  }
  trimArray(state.migration.events, config.migrationMemory);
  rebuildPopulationLocationIndex(state);
  state.migration.stats = { ticks: Number(state.migration.stats?.ticks || 0) + 1, events: events.length, moved: round(events.reduce((sum, event) => sum + event.amount, 0), 3) };
  return { events, stats: { ...state.migration.stats } };
}

function getEcologySummary(world) {
  const state = ensureEcologyState(world);
  return {
    version: state.version,
    habitats: { ...state.habitats.stats },
    populations: { ...state.populations.stats },
    foodWeb: { ...state.foodWeb.stats },
    disease: { ...state.disease.stats },
    migration: { ...state.migration.stats },
  };
}

function createPopulationRecord(locationId, speciesId, population, carryingCapacity) {
  return { locationId, speciesId, population: round(population, 3), carryingCapacity: round(carryingCapacity, 3), pressure: 0, health: 0.75, diseaseLoad: 0, updatedAtTick: 0 };
}

function calculateCarryingCapacity(habitat, profile = {}, options = {}) {
  if (!habitat || !profile) return 0;
  const dietSupport = Object.entries(profile.diet || {}).reduce((sum, [resource, weight]) => sum + Number(habitat[resource] || 0) * Number(weight || 0), 0);
  const suitability = Number(habitat.suitability?.[profile.id] ?? habitatSuitability(habitat, profile));
  const baseCapacity = Number(profile.baseCapacity || 10);
  return Math.max(1, baseCapacity * Math.max(0.05, suitability) + dietSupport * 0.35 - Number(habitat.hazard || 0) * baseCapacity * 0.4 + Number(options.capacityBonus || 0));
}

function habitatSuitability(habitat, profile = {}) {
  const biomeAffinity = (profile.habitats || []).includes(habitat.biome) ? 1 : 0.35;
  const foodFactor = clamp(Number(habitat.food || 0) / 120, 0, 1);
  const waterFactor = clamp(Number(habitat.water || 0) / 100, 0, 1);
  const fertility = Number(habitat.fertility || 0.4);
  const hazardPenalty = Number(habitat.hazard || 0) * 0.55;
  return clamp(biomeAffinity * 0.45 + foodFactor * 0.2 + waterFactor * 0.15 + fertility * 0.25 - hazardPenalty, 0, 1);
}

function calculatePopulationGrowth(population, profile, habitat, pressure, random) {
  const rate = Number(profile.growthRate || 0.02) * DEFAULT_ECOLOGY_OPTIONS.growthRateMultiplier;
  const suitability = Number(habitat.suitability?.[population.speciesId] || 0.3);
  const densityPenalty = Math.max(0, pressure - 0.85) * 0.08;
  const health = Number(population.health || 0.5);
  const noise = 0.85 + random.float(`growth:${population.locationId}:${population.speciesId}`) * 0.3;
  return population.population * (rate * suitability * health * noise - densityPenalty - Number(population.diseaseLoad || 0) * 0.04 - Number(habitat.hazard || 0) * 0.02);
}

function chooseMigrationDestination(world, state, population, config, random) {
  const location = world.locations?.[population.locationId];
  const neighbors = Array.isArray(location?.neighbors) ? location.neighbors : [];
  if (!neighbors.length) return null;
  const profile = config.speciesProfiles[population.speciesId];
  const weighted = neighbors.map(locationId => {
    const habitat = state.habitats.byLocation[locationId];
    if (!habitat) return [locationId, 0];
    const destination = state.populations.byKey[populationKey(locationId, population.speciesId)];
    const capacity = calculateCarryingCapacity(habitat, profile, config);
    const pressure = destination ? destination.population / Math.max(1, capacity) : 0;
    const weight = Math.max(0, Number(habitat.suitability?.[population.speciesId] || 0) * 2 - pressure - habitat.hazard);
    return [locationId, weight];
  }).filter(entry => entry[1] > 0);
  return random.weightedPick(weighted, `migration:${population.locationId}:${population.speciesId}`);
}

function rebuildPopulationLocationIndex(state) {
  state.populations.byLocation = {};
  for (const pop of Object.values(state.populations.byKey || {})) {
    if (pop.population <= 0) continue;
    if (!state.populations.byLocation[pop.locationId]) state.populations.byLocation[pop.locationId] = [];
    if (!state.populations.byLocation[pop.locationId].includes(pop.speciesId)) state.populations.byLocation[pop.locationId].push(pop.speciesId);
  }
  for (const list of Object.values(state.populations.byLocation)) list.sort();
}

function entitiesOfSpeciesAt(world, locationId, speciesId) {
  return Object.values(world.entities || {}).filter(entity => entity.locationId === locationId && (entity.species || entity.meta?.species || 'human') === speciesId && entity.status !== 'dead').length;
}

function inferBiome(location) {
  const text = `${location?.name || ''} ${location?.id || ''}`.toLowerCase();
  if (text.includes('forest')) return 'forest';
  if (text.includes('desert')) return 'desert';
  if (text.includes('mount')) return 'mountain';
  if (text.includes('coast') || text.includes('port')) return 'coast';
  if (text.includes('city') || text.includes('town')) return 'urban';
  return 'plains';
}

function weatherHazard(type, severity) {
  const base = { clear: 0, cloudy: 0.02, rain: 0.04, storm: 0.35, snow: 0.18, drought: 0.35, heatwave: 0.3, cold_snap: 0.25 }[type] || 0;
  return clamp(base + Number(severity || 0) * 0.25, 0, 1);
}

function activeDisasterHazard(world, locationId) {
  return Object.values(world.natural?.disasters?.active || {}).filter(disaster => disaster.locationId === locationId).reduce((sum, disaster) => sum + Number(disaster.severity || 0) * 0.4, 0);
}

function populationKey(locationId, speciesId) { return `${locationId}:${speciesId}`; }
function migrationPressure(population) { return clamp(Math.max(0, Number(population.pressure || 0) - 1) + Math.max(0, 0.45 - Number(population.health || 0)) + Number(population.diseaseLoad || 0), 0, 2); }
function mergeEcologyOptions(options = {}) { return { ...DEFAULT_ECOLOGY_OPTIONS, ...(options || {}), speciesProfiles: { ...DEFAULT_ECOLOGY_OPTIONS.speciesProfiles, ...(options.speciesProfiles || {}) } }; }
function fallbackRandom() { return { float: () => 0.5, chance: probability => Number(probability || 0) >= 0.5, weightedPick: entries => (entries || []).filter(entry => Number(entry[1]) > 0)[0]?.[0] || null }; }
function emptyStats() { return { ticks: 0 }; }
function trimArray(array, limit) { while (Array.isArray(array) && array.length > Number(limit || 0)) array.shift(); }
function average(values) { const filtered = (values || []).filter(Number.isFinite); return filtered.length ? filtered.reduce((sum, value) => sum + value, 0) / filtered.length : 0; }
function clamp(value, min, max) { const number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min; }
function round(value, digits = 3) { const factor = 10 ** digits; return Math.round(Number(value || 0) * factor) / factor; }

module.exports = {
  ECOLOGY_VERSION,
  DEFAULT_ECOLOGY_OPTIONS,
  ensureEcologyState,
  createEcologyState,
  processEcologyTick,
  processHabitats,
  seedEcologyPopulations,
  processPopulations,
  processFoodWeb,
  processDisease,
  processMigration,
  getEcologySummary,
  habitatSuitability,
  calculateCarryingCapacity,
  populationKey,
};
