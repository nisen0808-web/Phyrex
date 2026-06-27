'use strict';

const { createEntity, clamp } = require('./schema');
const { recordLifeEvent, LIFE_EVENT_TYPES } = require('./history-engine');
const { getRelationship, scoreRelationship } = require('./relationship-engine');
const { areSpeciesCompatible, getSpeciesPopulationOptions, applySpeciesDefaultsToEntity } = require('./species-engine');
const { randomChance } = require('./random-engine');
const { nextWorldId } = require('./world-id-engine');
const { emitEvent } = require('./world-engine');

const DEFAULT_POPULATION_OPTIONS = {
  ticksPerYear: 720,
  defaultLifeExpectancy: 72,
  minAdultAge: 18,
  elderAge: 60,
  maxNaturalAge: 110,
  baseBirthChance: 0.015,
  baseMortalityChance: 0.002,
  childMortalityMultiplier: 1.8,
  elderMortalityMultiplier: 4,
  environmentMortalityWeight: 1,
  environmentBirthWeight: 1,
};

const AGE_GROUPS = {
  CHILD: 'child',
  YOUTH: 'youth',
  ADULT: 'adult',
  ELDER: 'elder',
};

function ensurePopulationState(world) {
  if (!world.population) {
    world.population = {
      options: { ...DEFAULT_POPULATION_OPTIONS },
      births: 0,
      deaths: 0,
      lastProcessedTick: null,
      environment: createEmptyEnvironmentSummary(),
      indexes: {
        byAgeGroup: {},
        byGeneration: {},
      },
    };
  }
  if (!world.population.options) world.population.options = { ...DEFAULT_POPULATION_OPTIONS };
  if (!world.population.environment) world.population.environment = createEmptyEnvironmentSummary();
  return world.population;
}

function ensureDemographics(entity, world, input = {}) {
  applySpeciesDefaultsToEntity(world, entity);
  const speciesOptions = getSpeciesPopulationOptions(world, entity.species || 'human');
  if (!entity.demographics) {
    entity.demographics = {
      birthTick: input.birthTick ?? world.tick,
      deathTick: input.deathTick ?? null,
      age: input.age ?? 0,
      ageGroup: input.ageGroup || AGE_GROUPS.CHILD,
      sex: input.sex || pickSex(entity.id),
      generation: input.generation ?? 1,
      fatherId: input.fatherId || null,
      motherId: input.motherId || null,
      childrenIds: Array.isArray(input.childrenIds) ? [...input.childrenIds] : [],
      fertility: input.fertility ?? speciesOptions.fertility ?? 1,
      lifeExpectancy: input.lifeExpectancy || speciesOptions.defaultLifeExpectancy || DEFAULT_POPULATION_OPTIONS.defaultLifeExpectancy,
      familyId: input.familyId || entity.familyId || null,
    };
  }
  entity.demographics.age = calculateAge(world, entity);
  entity.demographics.ageGroup = getAgeGroup(entity.demographics.age, mergePopulationOptionsForEntity(world, entity));
  return entity.demographics;
}

function initializePopulation(world, options = {}) {
  const population = ensurePopulationState(world);
  population.options = { ...DEFAULT_POPULATION_OPTIONS, ...(options || {}) };
  for (const entity of Object.values(world.entities)) ensureDemographics(entity, world, entity.demographics || {});
  rebuildPopulationIndexes(world);
  return population;
}

function processPopulationTick(world, options = {}) {
  const population = ensurePopulationState(world);
  population.options = { ...population.options, ...(options || {}) };

  const births = [];
  const deaths = [];
  const pressures = {};

  for (const entity of Object.values(world.entities)) {
    if (entity.status !== 'alive') continue;
    ensureDemographics(entity, world);
    updateAge(world, entity);
    pressures[entity.id] = calculatePopulationEnvironmentalPressure(world, entity, mergePopulationOptionsForEntity(world, entity));
    if (shouldDieNaturally(world, entity, mergePopulationOptionsForEntity(world, entity), pressures[entity.id])) {
      deaths.push(markNaturalDeath(world, entity, pressures[entity.id]));
    }
  }

  const potentialParents = Object.values(world.entities).filter(entity => entity.status === 'alive' && isAdult(entity, mergePopulationOptionsForEntity(world, entity)));
  for (const parentA of potentialParents) {
    const pressure = pressures[parentA.id] || calculatePopulationEnvironmentalPressure(world, parentA, mergePopulationOptionsForEntity(world, parentA));
    if (!shouldAttemptBirth(world, parentA, mergePopulationOptionsForEntity(world, parentA), pressure)) continue;
    const parentB = findCompatibleParent(world, parentA, potentialParents);
    if (!parentB) continue;
    births.push(createChild(world, parentA, parentB, options.childFactory || {}));
  }

  const environment = summarizePopulationEnvironment(world, pressures);
  population.environment = environment;
  population.births += births.length;
  population.deaths += deaths.length;
  population.lastProcessedTick = world.tick;
  rebuildPopulationIndexes(world);

  return { births, deaths, environment, stats: getPopulationStats(world) };
}

