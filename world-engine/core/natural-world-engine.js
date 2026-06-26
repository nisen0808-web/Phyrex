'use strict';

const NATURAL_WORLD_VERSION = 1;

const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
const WEATHER_TYPES = ['clear', 'cloudy', 'rain', 'storm', 'snow', 'drought', 'heatwave', 'cold_snap'];
const DISASTER_TYPES = ['flood', 'wildfire', 'drought', 'blizzard', 'earthquake', 'pestilence'];

const DEFAULT_NATURAL_OPTIONS = {
  ticksPerDay: 24,
  daysPerMonth: 30,
  monthsPerYear: 12,
  resourceRegenerationRate: 0.05,
  resourceCapacityMultiplier: 2,
  disasterChance: 0.015,
  maxDisastersPerTick: 3,
  weatherMemory: 120,
  disasterMemory: 100,
  baselineTemperature: 16,
  baselineHumidity: 0.55,
  baselinePrecipitation: 0.35,
  biomeResourceProfiles: {
    plains: { food: 1.2, water: 1, wood: 0.7, herbs: 0.4 },
    forest: { food: 0.8, water: 1.1, wood: 1.5, herbs: 0.8 },
    mountain: { food: 0.35, water: 0.8, stone: 1.6, ore: 1.1, herbs: 0.35 },
    desert: { food: 0.2, water: 0.25, stone: 0.7, ore: 0.45 },
    tundra: { food: 0.25, water: 0.7, wood: 0.25, stone: 0.6 },
    wetland: { food: 1, water: 1.6, herbs: 1.1, wood: 0.4 },
    coast: { food: 1.1, water: 1.2, salt: 1, wood: 0.3 },
    urban: { food: 0.2, water: 0.6, wood: 0.1, stone: 0.4 },
  },
};

function ensureNaturalWorldState(world, options = {}) {
  if (!world.natural || typeof world.natural !== 'object') {
    world.natural = createNaturalWorldState(world, options);
  }
  const state = world.natural;
  if (state.version !== NATURAL_WORLD_VERSION) {
    throw new Error(`Unsupported natural world state version ${state.version}`);
  }
  if (!state.calendar || typeof state.calendar !== 'object') state.calendar = createCalendar(world, options);
  if (!state.climate || typeof state.climate !== 'object') state.climate = { zones: {}, stats: emptyStats() };
  if (!state.weather || typeof state.weather !== 'object') state.weather = { byLocation: {}, history: [], stats: emptyStats() };
  if (!state.resources || typeof state.resources !== 'object') state.resources = { capacities: {}, regenerated: {}, depleted: {}, stats: emptyStats() };
  if (!state.disasters || typeof state.disasters !== 'object') state.disasters = { active: {}, history: [], stats: emptyStats() };
  if (!state.stats || typeof state.stats !== 'object') state.stats = emptyStats();
  return state;
}

function createNaturalWorldState(world, options = {}) {
  return {
    version: NATURAL_WORLD_VERSION,
    createdAtTick: Number(world?.tick || 0),
    calendar: createCalendar(world, options),
    climate: { zones: {}, stats: emptyStats() },
    weather: { byLocation: {}, history: [], stats: emptyStats() },
    resources: { capacities: {}, regenerated: {}, depleted: {}, stats: emptyStats() },
    disasters: { active: {}, history: [], stats: emptyStats() },
    stats: emptyStats(),
  };
}

function processNaturalWorldTick(world, options = {}, context = {}) {
  const state = ensureNaturalWorldState(world, options);
  const random = context.random || createFallbackRandom();
  const config = mergeNaturalOptions(options);
  const calendar = processCalendarTick(world, config);
  const climate = processClimateTick(world, config, random);
  const weather = processWeatherTick(world, config, random);
  const resources = processResourceRegenerationTick(world, config, random);
  const disasters = processDisasterTick(world, config, random);
  state.stats.ticks = Number(state.stats.ticks || 0) + 1;
  return { calendar, climate, weather, resources, disasters };
}

