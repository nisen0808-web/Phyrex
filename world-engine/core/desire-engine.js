'use strict';

const { assignGoal } = require('./goal-engine');
const { calculateIdentityScore } = require('./identity-engine');
const { getMemories } = require('./memory-engine');
const { getEntityContracts, CONTRACT_STATUS } = require('./contract-engine');

const DESIRE_TYPES = {
  WEALTH: 'wealth',
  POWER: 'power',
  RECOGNITION: 'recognition',
  SECURITY: 'security',
  LOVE: 'love',
  REVENGE: 'revenge',
  EXPLORATION: 'exploration',
  KNOWLEDGE: 'knowledge',
  FAITH: 'faith',
  FAMILY: 'family',
  FREEDOM: 'freedom',
};

const FEAR_TYPES = {
  DEATH: 'death',
  POVERTY: 'poverty',
  ISOLATION: 'isolation',
  HUMILIATION: 'humiliation',
  CONTROL: 'control',
  BETRAYAL: 'betrayal',
  OBLIVION: 'oblivion',
};

const DEFAULT_DESIRE_OPTIONS = {
  driftRate: 0.04,
  goalThreshold: 70,
  fearGoalThreshold: 65,
  environmentGoalThreshold: 0.35,
  happinessBaseline: 50,
  maxGeneratedGoalsPerTick: 2,
  maxEnvironmentGoalsPerTick: 2,
};

function ensureDesireState(world) {
  if (!world.desires) world.desires = { byEntity: {}, stats: { initialized: 0, updated: 0, goalsGenerated: 0, environmentGoalsGenerated: 0 } };
  if (world.desires.stats.environmentGoalsGenerated === undefined) world.desires.stats.environmentGoalsGenerated = 0;
  return world.desires;
}

function ensureEntityDesires(world, entityId, input = {}) {
  const entity = world.entities[entityId];
  if (!entity) throw new Error(`Missing entity ${entityId}`);
  const state = ensureDesireState(world);
  if (!state.byEntity[entityId]) {
    state.byEntity[entityId] = {
      entityId,
      createdAt: world.tick,
      updatedAt: world.tick,
      desires: seedDesiresFromEntity(entity, input.desires || {}),
      fears: seedFearsFromEntity(entity, input.fears || {}),
      happiness: input.happiness ?? DEFAULT_DESIRE_OPTIONS.happinessBaseline,
      satisfaction: {},
      dominantDesire: null,
      dominantFear: null,
      environment: createEmptyEnvironmentSignal(entity.locationId),
      generatedGoalIds: [],
      memory: [],
    };
    state.stats.initialized += 1;
  }
  return state.byEntity[entityId];
}

function processDesireTick(world, options = {}) {
  const config = { ...DEFAULT_DESIRE_OPTIONS, ...(options || {}) };
  const updated = [];
  const generatedGoals = [];
  for (const entity of Object.values(world.entities || {})) {
    if (entity.status !== 'alive') continue;
    ensureEntityDesires(world, entity.id);
    updateDesireProfile(world, entity.id, config);
    const goals = generateGoalsFromDesires(world, entity.id, config);
    updated.push(entity.id);
    generatedGoals.push(...goals);
  }
  const state = ensureDesireState(world);
  state.stats.updated += updated.length;
  state.stats.goalsGenerated += generatedGoals.length;
  state.stats.environmentGoalsGenerated += generatedGoals.filter(goal => goal.tags?.includes('environment_generated')).length;
  return { updated, generatedGoals, stats: getDesireStats(world) };
}