function updateAge(world, entity) {
  const demo = ensureDemographics(entity, world);
  demo.age = calculateAge(world, entity);
  demo.ageGroup = getAgeGroup(demo.age, mergePopulationOptionsForEntity(world, entity));
  return demo.age;
}

function calculateAge(world, entity) {
  const opts = world.population?.options || DEFAULT_POPULATION_OPTIONS;
  const birthTick = entity.demographics?.birthTick ?? world.tick;
  return Math.max(0, Math.floor((world.tick - birthTick) / opts.ticksPerYear));
}

function getAgeGroup(age, options = DEFAULT_POPULATION_OPTIONS) {
  if (age < 13) return AGE_GROUPS.CHILD;
  if (age < options.minAdultAge) return AGE_GROUPS.YOUTH;
  if (age < options.elderAge) return AGE_GROUPS.ADULT;
  return AGE_GROUPS.ELDER;
}

function isAdult(entity, options = DEFAULT_POPULATION_OPTIONS) {
  const age = entity.demographics?.age || 0;
  return entity.status === 'alive' && age >= options.minAdultAge && age < options.elderAge;
}

function shouldDieNaturally(world, entity, options, pressure = null) {
  const age = entity.demographics?.age || 0;
  const expectancy = entity.demographics?.lifeExpectancy || options.defaultLifeExpectancy;
  const environment = pressure || calculatePopulationEnvironmentalPressure(world, entity, options);
  let chance = options.baseMortalityChance * (options.mortalityMultiplier || 1);
  if (age < 5) chance *= options.childMortalityMultiplier;
  if (age >= options.elderAge) chance *= options.elderMortalityMultiplier + (age - options.elderAge) * 0.15;
  if (age > expectancy) chance += (age - expectancy) * 0.015;
  if (age > options.maxNaturalAge) chance = 1;
  chance = (chance * environment.mortalityMultiplier) + environment.mortalityBonus;
  return randomChance(world, clamp(chance, 0, 1), `population.mortality:${entity.id}`);
}

function markNaturalDeath(world, entity, pressure = null) {
  entity.status = 'dead';
  entity.demographics.deathTick = world.tick;
  recordLifeEvent(world, {
    entityId: entity.id,
    type: LIFE_EVENT_TYPES.DEATH,
    title: 'natural death',
    summary: `${entity.name || entity.id} died naturally at age ${entity.demographics.age}.`,
    importance: 180,
    locationId: entity.locationId,
    tags: ['death', 'population'],
    payload: { age: entity.demographics.age, reason: 'natural', pressure },
  });
  emitEvent(world, {
    type: 'population.death',
    tick: world.tick,
    actorIds: [entity.id],
    locationId: entity.locationId,
    payload: { reason: 'natural', age: entity.demographics.age, pressure },
    tags: ['population', 'death'],
  });
  return entity;
}

function shouldAttemptBirth(world, parent, options, pressure = null) {
  const fertility = clamp(parent.demographics?.fertility ?? options.fertility ?? 1, 0, 3);
  const age = parent.demographics?.age || 0;
  const environment = pressure || calculatePopulationEnvironmentalPressure(world, parent, options);
  let chance = options.baseBirthChance * fertility * (options.birthChanceMultiplier || 1);
  if (age < options.minAdultAge || age > 45) chance *= 0.2;
  if (age >= 25 && age <= 35) chance *= 1.4;
  chance *= environment.birthMultiplier;
  return randomChance(world, clamp(chance, 0, 0.2), `population.birth:${parent.id}`);
}

