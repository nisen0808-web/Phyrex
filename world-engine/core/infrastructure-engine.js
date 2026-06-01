'use strict';

const INFRASTRUCTURE_STATUS = {
  PLANNED: 'planned',
  BUILDING: 'building',
  ACTIVE: 'active',
  DAMAGED: 'damaged',
  RUINED: 'ruined',
};

const INFRASTRUCTURE_TYPES = {
  ROAD: 'road',
  MARKET: 'market',
  WALL: 'wall',
  SCHOOL: 'school',
  TEMPLE: 'temple',
  GRANARY: 'granary',
  WORKSHOP: 'workshop',
  BARRACKS: 'barracks',
  HARBOR: 'harbor',
  HOSPITAL: 'hospital',
};

const DEFAULT_INFRASTRUCTURE_DEFS = {
  road: { cost: 120, buildProgress: 40, maintenance: 1, effects: { trade: 8, migration: 5 } },
  market: { cost: 180, buildProgress: 50, maintenance: 2, effects: { trade: 12, wealth: 8 } },
  wall: { cost: 260, buildProgress: 65, maintenance: 3, effects: { security: 18, military: 5 } },
  school: { cost: 220, buildProgress: 60, maintenance: 3, effects: { knowledge: 15, culture: 6 } },
  temple: { cost: 200, buildProgress: 55, maintenance: 2, effects: { faith: 12, legitimacy: 6, culture: 4 } },
  granary: { cost: 150, buildProgress: 45, maintenance: 1, effects: { foodStorage: 20, stability: 5 } },
  workshop: { cost: 210, buildProgress: 55, maintenance: 2, effects: { craft: 12, wealth: 6 } },
  barracks: { cost: 240, buildProgress: 60, maintenance: 3, effects: { military: 15, security: 8 } },
  harbor: { cost: 320, buildProgress: 75, maintenance: 4, effects: { trade: 20, migration: 8 } },
  hospital: { cost: 280, buildProgress: 70, maintenance: 4, effects: { health: 15, stability: 8 } },
};

const DEFAULT_INFRASTRUCTURE_OPTIONS = {
  autoPlan: true,
  buildRate: 10,
  decayRate: 0.02,
  damageDecayThreshold: 35,
  ruinDecayThreshold: 5,
  maxProjectsPerCity: 3,
};

function ensureInfrastructureState(world) {
  if (!world.infrastructure) {
    world.infrastructure = {
      byId: {},
      indexes: { byCity: {}, byType: {}, byStatus: {} },
      stats: { planned: 0, completed: 0, damaged: 0, ruined: 0, maintained: 0 },
    };
  }
  return world.infrastructure;
}

function createInfrastructure(world, input = {}) {
  if (!input.cityId) throw new Error('Infrastructure requires cityId');
  if (!input.type) throw new Error('Infrastructure requires type');
  const city = world.cities?.byId?.[input.cityId];
  if (!city) throw new Error(`Missing city ${input.cityId}`);
  const def = DEFAULT_INFRASTRUCTURE_DEFS[input.type] || { cost: 100, buildProgress: 50, maintenance: 1, effects: {} };
  const state = ensureInfrastructureState(world);
  const id = input.id || `infra_${world.tick}_${input.cityId}_${input.type}_${Math.random().toString(16).slice(2)}`;
  const item = {
    id,
    cityId: input.cityId,
    locationId: city.locationId,
    type: input.type,
    name: input.name || `${city.name} ${input.type}`,
    status: input.status || INFRASTRUCTURE_STATUS.PLANNED,
    createdAt: world.tick,
    completedAt: null,
    level: Number(input.level || 1),
    progress: Number(input.progress || 0),
    condition: Number(input.condition || 100),
    cost: Number(input.cost || def.cost),
    buildProgressRequired: Number(input.buildProgressRequired || def.buildProgress),
    maintenance: Number(input.maintenance || def.maintenance),
    effects: { ...def.effects, ...(input.effects || {}) },
    memory: [],
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    payload: { ...(input.payload || {}) },
  };
  state.byId[id] = item;
  state.stats.planned += 1;
  city.infrastructureIds = Array.isArray(city.infrastructureIds) ? city.infrastructureIds : [];
  if (!city.infrastructureIds.includes(id)) city.infrastructureIds.push(id);
  recordInfrastructureMemory(world, item, 'infrastructure.created', {});
  rebuildInfrastructureIndexes(world);
  return item;
}