function updateDesireProfile(world, entityId, options = {}) {
  const entity = world.entities[entityId];
  const profile = ensureEntityDesires(world, entityId);
  const identityScore = safeIdentityScore(world, entityId);
  const memories = safeMemories(world, entityId);
  const contracts = safeContracts(world, entityId);
  const relationSummary = summarizeRelationships(world, entityId);
  const environment = calculateEntityEnvironmentSignal(world, entity);
  const resources = entity.resources || {};
  const stats = entity.stats || {};

  nudge(profile.desires, DESIRE_TYPES.WEALTH, Number(resources.currency || 0) < 100 ? 0.8 : -0.1);
  nudge(profile.desires, DESIRE_TYPES.POWER, identityScore.authority < 20 ? Number(entity.traits?.ambition || 50) * 0.01 : -0.05);
  nudge(profile.desires, DESIRE_TYPES.RECOGNITION, identityScore.prestige < 30 ? Number(entity.traits?.ambition || 50) * 0.008 : -0.05);
  nudge(profile.desires, DESIRE_TYPES.SECURITY, stats.health < (stats.maxHealth || 100) * 0.6 ? 1.5 : -0.05);
  nudge(profile.desires, DESIRE_TYPES.SECURITY, environment.totalRisk * 2.4 + environment.disasterRisk * 2.2 + environment.cityRisk * 1.3);
  nudge(profile.desires, DESIRE_TYPES.WEALTH, environment.economyRisk * 1.5 + environment.pricePressure * 1.2);
  nudge(profile.desires, DESIRE_TYPES.FREEDOM, environment.cityRisk > 0.55 ? 1.1 : -0.03);
  nudge(profile.desires, DESIRE_TYPES.EXPLORATION, environment.migrationAppeal > 0.65 ? 0.7 : -0.02);
  nudge(profile.desires, DESIRE_TYPES.LOVE, relationSummary.affection < 10 ? 0.4 : -0.05);
  nudge(profile.desires, DESIRE_TYPES.REVENGE, relationSummary.hatred > 20 ? relationSummary.hatred * 0.01 : -0.08);
  nudge(profile.desires, DESIRE_TYPES.FREEDOM, contracts.obligated > contracts.controlled ? 1 : -0.05);
  nudge(profile.desires, DESIRE_TYPES.FAMILY, entity.familyId || entity.demographics?.familyId ? -0.02 : 0.2);

  if (hasMemoryType(memories, 'trauma')) {
    nudge(profile.fears, FEAR_TYPES.DEATH, 0.8);
    nudge(profile.fears, FEAR_TYPES.BETRAYAL, 0.3);
    nudge(profile.desires, DESIRE_TYPES.SECURITY, 0.6);
  }
  if (hasMemoryType(memories, 'achievement')) {
    nudge(profile.desires, DESIRE_TYPES.RECOGNITION, 0.3);
    nudge(profile.fears, FEAR_TYPES.OBLIVION, 0.2);
  }

  nudge(profile.fears, FEAR_TYPES.POVERTY, Number(resources.currency || 0) < 20 ? 1 : -0.05);
  nudge(profile.fears, FEAR_TYPES.POVERTY, environment.economyRisk * 1.7 + environment.resourceRisk * 1.2);
  nudge(profile.fears, FEAR_TYPES.DEATH, stats.health < (stats.maxHealth || 100) * 0.4 ? 1.2 : -0.03);
  nudge(profile.fears, FEAR_TYPES.DEATH, environment.disasterRisk * 2.5 + environment.totalRisk * 1.3);
  nudge(profile.fears, FEAR_TYPES.ISOLATION, relationSummary.relationshipCount < 2 ? 0.4 : -0.03);
  nudge(profile.fears, FEAR_TYPES.CONTROL, contracts.obligated > 80 ? 0.8 : -0.03);
  nudge(profile.fears, FEAR_TYPES.HUMILIATION, identityScore.prestige < -10 ? 0.6 : -0.03);

  driftMap(profile.desires, options.driftRate);
  driftMap(profile.fears, options.driftRate * 0.5);

  profile.environment = environment;
  profile.happiness = calculateHappiness(world, entityId, { identityScore, memories, contracts, relationSummary, environment });
  profile.dominantDesire = maxKey(profile.desires);
  profile.dominantFear = maxKey(profile.fears);
  profile.updatedAt = world.tick;
  entity.meta = { ...(entity.meta || {}), happiness: profile.happiness, dominantDesire: profile.dominantDesire, dominantFear: profile.dominantFear, environmentPressure: environment.totalRisk };
  recordDesireMemory(world, profile, 'desire.updated', { dominantDesire: profile.dominantDesire, dominantFear: profile.dominantFear, happiness: profile.happiness, environmentRisk: environment.totalRisk });
  return profile;
}