function processCalendarTick(world, options = {}) {
  const state = ensureNaturalWorldState(world, options);
  const config = mergeNaturalOptions(options);
  const tick = Math.max(0, Number(world.tick || 0));
  const ticksPerDay = Math.max(1, Number(config.ticksPerDay));
  const daysPerMonth = Math.max(1, Number(config.daysPerMonth));
  const monthsPerYear = Math.max(1, Number(config.monthsPerYear));
  const dayIndex = Math.floor(tick / ticksPerDay);
  const hour = tick % ticksPerDay;
  const dayOfMonth = (dayIndex % daysPerMonth) + 1;
  const monthIndex = Math.floor(dayIndex / daysPerMonth) % monthsPerYear;
  const year = Math.floor(dayIndex / (daysPerMonth * monthsPerYear)) + 1;
  const season = seasonForMonth(monthIndex, monthsPerYear);
  const previous = state.calendar;
  const calendar = {
    tick,
    hour,
    dayIndex,
    dayOfMonth,
    month: monthIndex + 1,
    year,
    season,
    isNewDay: !previous || previous.dayIndex !== dayIndex,
    isNewMonth: !previous || previous.month !== monthIndex + 1 || previous.year !== year,
    isNewYear: !previous || previous.year !== year,
  };
  state.calendar = calendar;
  return calendar;
}

function processClimateTick(world, options = {}, random = null) {
  const state = ensureNaturalWorldState(world, options);
  const config = mergeNaturalOptions(options);
  const climateRandom = random || createFallbackRandom();
  const zones = {};
  for (const location of Object.values(world.locations || {})) {
    const locationId = location.id;
    const biome = resolveLocationBiome(location, config);
    const altitude = clamp(Number(location.altitude || location.elevation || location.meta?.altitude || location.meta?.elevation || 0), -500, 9000);
    const latitude = clamp(Number(location.latitude || location.lat || location.meta?.latitude || location.meta?.lat || biomeLatitude(biome)), -90, 90);
    const seasonal = seasonalProfile(state.calendar.season);
    const humidityNoise = climateRandom.float(`climate:${locationId}:humidity`) - 0.5;
    const temperatureNoise = climateRandom.float(`climate:${locationId}:temperature`) - 0.5;
    const temperature = Number(config.baselineTemperature)
      + biomeTemperatureOffset(biome)
      - Math.abs(latitude) * 0.22
      - altitude * 0.006
      + seasonal.temperature
      + temperatureNoise * 3;
    const humidity = clamp(
      Number(config.baselineHumidity) + biomeHumidityOffset(biome) + seasonal.humidity + humidityNoise * 0.12,
      0,
      1,
    );
    const precipitation = clamp(
      Number(config.baselinePrecipitation) + biomePrecipitationOffset(biome) + seasonal.precipitation + humidityNoise * 0.15,
      0,
      1,
    );
    zones[locationId] = {
      locationId,
      biome,
      latitude,
      altitude,
      temperature: round(temperature, 2),
      humidity: round(humidity, 3),
      precipitation: round(precipitation, 3),
      fertility: round(climateFertility({ biome, humidity, precipitation, temperature }), 3),
      aridity: round(clamp(1 - humidity + (temperature > 28 ? 0.1 : 0), 0, 1), 3),
    };
  }
  state.climate.zones = zones;
  state.climate.stats = {
    ticks: Number(state.climate.stats?.ticks || 0) + 1,
    zones: Object.keys(zones).length,
    averageTemperature: round(average(Object.values(zones).map(zone => zone.temperature)), 2),
    averageHumidity: round(average(Object.values(zones).map(zone => zone.humidity)), 3),
  };
  return { zones, stats: { ...state.climate.stats } };
}

function processWeatherTick(world, options = {}, random = null) {
  const state = ensureNaturalWorldState(world, options);
  const config = mergeNaturalOptions(options);
  const weatherRandom = random || createFallbackRandom();
  const updated = [];
  for (const [locationId, zone] of Object.entries(state.climate.zones || {})) {
    const previous = state.weather.byLocation[locationId] || null;
    const weather = selectWeather(zone, previous, state.calendar, weatherRandom, locationId);
    state.weather.byLocation[locationId] = weather;
    updated.push(weather);
    state.weather.history.push({
      tick: Number(world.tick || 0),
      locationId,
      type: weather.type,
      severity: weather.severity,
      temperature: weather.temperature,
      precipitation: weather.precipitation,
    });
  }
  trimArray(state.weather.history, config.weatherMemory);
  state.weather.stats = {
    ticks: Number(state.weather.stats?.ticks || 0) + 1,
    updated: updated.length,
    byType: countBy(updated.map(item => item.type)),
  };
  return { updated, byType: { ...state.weather.stats.byType } };
}