function processInfrastructureTick(world, options = {}) {
  const config = { ...DEFAULT_INFRASTRUCTURE_OPTIONS, ...(options || {}) };
  const planned = config.autoPlan ? autoPlanInfrastructure(world, config) : [];
  const built = [];
  const maintained = [];
  const degraded = [];

  for (const item of Object.values(ensureInfrastructureState(world).byId)) {
    if (item.status === INFRASTRUCTURE_STATUS.RUINED) continue;
    if ([INFRASTRUCTURE_STATUS.PLANNED, INFRASTRUCTURE_STATUS.BUILDING].includes(item.status)) {
      const result = buildInfrastructure(world, item.id, config);
      if (result?.completed) built.push(item.id);
    }
    const maintenance = maintainInfrastructure(world, item.id, config);
    if (maintenance?.maintained) maintained.push(item.id);
    const decay = decayInfrastructure(world, item.id, config);
    if (decay?.degraded) degraded.push(item.id);
  }

  applyInfrastructureEffects(world);
  rebuildInfrastructureIndexes(world);
  return { planned, built, maintained, degraded, stats: getInfrastructureStats(world) };
}

function autoPlanInfrastructure(world, options = {}) {
  const planned = [];
  for (const city of Object.values(world.cities?.byId || {})) {
    const existing = (city.infrastructureIds || []).map(id => world.infrastructure?.byId?.[id]).filter(Boolean);
    const activeProjects = existing.filter(item => [INFRASTRUCTURE_STATUS.PLANNED, INFRASTRUCTURE_STATUS.BUILDING].includes(item.status));
    if (activeProjects.length >= (options.maxProjectsPerCity || DEFAULT_INFRASTRUCTURE_OPTIONS.maxProjectsPerCity)) continue;
    const nextType = chooseInfrastructureForCity(world, city);
    if (!nextType) continue;
    if (existing.some(item => item.type === nextType && item.status !== INFRASTRUCTURE_STATUS.RUINED)) continue;
    if (city.wealth < (DEFAULT_INFRASTRUCTURE_DEFS[nextType]?.cost || 100) * 0.25) continue;
    planned.push(createInfrastructure(world, { cityId: city.id, type: nextType }));
  }
  return planned;
}

function chooseInfrastructureForCity(world, city) {
  const effects = city.meta?.technologyEffects || {};
  if (city.population > 50 && !hasInfrastructure(world, city.id, INFRASTRUCTURE_TYPES.ROAD)) return INFRASTRUCTURE_TYPES.ROAD;
  if (city.wealth > 500 && !hasInfrastructure(world, city.id, INFRASTRUCTURE_TYPES.MARKET)) return INFRASTRUCTURE_TYPES.MARKET;
  if (city.security < 45 && !hasInfrastructure(world, city.id, INFRASTRUCTURE_TYPES.WALL)) return INFRASTRUCTURE_TYPES.WALL;
  if ((city.culture || 0) > 15 && !hasInfrastructure(world, city.id, INFRASTRUCTURE_TYPES.SCHOOL)) return INFRASTRUCTURE_TYPES.SCHOOL;
  if (effects.foodStorage && !hasInfrastructure(world, city.id, INFRASTRUCTURE_TYPES.GRANARY)) return INFRASTRUCTURE_TYPES.GRANARY;
  if (effects.mortalityReduction && !hasInfrastructure(world, city.id, INFRASTRUCTURE_TYPES.HOSPITAL)) return INFRASTRUCTURE_TYPES.HOSPITAL;
  if (!hasInfrastructure(world, city.id, INFRASTRUCTURE_TYPES.WORKSHOP)) return INFRASTRUCTURE_TYPES.WORKSHOP;
  return null;
}

function buildInfrastructure(world, infrastructureId, options = {}) {
  const item = getInfrastructure(world, infrastructureId);
  if (!item) return null;
  const city = world.cities?.byId?.[item.cityId];
  if (!city) return null;
  item.status = INFRASTRUCTURE_STATUS.BUILDING;
  const treasury = city.wealth || 0;
  const spend = Math.min(treasury, Math.max(1, item.cost * 0.05));
  city.wealth = Math.max(0, treasury - spend);
  const techBonus = Number(city.meta?.technologyEffects?.infrastructure || 0);
  item.progress += (options.buildRate || DEFAULT_INFRASTRUCTURE_OPTIONS.buildRate) * (1 + techBonus);
  if (item.progress >= item.buildProgressRequired) {
    item.progress = item.buildProgressRequired;
    item.status = INFRASTRUCTURE_STATUS.ACTIVE;
    item.completedAt = world.tick;
    ensureInfrastructureState(world).stats.completed += 1;
    recordInfrastructureMemory(world, item, 'infrastructure.completed', {});
    return { completed: true, item };
  }
  return { completed: false, item };
}

function maintainInfrastructure(world, infrastructureId) {
  const item = getInfrastructure(world, infrastructureId);
  if (!item || item.status !== INFRASTRUCTURE_STATUS.ACTIVE) return null;
  const city = world.cities?.byId?.[item.cityId];
  if (!city || city.wealth < item.maintenance) return { maintained: false };
  city.wealth -= item.maintenance;
  item.condition = clamp(item.condition + 0.5, 0, 100);
  ensureInfrastructureState(world).stats.maintained += 1;
  return { maintained: true };
}