function generateGoalsFromDesires(world, entityId, options = {}) {
  const entity = world.entities[entityId];
  const profile = ensureEntityDesires(world, entityId);
  const generated = [];
  generated.push(...generateEnvironmentGoals(world, entity, profile, options));
  const sortedDesires = Object.entries(profile.desires).sort((a, b) => b[1] - a[1]);
  const sortedFears = Object.entries(profile.fears).sort((a, b) => b[1] - a[1]);
  for (const [desire, value] of sortedDesires) {
    if (generated.length >= options.maxGeneratedGoalsPerTick + options.maxEnvironmentGoalsPerTick) break;
    if (value < options.goalThreshold) continue;
    const goalInput = desireToGoal(entity, desire, value);
    if (!goalInput || hasActiveGoal(entity, goalInput.type, goalInput.payload)) continue;
    const goal = assignGoal(world, entityId, { ...goalInput, tags: [...(goalInput.tags || []), 'desire_generated'] });
    profile.generatedGoalIds.push(goal.id);
    generated.push(goal);
  }
  for (const [fear, value] of sortedFears) {
    if (generated.length >= options.maxGeneratedGoalsPerTick + options.maxEnvironmentGoalsPerTick) break;
    if (value < options.fearGoalThreshold) continue;
    const goalInput = fearToGoal(entity, fear, value);
    if (!goalInput || hasActiveGoal(entity, goalInput.type, goalInput.payload)) continue;
    const goal = assignGoal(world, entityId, { ...goalInput, tags: [...(goalInput.tags || []), 'fear_generated'] });
    profile.generatedGoalIds.push(goal.id);
    generated.push(goal);
  }
  if (generated.length) recordDesireMemory(world, profile, 'desire.goals_generated', { goalIds: generated.map(goal => goal.id) });
  return generated;
}

function generateEnvironmentGoals(world, entity, profile, options = {}) {
  const environment = profile.environment || calculateEntityEnvironmentSignal(world, entity);
  if (environment.totalRisk < Number(options.environmentGoalThreshold ?? DEFAULT_DESIRE_OPTIONS.environmentGoalThreshold)) return [];
  const candidates = [];
  const safeLocation = environment.safeLocationId;
  if ((environment.disasterRisk >= 0.45 || environment.cityRisk >= 0.72) && safeLocation && safeLocation !== entity.locationId) {
    candidates.push({ type: 'seek_shelter', priority: clamp(82 + environment.disasterRisk * 20 + environment.cityRisk * 10, 0, 100), payload: { targetLocationId: safeLocation, reason: 'environment_risk' } });
  }
  if (environment.cityRisk >= 0.58 && environment.migrationAppeal <= 0.45 && safeLocation && safeLocation !== entity.locationId) {
    candidates.push({ type: 'migrate', priority: clamp(70 + environment.cityRisk * 25, 0, 100), payload: { targetLocationId: safeLocation, reason: 'city_pressure' } });
  }
  if (environment.resourceRisk >= 0.42 || environment.pricePressure >= 0.55) {
    candidates.push({ type: 'stockpile_resource', priority: clamp(68 + environment.resourceRisk * 25 + environment.pricePressure * 10, 0, 100), payload: { resource: 'food', amount: 12, gatherAmount: 4 } });
  }
  if (environment.economyRisk >= 0.45 || environment.localIndustryStalled) {
    candidates.push({ type: 'find_work', priority: clamp(60 + environment.economyRisk * 30, 0, 100), payload: { amount: 80, reason: 'economic_pressure' } });
  }
  if (environment.cityRisk >= 0.42 && environment.cityId) {
    candidates.push({ type: 'support_city', priority: clamp(52 + environment.cityRisk * 22, 0, 100), payload: { cityId: environment.cityId, targetRisk: 0.35, resource: 'service' } });
  }
  const generated = [];
  for (const goalInput of candidates.sort((a, b) => b.priority - a.priority)) {
    if (generated.length >= Number(options.maxEnvironmentGoalsPerTick ?? DEFAULT_DESIRE_OPTIONS.maxEnvironmentGoalsPerTick)) break;
    if (hasActiveGoal(entity, goalInput.type, goalInput.payload)) continue;
    const goal = assignGoal(world, entity.id, { ...goalInput, tags: ['environment_generated'] });
    profile.generatedGoalIds.push(goal.id);
    generated.push(goal);
  }
  return generated;
}