function processResourceRegenerationTick(world, options = {}, random = null) {
  const state = ensureNaturalWorldState(world, options);
  const config = mergeNaturalOptions(options);
  const resourceRandom = random || createFallbackRandom();
  const regenerated = [];
  const depleted = [];
  for (const location of Object.values(world.locations || {})) {
    const locationId = location.id;
    if (!location.resources) location.resources = {};
    const zone = state.climate.zones[locationId] || { biome: resolveLocationBiome(location, config), fertility: 0.5 };
    const weather = state.weather.byLocation[locationId] || { type: 'clear', severity: 0 };
    const profile = config.biomeResourceProfiles[zone.biome] || config.biomeResourceProfiles.plains;
    if (!state.resources.capacities[locationId]) state.resources.capacities[locationId] = {};
    for (const [resource, multiplier] of Object.entries(profile)) {
      const current = Number(location.resources[resource] || 0);
      const capacity = ensureResourceCapacity(state, locationId, resource, current, multiplier, config);
      const growth = Math.max(0,
        capacity
        * Number(config.resourceRegenerationRate)
        * Number(zone.fertility || 0.5)
        * weatherResourceModifier(weather.type, weather.severity)
        * (0.85 + resourceRandom.float(`resource:${locationId}:${resource}`) * 0.3));
      const next = Math.min(capacity, current + growth);
      const amount = next - current;
      if (amount > 0.0001) {
        location.resources[resource] = round(next, 3);
        state.resources.regenerated[resource] = round(Number(state.resources.regenerated[resource] || 0) + amount, 3);
        regenerated.push({ locationId, resource, amount: round(amount, 3), value: location.resources[resource], capacity: round(capacity, 3) });
      }
      if (next <= capacity * 0.05) depleted.push({ locationId, resource, value: round(next, 3), capacity: round(capacity, 3) });
    }
  }
  state.resources.stats = {
    ticks: Number(state.resources.stats?.ticks || 0) + 1,
    regenerated: regenerated.length,
    depleted: depleted.length,
  };
  return { regenerated, depleted };
}

function processDisasterTick(world, options = {}, random = null) {
  const state = ensureNaturalWorldState(world, options);
  const config = mergeNaturalOptions(options);
  const disasterRandom = random || createFallbackRandom();
  const started = [];
  const ended = [];
  const impacts = [];
  for (const disaster of Object.values(state.disasters.active || {})) {
    disaster.remainingTicks = Math.max(0, Number(disaster.remainingTicks || 0) - 1);
    const impact = applyDisasterImpact(world, disaster);
    if (impact) impacts.push(impact);
    if (disaster.remainingTicks <= 0) {
      disaster.status = 'ended';
      disaster.endedAtTick = Number(world.tick || 0);
      delete state.disasters.active[disaster.id];
      state.disasters.history.push(disaster);
      ended.push(disaster);
    }
  }
  for (const [locationId, weather] of Object.entries(state.weather.byLocation || {})) {
    if (started.length >= Math.max(0, Number(config.maxDisastersPerTick || 0))) break;
    if (activeDisasterAt(state, locationId)) continue;
    const zone = state.climate.zones[locationId] || {};
    if (!disasterRandom.chance(disasterChanceFor(weather, zone, config), `disaster:${locationId}:start`)) continue;
    const disaster = createDisaster(world, locationId, weather, zone, disasterRandom);
    state.disasters.active[disaster.id] = disaster;
    started.push(disaster);
  }
  trimArray(state.disasters.history, config.disasterMemory);
  state.disasters.stats = {
    ticks: Number(state.disasters.stats?.ticks || 0) + 1,
    active: Object.keys(state.disasters.active || {}).length,
    started: Number(state.disasters.stats?.started || 0) + started.length,
    ended: Number(state.disasters.stats?.ended || 0) + ended.length,
    impacts: Number(state.disasters.stats?.impacts || 0) + impacts.length,
  };
  return { started, ended, impacts, active: Object.values(state.disasters.active || {}) };
}