function decayInfrastructure(world, infrastructureId, options = {}) {
  const item = getInfrastructure(world, infrastructureId);
  if (!item || item.status === INFRASTRUCTURE_STATUS.RUINED) return null;
  item.condition = clamp(item.condition - (options.decayRate || DEFAULT_INFRASTRUCTURE_OPTIONS.decayRate), 0, 100);
  if (item.condition <= (options.ruinDecayThreshold || DEFAULT_INFRASTRUCTURE_OPTIONS.ruinDecayThreshold)) {
    item.status = INFRASTRUCTURE_STATUS.RUINED;
    ensureInfrastructureState(world).stats.ruined += 1;
    recordInfrastructureMemory(world, item, 'infrastructure.ruined', {});
    return { degraded: true, status: item.status };
  }
  if (item.condition <= (options.damageDecayThreshold || DEFAULT_INFRASTRUCTURE_OPTIONS.damageDecayThreshold) && item.status === INFRASTRUCTURE_STATUS.ACTIVE) {
    item.status = INFRASTRUCTURE_STATUS.DAMAGED;
    ensureInfrastructureState(world).stats.damaged += 1;
    recordInfrastructureMemory(world, item, 'infrastructure.damaged', {});
    return { degraded: true, status: item.status };
  }
  return { degraded: false };
}

function applyInfrastructureEffects(world) {
  for (const city of Object.values(world.cities?.byId || {})) {
    const items = (city.infrastructureIds || []).map(id => world.infrastructure?.byId?.[id]).filter(item => item && item.status === INFRASTRUCTURE_STATUS.ACTIVE);
    const effects = {};
    for (const item of items) {
      const conditionMultiplier = item.condition / 100;
      for (const [key, value] of Object.entries(item.effects || {})) {
        effects[key] = Number(effects[key] || 0) + Number(value || 0) * item.level * conditionMultiplier;
      }
    }
    city.meta = { ...(city.meta || {}), infrastructureEffects: effects };
    city.security = clamp(Number(city.security || 0) + Number(effects.security || 0) * 0.01, 0, 100);
    city.culture = Number(city.culture || 0) + Number(effects.culture || 0) * 0.01;
  }
}

function hasInfrastructure(world, cityId, type) {
  const city = world.cities?.byId?.[cityId];
  return (city?.infrastructureIds || []).some(id => world.infrastructure?.byId?.[id]?.type === type && world.infrastructure?.byId?.[id]?.status !== INFRASTRUCTURE_STATUS.RUINED);
}

function getInfrastructure(world, infrastructureId) {
  return ensureInfrastructureState(world).byId[infrastructureId] || null;
}

function getCityInfrastructure(world, cityId) {
  return Object.values(ensureInfrastructureState(world).byId).filter(item => item.cityId === cityId);
}

function getInfrastructureStats(world) {
  const state = ensureInfrastructureState(world);
  return {
    total: Object.keys(state.byId).length,
    active: Object.values(state.byId).filter(item => item.status === INFRASTRUCTURE_STATUS.ACTIVE).length,
    byType: countIndex(state.indexes.byType),
    byStatus: countIndex(state.indexes.byStatus),
  };
}

function recordInfrastructureMemory(world, item, type, payload = {}) {
  const memory = { id: `infrastructure_memory_${world.tick}_${item.memory.length + 1}`, tick: world.tick, type, payload: { infrastructureId: item.id, cityId: item.cityId, ...payload } };
  item.memory.push(memory);
  if (item.memory.length > 200) item.memory.shift();
  return memory;
}

function rebuildInfrastructureIndexes(world) {
  const state = ensureInfrastructureState(world);
  state.indexes = { byCity: {}, byType: {}, byStatus: {} };
  for (const item of Object.values(state.byId)) {
    addIndex(state.indexes.byCity, item.cityId, item.id);
    addIndex(state.indexes.byType, item.type, item.id);
    addIndex(state.indexes.byStatus, item.status, item.id);
  }
}

function countIndex(index) {
  const out = {};
  for (const [key, value] of Object.entries(index || {})) out[key] = value.length;
  return out;
}
function addIndex(index, key, value) {
  if (!index[key]) index[key] = [];
  if (!index[key].includes(value)) index[key].push(value);
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value || 0))); }

module.exports = {
  INFRASTRUCTURE_STATUS,
  INFRASTRUCTURE_TYPES,
  DEFAULT_INFRASTRUCTURE_DEFS,
  DEFAULT_INFRASTRUCTURE_OPTIONS,
  ensureInfrastructureState,
  createInfrastructure,
  processInfrastructureTick,
  autoPlanInfrastructure,
  buildInfrastructure,
  maintainInfrastructure,
  decayInfrastructure,
  applyInfrastructureEffects,
  getInfrastructure,
  getCityInfrastructure,
  getInfrastructureStats,
  rebuildInfrastructureIndexes,
};