function desireToGoal(entity, desire, value) {
  if (desire === DESIRE_TYPES.WEALTH) return { type: 'gain_resources', priority: clamp(50 + value * 0.3, 0, 100), payload: { resource: 'currency', amount: 200 } };
  if (desire === DESIRE_TYPES.POWER || desire === DESIRE_TYPES.RECOGNITION) return { type: 'gain_power', priority: clamp(45 + value * 0.35, 0, 100), payload: { power: Math.max(100, Number(entity.stats?.power || 0) * 2) } };
  if (desire === DESIRE_TYPES.SECURITY) return { type: 'survive', priority: clamp(60 + value * 0.25, 0, 100) };
  if (desire === DESIRE_TYPES.FAMILY) return { type: 'build_relationship', priority: clamp(35 + value * 0.2, 0, 100), payload: { reason: 'family' } };
  return null;
}

function fearToGoal(entity, fear, value) {
  if (fear === FEAR_TYPES.DEATH) return { type: 'recover', priority: clamp(60 + value * 0.3, 0, 100) };
  if (fear === FEAR_TYPES.POVERTY) return { type: 'gain_resources', priority: clamp(55 + value * 0.2, 0, 100), payload: { resource: 'currency', amount: 100 } };
  if (fear === FEAR_TYPES.CONTROL) return { type: 'gain_power', priority: clamp(50 + value * 0.25, 0, 100), payload: { power: Math.max(80, Number(entity.stats?.power || 0) * 2) } };
  return null;
}

function calculateHappiness(world, entityId, context = {}) {
  const entity = world.entities[entityId];
  if (!entity) return 0;
  const resources = entity.resources || {};
  const stats = entity.stats || {};
  const profile = ensureEntityDesires(world, entityId);
  const environment = context.environment || profile.environment || createEmptyEnvironmentSignal(entity.locationId);
  const healthScore = clamp((stats.health || 0) / Math.max(1, stats.maxHealth || 100) * 25, 0, 25);
  const wealthScore = clamp(Math.log10(Math.max(1, Number(resources.currency || 0))) * 6, 0, 20);
  const relationshipScore = clamp((context.relationSummary?.affection || 0) * 0.1 + (context.relationSummary?.trust || 0) * 0.08, -20, 20);
  const prestigeScore = clamp((context.identityScore?.prestige || 0) * 0.05, -15, 15);
  const fearPenalty = average(Object.values(profile.fears)) * 0.2;
  const obligationPenalty = clamp((context.contracts?.obligated || 0) * 0.05, 0, 10);
  const environmentPenalty = environment.totalRisk * 22 + environment.disasterRisk * 10 + environment.pricePressure * 6;
  return clamp(DEFAULT_DESIRE_OPTIONS.happinessBaseline + healthScore + wealthScore + relationshipScore + prestigeScore - fearPenalty - obligationPenalty - environmentPenalty, 0, 100);
}

function calculateEntityEnvironmentSignal(world, entity) {
  const locationId = entity.locationId;
  const cityId = firstCityIdAt(world, locationId);
  const city = cityId ? world.cities?.byId?.[cityId] : null;
  const cityPressure = cityId ? world.cities?.pressure?.bySettlement?.[cityId] : null;
  const economy = world.economy?.environment;
  const localIndustries = Object.values(world.economy?.industries || {}).filter(industry => industry.locationId === locationId);
  const weather = world.natural?.weather?.byLocation?.[locationId] || { type: 'clear', severity: 0 };
  const populationRisk = Number(world.population?.environment?.byLocation?.[locationId]?.averageRisk ?? world.population?.environment?.averageRisk ?? 0);
  const cityRisk = Number(cityPressure?.riskScore ?? city?.risk ?? world.cities?.pressure?.averageRisk ?? 0);
  const migrationAppeal = Number(cityPressure?.migrationAppeal ?? city?.migrationAppeal ?? 50) / 100;
  const economyRisk = Number(economy?.averageRisk || 0);
  const pricePressure = Number(economy?.averagePricePressure || 0);
  const disasterRisk = clamp(weatherRiskScore(weather.type, weather.severity) + activeDisasterRisk(world, locationId), 0, 1);
  const resourceRisk = localResourceRisk(world, locationId);
  const localIndustryStalled = localIndustries.some(industry => industry.status === 'stalled');
  const totalRisk = clamp(cityRisk * 0.24 + economyRisk * 0.18 + pricePressure * 0.12 + populationRisk * 0.16 + disasterRisk * 0.2 + resourceRisk * 0.1, 0, 1);
  return { locationId, cityId, cityRisk: round(cityRisk), economyRisk: round(economyRisk), pricePressure: round(pricePressure), populationRisk: round(populationRisk), disasterRisk: round(disasterRisk), resourceRisk: round(resourceRisk), migrationAppeal: round(migrationAppeal), localIndustryStalled, safeLocationId: findSaferLocation(world, locationId), totalRisk: round(totalRisk) };
}