function getNaturalWorldSummary(world) {
  const state = ensureNaturalWorldState(world);
  return {
    version: state.version,
    calendar: { ...state.calendar },
    climate: { ...state.climate.stats },
    weather: { ...state.weather.stats },
    resources: { ...state.resources.stats, regenerated: { ...state.resources.regenerated } },
    disasters: { ...state.disasters.stats },
  };
}

function createDisaster(world, locationId, weather, zone, random) {
  const type = pickDisasterType(weather, zone, random, locationId);
  const severity = clamp(Number(weather.severity || 0.2) + random.float(`disaster:${locationId}:severity`) * 0.35, 0.1, 1);
  const duration = 1 + random.int(0, Math.max(0, Math.round(severity * 5)), `disaster:${locationId}:duration`);
  return {
    id: `disaster_${Number(world.tick || 0)}_${locationId}_${type}`,
    type,
    locationId,
    status: 'active',
    startedAtTick: Number(world.tick || 0),
    remainingTicks: duration,
    durationTicks: duration,
    severity: round(severity, 3),
  };
}

function applyDisasterImpact(world, disaster) {
  const location = world.locations?.[disaster.locationId];
  if (!location) return null;
  if (!location.resources) location.resources = {};
  const losses = {};
  for (const [resource, rate] of Object.entries(disasterResourceImpacts(disaster.type))) {
    const current = Number(location.resources[resource] || 0);
    if (current <= 0) continue;
    const loss = current * rate * clamp(Number(disaster.severity || 0), 0, 1);
    location.resources[resource] = round(Math.max(0, current - loss), 3);
    losses[resource] = round(loss, 3);
  }
  if (!Object.keys(losses).length) return null;
  if (!Array.isArray(world.memory)) world.memory = [];
  world.memory.push({
    tick: Number(world.tick || 0),
    type: 'natural_disaster_impact',
    locationId: disaster.locationId,
    disasterType: disaster.type,
    severity: disaster.severity,
    losses,
  });
  return { disasterId: disaster.id, locationId: disaster.locationId, type: disaster.type, losses };
}

function selectWeather(zone, previous, calendar, random, locationId) {
  const temperature = Number(zone.temperature || 0);
  const precipitation = Number(zone.precipitation || 0);
  const humidity = Number(zone.humidity || 0.5);
  const roll = random.float(`weather:${locationId}:type`);
  const persistence = previous && previous.type === 'cloudy' ? 0.12 : 0;
  let type = 'clear';
  if (temperature <= -5 && precipitation > 0.45 && roll < 0.55) type = 'snow';
  else if (temperature < 0 && roll < 0.12) type = 'cold_snap';
  else if (temperature > 32 && humidity < 0.35 && roll < 0.3) type = 'heatwave';
  else if (precipitation < 0.12 && humidity < 0.25 && roll < 0.25) type = 'drought';
  else if (precipitation > 0.65 && roll < 0.18) type = 'storm';
  else if (precipitation > 0.35 && roll < 0.58) type = 'rain';
  else if (roll < 0.72 + persistence) type = 'cloudy';
  const severity = weatherSeverity(type, zone, random, locationId);
  return {
    locationId,
    type,
    severity,
    temperature: round(temperature + random.float(`weather:${locationId}:temp`) * 2 - 1, 2),
    humidity: round(humidity, 3),
    precipitation: round(precipitation, 3),
    season: calendar.season,
    tick: calendar.tick,
  };
}

function weatherSeverity(type, zone, random, locationId) {
  const base = { clear: 0.05, cloudy: 0.12, rain: 0.3, storm: 0.65, snow: 0.45, drought: 0.55, heatwave: 0.55, cold_snap: 0.5 }[type] ?? 0.1;
  const boost = type === 'storm' ? Number(zone.precipitation || 0) * 0.2 : Number(zone.aridity || 0) * 0.1;
  return round(clamp(base + boost + random.float(`weather:${locationId}:severity`) * 0.2, 0, 1), 3);
}