function calculatePopulationEnvironmentalPressure(world, entity, options = DEFAULT_POPULATION_OPTIONS) {
  const locationId = entity.locationId;
  const location = world.locations?.[locationId] || {};
  const weather = world.natural?.weather?.byLocation?.[locationId] || { type: 'clear', severity: 0 };
  const habitat = world.ecology?.habitats?.byLocation?.[locationId] || null;
  const speciesId = entity.species || entity.meta?.species || 'human';
  const population = world.ecology?.populations?.byKey?.[`${locationId}:${speciesId}`] || null;
  const resources = location.resources || {};
  const weatherRisk = weatherMortalityRisk(weather.type, weather.severity);
  const disasterRisk = activeDisasterRisk(world, locationId);
  const resourceRisk = calculateResourceRisk(resources);
  const diseaseRisk = clamp(Number(population?.diseaseLoad || 0), 0, 1);
  const overcrowdingRisk = clamp(Math.max(0, Number(population?.pressure || 0) - 1), 0, 2) / 2;
  const habitatRisk = habitat ? clamp(1 - Number(habitat.suitability?.[speciesId] ?? 0.5), 0, 1) * 0.35 : 0.1;
  const ecologyHealth = population ? clamp(Number(population.health ?? 0.75), 0, 1) : 0.75;
  const mortalityWeight = Number(options.environmentMortalityWeight ?? 1);
  const birthWeight = Number(options.environmentBirthWeight ?? 1);
  const totalRisk = clamp(
    weatherRisk * 0.18
    + disasterRisk * 0.25
    + resourceRisk * 0.2
    + diseaseRisk * 0.18
    + overcrowdingRisk * 0.12
    + habitatRisk * 0.07,
    0,
    1,
  );
  const mortalityMultiplier = clamp(1 + totalRisk * 4 * mortalityWeight + (1 - ecologyHealth) * 0.35, 0.25, 8);
  const mortalityBonus = clamp((disasterRisk * 0.02 + diseaseRisk * 0.012 + resourceRisk * 0.01) * mortalityWeight, 0, 0.12);
  const birthMultiplier = clamp((1 - totalRisk * 0.85 * birthWeight) * (0.75 + ecologyHealth * 0.35), 0.05, 1.5);
  return {
    locationId,
    speciesId,
    weatherRisk: round(weatherRisk, 3),
    disasterRisk: round(disasterRisk, 3),
    resourceRisk: round(resourceRisk, 3),
    diseaseRisk: round(diseaseRisk, 3),
    overcrowdingRisk: round(overcrowdingRisk, 3),
    habitatRisk: round(habitatRisk, 3),
    ecologyHealth: round(ecologyHealth, 3),
    totalRisk: round(totalRisk, 3),
    mortalityMultiplier: round(mortalityMultiplier, 3),
    mortalityBonus: round(mortalityBonus, 4),
    birthMultiplier: round(birthMultiplier, 3),
  };
}

function summarizePopulationEnvironment(world, pressures) {
  const values = Object.values(pressures || {});
  if (!values.length) return createEmptyEnvironmentSummary(world.tick);
  const highRisk = values.filter(item => item.totalRisk >= 0.5 || item.mortalityMultiplier >= 2).length;
  const byLocation = {};
  for (const pressure of values) {
    if (!byLocation[pressure.locationId]) byLocation[pressure.locationId] = { entities: 0, totalRisk: 0, mortalityMultiplier: 0, birthMultiplier: 0 };
    const bucket = byLocation[pressure.locationId];
    bucket.entities += 1;
    bucket.totalRisk += pressure.totalRisk;
    bucket.mortalityMultiplier += pressure.mortalityMultiplier;
    bucket.birthMultiplier += pressure.birthMultiplier;
  }
  for (const bucket of Object.values(byLocation)) {
    bucket.averageRisk = round(bucket.totalRisk / bucket.entities, 3);
    bucket.averageMortalityMultiplier = round(bucket.mortalityMultiplier / bucket.entities, 3);
    bucket.averageBirthMultiplier = round(bucket.birthMultiplier / bucket.entities, 3);
    delete bucket.totalRisk;
    delete bucket.mortalityMultiplier;
    delete bucket.birthMultiplier;
  }
  return {
    tick: Number(world.tick || 0),
    entities: values.length,
    highRisk,
    averageRisk: round(averageValues(values.map(item => item.totalRisk)), 3),
    averageMortalityMultiplier: round(averageValues(values.map(item => item.mortalityMultiplier)), 3),
    averageBirthMultiplier: round(averageValues(values.map(item => item.birthMultiplier)), 3),
    byLocation,
  };
}