function createEmptyEnvironmentSignal(locationId = null) { return { locationId, cityId: null, cityRisk: 0, economyRisk: 0, pricePressure: 0, populationRisk: 0, disasterRisk: 0, resourceRisk: 0, migrationAppeal: 0.5, localIndustryStalled: false, safeLocationId: null, totalRisk: 0 }; }
function firstCityIdAt(world, locationId) { return (world.cities?.indexes?.byLocation?.[locationId] || [])[0] || Object.values(world.cities?.byId || {}).find(city => city.locationId === locationId)?.id || null; }
function findSaferLocation(world, currentLocationId) { const candidates = Object.values(world.locations || {}).map(location => ({ id: location.id, risk: locationEnvironmentRisk(world, location.id) })).sort((a, b) => a.risk - b.risk || a.id.localeCompare(b.id)); return candidates.find(candidate => candidate.id !== currentLocationId && candidate.risk < locationEnvironmentRisk(world, currentLocationId))?.id || candidates[0]?.id || null; }
function locationEnvironmentRisk(world, locationId) { const cityId = firstCityIdAt(world, locationId); const cityRisk = Number((cityId && world.cities?.pressure?.bySettlement?.[cityId]?.riskScore) ?? (cityId && world.cities?.byId?.[cityId]?.risk) ?? 0); const populationRisk = Number(world.population?.environment?.byLocation?.[locationId]?.averageRisk ?? 0); const weather = world.natural?.weather?.byLocation?.[locationId] || { type: 'clear', severity: 0 }; return clamp(cityRisk * 0.4 + populationRisk * 0.25 + weatherRiskScore(weather.type, weather.severity) * 0.25 + localResourceRisk(world, locationId) * 0.1, 0, 1); }
function weatherRiskScore(type, severity) { const base = { clear: 0, cloudy: 0.02, rain: 0.06, storm: 0.55, snow: 0.25, drought: 0.6, heatwave: 0.55, cold_snap: 0.45 }[type] || 0.03; return clamp(base + Number(severity || 0) * 0.3, 0, 1); }
function activeDisasterRisk(world, locationId) { return clamp(Object.values(world.natural?.disasters?.active || {}).filter(disaster => disaster.locationId === locationId).reduce((sum, disaster) => sum + Number(disaster.severity || 0) * 0.55, 0), 0, 1); }
function localResourceRisk(world, locationId) { const resources = world.locations?.[locationId]?.resources || {}; const food = Number(resources.food || 0); const water = Number(resources.water || 0); const foodRisk = food <= 0 ? 1 : food < 20 ? 0.65 : food < 80 ? 0.25 : 0; const waterRisk = water <= 0 ? 1 : water < 20 ? 0.75 : water < 80 ? 0.3 : 0; return clamp(foodRisk * 0.55 + waterRisk * 0.45, 0, 1); }