function disasterChanceFor(weather, zone, config) {
  const severeWeather = ['storm', 'drought', 'heatwave', 'cold_snap', 'snow'].includes(weather.type) ? Number(weather.severity || 0) * 0.08 : 0;
  const aridity = weather.type === 'heatwave' || weather.type === 'drought' ? Number(zone.aridity || 0) * 0.04 : 0;
  return clamp(Number(config.disasterChance || 0) + severeWeather + aridity, 0, 0.8);
}

function pickDisasterType(weather, zone, random, locationId) {
  if (weather.type === 'storm') return Number(zone.temperature || 0) < 0 ? 'blizzard' : 'flood';
  if (weather.type === 'drought') return 'drought';
  if (weather.type === 'heatwave') return random.chance(0.55, `disaster:${locationId}:wildfire`) ? 'wildfire' : 'drought';
  if (weather.type === 'snow' || weather.type === 'cold_snap') return 'blizzard';
  return random.weightedPick([['earthquake', 0.1], ['pestilence', 0.15], ['flood', 0.2], ['wildfire', 0.15], ['drought', 0.15]], `disaster:${locationId}:type`) || 'flood';
}

function disasterResourceImpacts(type) {
  return {
    flood: { food: 0.04, wood: 0.02, herbs: 0.03 },
    wildfire: { food: 0.05, wood: 0.12, herbs: 0.05 },
    drought: { food: 0.06, water: 0.08, herbs: 0.04 },
    blizzard: { food: 0.05, wood: 0.03 },
    earthquake: { stone: 0.02, ore: 0.02, food: 0.03 },
    pestilence: { food: 0.03, herbs: 0.08 },
  }[type] || { food: 0.02 };
}

function createCalendar(world, options = {}) {
  return {
    tick: Number(world?.tick || 0),
    hour: 0,
    dayIndex: 0,
    dayOfMonth: 1,
    month: 1,
    year: 1,
    season: seasonForMonth(0, Math.max(1, Number(options.monthsPerYear || DEFAULT_NATURAL_OPTIONS.monthsPerYear))),
    isNewDay: true,
    isNewMonth: true,
    isNewYear: true,
  };
}

function ensureResourceCapacity(state, locationId, resource, current, multiplier, config) {
  if (!state.resources.capacities[locationId]) state.resources.capacities[locationId] = {};
  if (!Number.isFinite(state.resources.capacities[locationId][resource])) {
    const baseline = Math.max(20, current || 0, Number(multiplier || 1) * 100);
    state.resources.capacities[locationId][resource] = baseline * Number(config.resourceCapacityMultiplier || 2);
  }
  return Number(state.resources.capacities[locationId][resource]);
}

function seasonForMonth(monthIndex, monthsPerYear) {
  const normalized = ((Number(monthIndex) % monthsPerYear) + monthsPerYear) % monthsPerYear;
  return SEASONS[Math.min(3, Math.floor(normalized / (monthsPerYear / 4)))] || 'spring';
}

function seasonalProfile(season) {
  return {
    spring: { temperature: 3, humidity: 0.08, precipitation: 0.08 },
    summer: { temperature: 9, humidity: -0.03, precipitation: 0.02 },
    autumn: { temperature: 1, humidity: 0.04, precipitation: 0.04 },
    winter: { temperature: -8, humidity: -0.02, precipitation: -0.02 },
  }[season] || { temperature: 0, humidity: 0, precipitation: 0 };
}

function normalizeBiome(value) {
  const text = String(value || 'plains').trim().toLowerCase();
  return DEFAULT_NATURAL_OPTIONS.biomeResourceProfiles[text] ? text : 'plains';
}

function resolveLocationBiome(location, config = DEFAULT_NATURAL_OPTIONS) {
  const candidates = [
    location?.biome,
    location?.terrain,
    location?.meta?.biome,
    location?.meta?.terrain,
    location?.type,
  ];
  for (const candidate of candidates) {
    const text = String(candidate || '').trim().toLowerCase();
    if (text && config.biomeResourceProfiles[text]) return text;
  }
  return inferBiome(location);
}