function createEmptyEnvironmentSummary(tick = null) {
  return {
    tick,
    entities: 0,
    highRisk: 0,
    averageRisk: 0,
    averageMortalityMultiplier: 1,
    averageBirthMultiplier: 1,
    byLocation: {},
  };
}

function weatherMortalityRisk(type, severity) {
  const base = { clear: 0, cloudy: 0.02, rain: 0.06, storm: 0.6, snow: 0.25, drought: 0.55, heatwave: 0.5, cold_snap: 0.45 }[type] || 0.05;
  return clamp(base + Number(severity || 0) * 0.35, 0, 1);
}

function activeDisasterRisk(world, locationId) {
  return clamp(Object.values(world.natural?.disasters?.active || {})
    .filter(disaster => disaster.locationId === locationId)
    .reduce((sum, disaster) => sum + Number(disaster.severity || 0) * 0.65, 0), 0, 1);
}

function calculateResourceRisk(resources = {}) {
  const food = Number(resources.food || 0);
  const water = Number(resources.water || 0);
  const foodRisk = food <= 0 ? 1 : food < 20 ? 0.65 : food < 60 ? 0.25 : 0;
  const waterRisk = water <= 0 ? 1 : water < 20 ? 0.75 : water < 60 ? 0.3 : 0;
  return clamp(foodRisk * 0.55 + waterRisk * 0.45, 0, 1);
}

function findCompatibleParent(world, parent, pool) {
  const candidates = pool.filter(other => {
    if (other.id === parent.id) return false;
    if (other.locationId !== parent.locationId) return false;
    if (other.demographics?.sex === parent.demographics?.sex) return false;
    return areSpeciesCompatible(world, parent.species || 'human', other.species || 'human');
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const affinity = relationshipAffinity(world, parent.id, b.id) - relationshipAffinity(world, parent.id, a.id);
    return affinity || String(a.id).localeCompare(String(b.id));
  });
  const best = candidates[0];
  return relationshipAffinity(world, parent.id, best.id) >= -20 ? best : null;
}

function relationshipAffinity(world, fromId, toId) {
  getRelationship(world, fromId, toId);
  const score = scoreRelationship(world, fromId, toId);
  return score.cooperation - score.hostility;
}

function createChild(world, parentA, parentB, childInput = {}) {
  const generation = Math.max(parentA.demographics?.generation || 1, parentB.demographics?.generation || 1) + 1;
  const familyId = parentA.demographics?.familyId || parentB.demographics?.familyId || null;
  const species = childInput.species || parentA.species || parentB.species || 'human';
  const child = createEntity({
    id: childInput.id || nextWorldId(world, 'entity', 'population.child'),
    name: childInput.name || `Child ${world.tick}`,
    type: childInput.type || 'agent',
    locationId: childInput.locationId || parentA.locationId || parentB.locationId,
    factionId: childInput.factionId || parentA.factionId || parentB.factionId || null,
    traits: inheritTraits(parentA, parentB, childInput.traits || {}),
    stats: childInput.stats || { health: 40, maxHealth: 40, energy: 60, maxEnergy: 60, power: 1, defense: 1, speed: 5, intelligence: 5, social: 5 },
    resources: childInput.resources || {},
    meta: { ...(childInput.meta || {}), age: 0, species },
  });
  child.species = species;
  applySpeciesDefaultsToEntity(world, child);
  child.demographics = {
    birthTick: world.tick,
    deathTick: null,
    age: 0,
    ageGroup: AGE_GROUPS.CHILD,
    sex: childInput.sex || pickSex(child.id),
    generation,
    fatherId: parentA.demographics?.sex === 'male' ? parentA.id : parentB.id,
    motherId: parentA.demographics?.sex === 'female' ? parentA.id : parentB.id,
    childrenIds: [],
    fertility: childInput.fertility ?? average(parentA.demographics?.fertility || 1, parentB.demographics?.fertility || 1),
    lifeExpectancy: childInput.lifeExpectancy || average(parentA.demographics?.lifeExpectancy || 72, parentB.demographics?.lifeExpectancy || 72),
    familyId,
  };

  world.entities[child.id] = child;
  parentA.demographics.childrenIds.push(child.id);
  parentB.demographics.childrenIds.push(child.id);

  recordLifeEvent(world, {
    entityId: child.id,
    type: LIFE_EVENT_TYPES.BIRTH,
    title: 'born into the world',
    summary: `${child.name} was born as generation ${generation}.`,
    importance: 100,
    participants: [child.id, parentA.id, parentB.id],
    locationId: child.locationId,
    tags: ['birth', 'population'],
    payload: { fatherId: child.demographics.fatherId, motherId: child.demographics.motherId, generation, familyId, species },
  });

  emitEvent(world, {
    type: 'population.birth',
    tick: world.tick,
    actorIds: [child.id, parentA.id, parentB.id],
    locationId: child.locationId,
    payload: { childId: child.id, parentIds: [parentA.id, parentB.id], generation, familyId, species },
    tags: ['population', 'birth'],
  });

  return child;
}