function seedDesiresFromEntity(entity, patch = {}) { const ambition = Number(entity.traits?.ambition || 50); const social = Number(entity.stats?.social || entity.traits?.social || 50); const intelligence = Number(entity.stats?.intelligence || 50); return normalizeMap({ wealth: 35 + ambition * 0.2, power: 25 + ambition * 0.35, recognition: 20 + ambition * 0.25, security: 45, love: 25 + social * 0.25, revenge: 5, exploration: 20 + intelligence * 0.15, knowledge: 20 + intelligence * 0.2, faith: 15, family: 30, freedom: 35, ...patch }); }
function seedFearsFromEntity(_entity, patch = {}) { return normalizeMap({ death: 40, poverty: 25, isolation: 20, humiliation: 20, control: 25, betrayal: 15, oblivion: 20, ...patch }); }
function safeIdentityScore(world, entityId) { try { return calculateIdentityScore(world, entityId); } catch (_) { return { authority: 0, obligation: 0, prestige: 0, rank: 0 }; } }
function safeMemories(world, entityId) { try { return getMemories(world, 'entity', entityId); } catch (_) { return []; } }
function safeContracts(world, entityId) { try { const contracts = getEntityContracts(world, entityId, { status: CONTRACT_STATUS.ACTIVE }); return contracts.reduce((acc, contract) => { if (contract.controllerId === entityId) acc.controlled += contract.authority; if (contract.subjectId === entityId) acc.obligated += contract.authority; return acc; }, { controlled: 0, obligated: 0 }); } catch (_) { return { controlled: 0, obligated: 0 }; } }
function summarizeRelationships(world, entityId) { const out = { affection: 0, trust: 0, hatred: 0, fear: 0, relationshipCount: 0 }; for (const [key, relation] of Object.entries(world.relationships || {})) { const [fromId, toId] = key.split('->'); if (fromId !== entityId && toId !== entityId) continue; out.affection += Number(relation.affection || 0); out.trust += Number(relation.trust || 0); out.hatred += Number(relation.hatred || 0); out.fear += Number(relation.fear || 0); out.relationshipCount += 1; } return out; }
function hasMemoryType(memories, type) { return memories.some(memory => memory.type === type); }
function hasActiveGoal(entity, type, payload = {}) { return (entity.goals || []).some(goal => { if (goal.type !== type || goal.status !== 'active') return false; if (payload.resource && goal.payload?.resource !== payload.resource) return false; if (payload.targetLocationId && goal.payload?.targetLocationId !== payload.targetLocationId) return false; if (payload.cityId && goal.payload?.cityId !== payload.cityId) return false; return true; }); }
function recordDesireMemory(world, profile, type, payload = {}) { const memory = { id: `desire_memory_${world.tick}_${profile.memory.length + 1}`, tick: world.tick, type, payload }; profile.memory.push(memory); if (profile.memory.length > 100) profile.memory.shift(); return memory; }
function getEntityDesireProfile(world, entityId) { return ensureEntityDesires(world, entityId); }
function getDesireStats(world) { const state = ensureDesireState(world); const profiles = Object.values(state.byEntity); return { profiles: profiles.length, averageHappiness: average(profiles.map(profile => profile.happiness)), dominantDesires: countBy(profiles.map(profile => profile.dominantDesire).filter(Boolean)), dominantFears: countBy(profiles.map(profile => profile.dominantFear).filter(Boolean)), averageEnvironmentRisk: average(profiles.map(profile => profile.environment?.totalRisk || 0)) }; }
function nudge(map, key, delta) { map[key] = clamp(Number(map[key] || 0) + Number(delta || 0), 0, 100); }
function driftMap(map, amount = 0.04) { for (const key of Object.keys(map)) map[key] = clamp(map[key] - amount, 0, 100); }
function maxKey(map) { return Object.entries(map || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || null; }
function normalizeMap(input = {}) { const out = {}; for (const [key, value] of Object.entries(input)) out[key] = clamp(Number(value || 0), 0, 100); return out; }
function countBy(items) { const out = {}; for (const item of items) out[item] = (out[item] || 0) + 1; return out; }
function average(items) { const values = (Array.isArray(items) ? items : []).map(Number).filter(Number.isFinite); if (!values.length) return 0; return values.reduce((a, b) => a + b, 0) / values.length; }
function round(value, digits = 3) { const factor = 10 ** digits; return Math.round(Number(value || 0) * factor) / factor; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value || 0))); }

module.exports = { DESIRE_TYPES, FEAR_TYPES, DEFAULT_DESIRE_OPTIONS, ensureDesireState, ensureEntityDesires, processDesireTick, updateDesireProfile, generateGoalsFromDesires, generateEnvironmentGoals, calculateEntityEnvironmentSignal, calculateHappiness, getEntityDesireProfile, getDesireStats };