function inferBiome(location) {
  const name = String(location?.name || location?.id || '').toLowerCase();
  if (name.includes('forest')) return 'forest';
  if (name.includes('mount')) return 'mountain';
  if (name.includes('desert')) return 'desert';
  if (name.includes('coast') || name.includes('port')) return 'coast';
  if (name.includes('city') || name.includes('town')) return 'urban';
  return 'plains';
}

function biomeLatitude(biome) {
  return { tundra: 65, desert: 25, coast: 20, wetland: 15, mountain: 35, forest: 30, urban: 25, plains: 20 }[biome] ?? 20;
}

function biomeTemperatureOffset(biome) {
  return { desert: 12, tundra: -18, mountain: -6, forest: -1, wetland: 1, coast: 0, urban: 2, plains: 0 }[biome] || 0;
}

function biomeHumidityOffset(biome) {
  return { desert: -0.35, tundra: -0.12, mountain: -0.08, forest: 0.12, wetland: 0.28, coast: 0.18, urban: -0.05, plains: 0 }[biome] || 0;
}

function biomePrecipitationOffset(biome) {
  return { desert: -0.28, tundra: -0.12, mountain: 0.02, forest: 0.14, wetland: 0.25, coast: 0.18, urban: -0.04, plains: 0 }[biome] || 0;
}

function climateFertility(zone) {
  const temp = Number(zone.temperature || 0);
  const tempFactor = clamp(1 - Math.abs(temp - 18) / 35, 0, 1);
  return clamp((Number(zone.humidity || 0) * 0.35) + (Number(zone.precipitation || 0) * 0.35) + tempFactor * 0.3, 0, 1);
}

function weatherResourceModifier(type, severity) {
  const sev = Number(severity || 0);
  if (type === 'rain') return 1.1 + sev * 0.2;
  if (type === 'storm') return Math.max(0.45, 0.9 - sev * 0.45);
  if (type === 'drought' || type === 'heatwave') return Math.max(0.15, 0.65 - sev * 0.4);
  if (type === 'snow' || type === 'cold_snap') return Math.max(0.2, 0.7 - sev * 0.35);
  return 1;
}

function activeDisasterAt(state, locationId) {
  return Object.values(state.disasters.active || {}).some(disaster => disaster.locationId === locationId);
}

function mergeNaturalOptions(options = {}) {
  return { ...DEFAULT_NATURAL_OPTIONS, ...(options || {}), biomeResourceProfiles: { ...DEFAULT_NATURAL_OPTIONS.biomeResourceProfiles, ...(options.biomeResourceProfiles || {}) } };
}

function createFallbackRandom() {
  return { float: () => 0.5, int: (min, max) => Math.floor((Number(min) + Number(max)) / 2), chance: probability => Number(probability || 0) >= 0.5, weightedPick: entries => (entries || [])[0]?.[0] || null };
}

function emptyStats() { return { ticks: 0 }; }
function average(values) { const filtered = (values || []).filter(Number.isFinite); return filtered.length ? filtered.reduce((sum, value) => sum + value, 0) / filtered.length : 0; }
function countBy(values) { const out = {}; for (const value of values || []) out[value || 'unknown'] = (out[value || 'unknown'] || 0) + 1; return out; }
function trimArray(array, limit) { while (Array.isArray(array) && array.length > Math.max(0, Number(limit || 0))) array.shift(); }
function clamp(value, min, max) { const number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min; }
function round(value, digits = 3) { const factor = 10 ** digits; return Math.round(Number(value || 0) * factor) / factor; }

module.exports = {
  NATURAL_WORLD_VERSION,
  SEASONS,
  WEATHER_TYPES,
  DISASTER_TYPES,
  DEFAULT_NATURAL_OPTIONS,
  ensureNaturalWorldState,
  createNaturalWorldState,
  processNaturalWorldTick,
  processCalendarTick,
  processClimateTick,
  processWeatherTick,
  processResourceRegenerationTick,
  processDisasterTick,
  getNaturalWorldSummary,
  seasonForMonth,
  normalizeBiome,
  resolveLocationBiome,
  mergeNaturalOptions,
};