function inheritTraits(parentA, parentB, patch = {}) {
  const traits = { ...patch };
  const keys = new Set([...Object.keys(parentA.traits || {}), ...Object.keys(parentB.traits || {})]);
  for (const key of keys) {
    const a = Number(parentA.traits?.[key]);
    const b = Number(parentB.traits?.[key]);
    if (Number.isFinite(a) && Number.isFinite(b)) traits[key] = Math.round(average(a, b));
  }
  return traits;
}

function mergePopulationOptionsForEntity(world, entity) {
  const base = world.population?.options || DEFAULT_POPULATION_OPTIONS;
  const speciesOptions = getSpeciesPopulationOptions(world, entity.species || entity.meta?.species || 'human');
  return { ...base, ...speciesOptions };
}

function rebuildPopulationIndexes(world) {
  const population = ensurePopulationState(world);
  population.indexes.byAgeGroup = {};
  population.indexes.byGeneration = {};
  for (const entity of Object.values(world.entities)) {
    ensureDemographics(entity, world);
    addIndex(population.indexes.byAgeGroup, entity.demographics.ageGroup, entity.id);
    addIndex(population.indexes.byGeneration, String(entity.demographics.generation), entity.id);
  }
}

function getPopulationStats(world) {
  ensurePopulationState(world);
  const entities = Object.values(world.entities);
  const alive = entities.filter(e => e.status === 'alive');
  const dead = entities.filter(e => e.status === 'dead');
  const byAgeGroup = {};
  for (const entity of alive) {
    const group = entity.demographics?.ageGroup || 'unknown';
    byAgeGroup[group] = (byAgeGroup[group] || 0) + 1;
  }
  return {
    total: entities.length,
    alive: alive.length,
    dead: dead.length,
    births: world.population.births,
    deaths: world.population.deaths,
    byAgeGroup,
    generations: Object.keys(world.population.indexes.byGeneration).length,
    environment: world.population.environment || createEmptyEnvironmentSummary(),
  };
}

function addIndex(index, key, value) {
  if (!index[key]) index[key] = [];
  if (!index[key].includes(value)) index[key].push(value);
}

function pickSex(seed) {
  const n = String(seed).split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return n % 2 === 0 ? 'female' : 'male';
}

function average(a, b) {
  return (Number(a || 0) + Number(b || 0)) / 2;
}

function averageValues(values) {
  const filtered = (values || []).filter(Number.isFinite);
  return filtered.length ? filtered.reduce((sum, value) => sum + value, 0) / filtered.length : 0;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

module.exports = {
  DEFAULT_POPULATION_OPTIONS,
  AGE_GROUPS,
  ensurePopulationState,
  ensureDemographics,
  initializePopulation,
  processPopulationTick,
  updateAge,
  calculateAge,
  getAgeGroup,
  isAdult,
  createChild,
  markNaturalDeath,
  calculatePopulationEnvironmentalPressure,
  summarizePopulationEnvironment,
  rebuildPopulationIndexes,
  getPopulationStats,
};