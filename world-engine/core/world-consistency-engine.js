'use strict';

const WORLD_CONSISTENCY_VERSION = 1;

const DEFAULT_CONSISTENCY_OPTIONS = {
  repair: false,
  maxIssues: 500,
  reportLimit: 120,
  memoryLimit: 1000,
  simulationReportLimit: 200,
  kernelHistoryLimit: 100,
  naturalWeatherHistoryLimit: 120,
  naturalDisasterHistoryLimit: 100,
  contractViolationLimit: 100,
};

function ensureWorldConsistencyState(world, options = {}) {
  if (!world.consistency || typeof world.consistency !== 'object') {
    world.consistency = createWorldConsistencyState(world, options);
  }
  const state = world.consistency;
  if (state.version !== WORLD_CONSISTENCY_VERSION) {
    state.version = WORLD_CONSISTENCY_VERSION;
  }
  if (!Array.isArray(state.reports)) state.reports = [];
  if (!state.stats || typeof state.stats !== 'object') state.stats = { checks: 0, repairs: 0, issues: 0 };
  return state;
}

function createWorldConsistencyState(world, _options = {}) {
  return {
    version: WORLD_CONSISTENCY_VERSION,
    createdAtTick: Number(world?.tick || 0),
    lastCheckTick: null,
    lastRepairTick: null,
    lastReport: null,
    reports: [],
    stats: { checks: 0, repairs: 0, issues: 0 },
  };
}

function auditWorldConsistency(world, options = {}) {
  const config = mergeConsistencyOptions(options);
  const issues = [];
  const diagnostics = [];
  const push = issue => {
    if (issues.length >= config.maxIssues) return;
    issues.push({ severity: 'error', repairable: true, ...issue });
  };

  if (!world || typeof world !== 'object') {
    push({ code: 'invalid_world', path: 'world', message: 'World must be an object', repairable: false });
    return buildConsistencyReport(world, issues, diagnostics, config, { dryRun: true });
  }

  if (!Number.isFinite(Number(world.tick)) || Number(world.tick) < 0) {
    push({ code: 'invalid_tick', path: 'tick', message: 'World tick must be a non-negative number', action: 'normalize_tick' });
  }
  if (!world.entities || typeof world.entities !== 'object') push({ code: 'missing_entities', path: 'entities', message: 'World entities map is missing', action: 'create_map' });
  if (!world.locations || typeof world.locations !== 'object') push({ code: 'missing_locations', path: 'locations', message: 'World locations map is missing', action: 'create_map' });

  const locations = world.locations && typeof world.locations === 'object' ? world.locations : {};
  const entities = world.entities && typeof world.entities === 'object' ? world.entities : {};
  const fallbackLocationId = firstKey(locations) || 'void';

  if (!Object.keys(locations).length) {
    push({ code: 'no_locations', path: 'locations', message: 'World has no locations', action: 'create_fallback_location' });
  }

  for (const [locationId, location] of Object.entries(locations)) {
    if (!location || typeof location !== 'object') {
      push({ code: 'invalid_location_record', path: `locations.${locationId}`, message: 'Location record must be an object', action: 'replace_location' });
      continue;
    }
    if (location.id !== locationId) push({ code: 'location_id_mismatch', path: `locations.${locationId}.id`, message: 'Location id must match map key', action: 'fix_location_id', data: { locationId } });
    if (!location.resources || typeof location.resources !== 'object') push({ code: 'missing_location_resources', path: `locations.${locationId}.resources`, message: 'Location resources map is missing', action: 'create_resource_map' });
    for (const [resource, value] of Object.entries(location.resources || {})) {
      if (!Number.isFinite(Number(value)) || Number(value) < 0) push({ code: 'invalid_resource_value', path: `locations.${locationId}.resources.${resource}`, message: 'Resource value must be non-negative finite number', action: 'clamp_resource', data: { locationId, resource } });
    }
    if (Array.isArray(location.neighbors)) {
      for (const neighborId of location.neighbors) {
        if (!locations[neighborId]) push({ code: 'missing_neighbor_location', path: `locations.${locationId}.neighbors`, message: `Neighbor ${neighborId} does not exist`, action: 'remove_missing_neighbor', data: { locationId, neighborId } });
      }
    }
  }

  for (const [entityId, entity] of Object.entries(entities)) {
    if (!entity || typeof entity !== 'object') {
      push({ code: 'invalid_entity_record', path: `entities.${entityId}`, message: 'Entity record must be an object', action: 'remove_invalid_entity', data: { entityId } });
      continue;
    }
    if (entity.id !== entityId) push({ code: 'entity_id_mismatch', path: `entities.${entityId}.id`, message: 'Entity id must match map key', action: 'fix_entity_id', data: { entityId } });
    if (!entity.status) push({ code: 'missing_entity_status', path: `entities.${entityId}.status`, message: 'Entity status is missing', action: 'set_entity_alive', data: { entityId } });
    if (entity.locationId && !locations[entity.locationId]) push({ code: 'missing_entity_location', path: `entities.${entityId}.locationId`, message: `Entity location ${entity.locationId} does not exist`, action: 'move_entity_to_fallback', data: { entityId, fallbackLocationId } });
    if (!entity.locationId && Object.keys(locations).length) push({ code: 'missing_entity_location_id', path: `entities.${entityId}.locationId`, message: 'Entity locationId is missing', action: 'move_entity_to_fallback', data: { entityId, fallbackLocationId } });
    if (entity.stats && typeof entity.stats === 'object') {
      for (const [stat, value] of Object.entries(entity.stats)) {
        if (!Number.isFinite(Number(value))) push({ code: 'invalid_entity_stat', path: `entities.${entityId}.stats.${stat}`, message: 'Entity stat must be finite number', action: 'clamp_entity_stat', data: { entityId, stat } });
      }
    }
  }

  auditPopulation(world, issues, push);
  auditNatural(world, locations, push, config);
  auditEcology(world, locations, push, config);
  auditSimulationAndKernel(world, push, config);

  return buildConsistencyReport(world, issues, diagnostics, config, { dryRun: true });
}

function repairWorldConsistency(world, options = {}) {
  const config = mergeConsistencyOptions({ ...options, repair: true });
  ensureBaseMaps(world);
  const before = auditWorldConsistency(world, config);
  const repairs = [];
  for (const issue of before.issues) {
    const repaired = applyRepair(world, issue, config);
    if (repaired) repairs.push(repaired);
  }
  const after = auditWorldConsistency(world, config);
  const report = buildConsistencyReport(world, after.issues, after.diagnostics, config, {
    dryRun: false,
    beforeIssues: before.issues.length,
    repairs,
  });
  recordConsistencyReport(world, report, config);
  return report;
}

function runWorldConsistencyCheck(world, options = {}) {
  const config = mergeConsistencyOptions(options);
  ensureWorldConsistencyState(world, config);
  const report = config.repair ? repairWorldConsistency(world, config) : auditWorldConsistency(world, config);
  if (!config.repair) recordConsistencyReport(world, report, config);
  return report;
}

function getWorldConsistencySummary(world) {
  const state = ensureWorldConsistencyState(world);
  return {
    version: state.version,
    lastCheckTick: state.lastCheckTick,
    lastRepairTick: state.lastRepairTick,
    stats: { ...state.stats },
    lastReport: state.lastReport ? compactReport(state.lastReport) : null,
  };
}

function auditPopulation(world, issues, push) {
  const population = world.population;
  if (!population || typeof population !== 'object') return;
  if (!population.indexes || typeof population.indexes !== 'object') push({ code: 'missing_population_indexes', path: 'population.indexes', message: 'Population indexes are missing', action: 'rebuild_population_indexes' });
  const expectedByAgeGroup = {};
  const expectedByGeneration = {};
  for (const [entityId, entity] of Object.entries(world.entities || {})) {
    const demo = entity?.demographics;
    if (!demo) continue;
    const ageGroup = demo.ageGroup || 'unknown';
    const generation = String(demo.generation || 1);
    addUnique(expectedByAgeGroup, ageGroup, entityId);
    addUnique(expectedByGeneration, generation, entityId);
  }
  if (JSON.stringify(population.indexes?.byAgeGroup || {}) !== JSON.stringify(expectedByAgeGroup)) push({ code: 'stale_population_age_index', path: 'population.indexes.byAgeGroup', message: 'Population age index is stale', action: 'rebuild_population_indexes' });
  if (JSON.stringify(population.indexes?.byGeneration || {}) !== JSON.stringify(expectedByGeneration)) push({ code: 'stale_population_generation_index', path: 'population.indexes.byGeneration', message: 'Population generation index is stale', action: 'rebuild_population_indexes' });
}

function auditNatural(world, locations, push, config) {
  const natural = world.natural;
  if (!natural || typeof natural !== 'object') return;
  for (const locationId of Object.keys(natural.weather?.byLocation || {})) {
    if (!locations[locationId]) push({ code: 'weather_for_missing_location', path: `natural.weather.byLocation.${locationId}`, message: 'Weather references missing location', action: 'remove_weather_location', data: { locationId } });
  }
  for (const [id, disaster] of Object.entries(natural.disasters?.active || {})) {
    if (!disaster || typeof disaster !== 'object') push({ code: 'invalid_disaster_record', path: `natural.disasters.active.${id}`, message: 'Active disaster must be object', action: 'remove_active_disaster', data: { id } });
    else if (disaster.locationId && !locations[disaster.locationId]) push({ code: 'disaster_missing_location', path: `natural.disasters.active.${id}.locationId`, message: 'Active disaster references missing location', action: 'remove_active_disaster', data: { id } });
  }
  if ((natural.weather?.history || []).length > config.naturalWeatherHistoryLimit) push({ code: 'natural_weather_history_over_limit', path: 'natural.weather.history', message: 'Weather history exceeds limit', action: 'trim_natural_weather_history' });
  if ((natural.disasters?.history || []).length > config.naturalDisasterHistoryLimit) push({ code: 'natural_disaster_history_over_limit', path: 'natural.disasters.history', message: 'Disaster history exceeds limit', action: 'trim_natural_disaster_history' });
}

function auditEcology(world, locations, push) {
  const ecology = world.ecology;
  if (!ecology || typeof ecology !== 'object') return;
  for (const locationId of Object.keys(ecology.habitats?.byLocation || {})) {
    if (!locations[locationId]) push({ code: 'habitat_missing_location', path: `ecology.habitats.byLocation.${locationId}`, message: 'Habitat references missing location', action: 'remove_habitat_location', data: { locationId } });
  }
  const expectedByLocation = {};
  for (const [key, pop] of Object.entries(ecology.populations?.byKey || {})) {
    if (!pop || typeof pop !== 'object') {
      push({ code: 'invalid_ecology_population', path: `ecology.populations.byKey.${key}`, message: 'Ecology population must be object', action: 'remove_ecology_population', data: { key } });
      continue;
    }
    if (!locations[pop.locationId]) push({ code: 'ecology_population_missing_location', path: `ecology.populations.byKey.${key}.locationId`, message: 'Ecology population references missing location', action: 'remove_ecology_population', data: { key } });
    if (!Number.isFinite(Number(pop.population)) || Number(pop.population) < 0) push({ code: 'invalid_ecology_population_value', path: `ecology.populations.byKey.${key}.population`, message: 'Ecology population must be non-negative finite number', action: 'clamp_ecology_population', data: { key } });
    if (!Number.isFinite(Number(pop.carryingCapacity)) || Number(pop.carryingCapacity) < 0) push({ code: 'invalid_ecology_capacity_value', path: `ecology.populations.byKey.${key}.carryingCapacity`, message: 'Ecology capacity must be non-negative finite number', action: 'clamp_ecology_capacity', data: { key } });
    if (locations[pop.locationId] && pop.speciesId) addUnique(expectedByLocation, pop.locationId, pop.speciesId);
  }
  const actual = ecology.populations?.byLocation || {};
  if (JSON.stringify(sortIndex(actual)) !== JSON.stringify(sortIndex(expectedByLocation))) push({ code: 'stale_ecology_location_index', path: 'ecology.populations.byLocation', message: 'Ecology byLocation index is stale', action: 'rebuild_ecology_location_index' });
}

function auditSimulationAndKernel(world, push, config) {
  if ((world.memory || []).length > config.memoryLimit) push({ code: 'world_memory_over_limit', path: 'memory', message: 'World memory exceeds limit', action: 'trim_memory' });
  if ((world.simulation?.reports || []).length > config.simulationReportLimit) push({ code: 'simulation_reports_over_limit', path: 'simulation.reports', message: 'Simulation reports exceed limit', action: 'trim_simulation_reports' });
  if ((world.kernel?.history || []).length > config.kernelHistoryLimit) push({ code: 'kernel_history_over_limit', path: 'kernel.history', message: 'Kernel history exceeds limit', action: 'trim_kernel_history' });
  if ((world.kernel?.contracts?.recentViolations || []).length > config.contractViolationLimit) push({ code: 'contract_violations_over_limit', path: 'kernel.contracts.recentViolations', message: 'Contract violations exceed limit', action: 'trim_contract_violations' });
}

function applyRepair(world, issue, config) {
  const action = issue.action;
  if (!action) return null;
  ensureBaseMaps(world);
  switch (action) {
    case 'normalize_tick': world.tick = Math.max(0, Number(world.tick || 0)); break;
    case 'create_map': setPath(world, issue.path, {}); break;
    case 'create_fallback_location': world.locations.void = { id: 'void', name: 'Void', resources: {} }; break;
    case 'replace_location': world.locations[issue.path.split('.')[1]] = { id: issue.path.split('.')[1], name: issue.path.split('.')[1], resources: {} }; break;
    case 'fix_location_id': world.locations[issue.data.locationId].id = issue.data.locationId; break;
    case 'create_resource_map': setPath(world, issue.path, {}); break;
    case 'clamp_resource': world.locations[issue.data.locationId].resources[issue.data.resource] = Math.max(0, Number(world.locations[issue.data.locationId].resources[issue.data.resource] || 0)); break;
    case 'remove_missing_neighbor': removeFromArray(world.locations[issue.data.locationId].neighbors, issue.data.neighborId); break;
    case 'remove_invalid_entity': delete world.entities[issue.data.entityId]; break;
    case 'fix_entity_id': world.entities[issue.data.entityId].id = issue.data.entityId; break;
    case 'set_entity_alive': world.entities[issue.data.entityId].status = 'alive'; break;
    case 'move_entity_to_fallback': ensureFallbackLocation(world, issue.data.fallbackLocationId); world.entities[issue.data.entityId].locationId = issue.data.fallbackLocationId; break;
    case 'clamp_entity_stat': world.entities[issue.data.entityId].stats[issue.data.stat] = Number(world.entities[issue.data.entityId].stats[issue.data.stat]) || 0; break;
    case 'rebuild_population_indexes': rebuildPopulationIndexes(world); break;
    case 'remove_weather_location': delete world.natural.weather.byLocation[issue.data.locationId]; break;
    case 'remove_active_disaster': delete world.natural.disasters.active[issue.data.id]; break;
    case 'trim_natural_weather_history': trimArray(world.natural.weather.history, config.naturalWeatherHistoryLimit); break;
    case 'trim_natural_disaster_history': trimArray(world.natural.disasters.history, config.naturalDisasterHistoryLimit); break;
    case 'remove_habitat_location': delete world.ecology.habitats.byLocation[issue.data.locationId]; break;
    case 'remove_ecology_population': delete world.ecology.populations.byKey[issue.data.key]; break;
    case 'clamp_ecology_population': world.ecology.populations.byKey[issue.data.key].population = Math.max(0, Number(world.ecology.populations.byKey[issue.data.key].population) || 0); break;
    case 'clamp_ecology_capacity': world.ecology.populations.byKey[issue.data.key].carryingCapacity = Math.max(0, Number(world.ecology.populations.byKey[issue.data.key].carryingCapacity) || 0); break;
    case 'rebuild_ecology_location_index': rebuildEcologyLocationIndex(world); break;
    case 'trim_memory': trimArray(world.memory, config.memoryLimit); break;
    case 'trim_simulation_reports': trimArray(world.simulation.reports, config.simulationReportLimit); break;
    case 'trim_kernel_history': trimArray(world.kernel.history, config.kernelHistoryLimit); break;
    case 'trim_contract_violations': trimArray(world.kernel.contracts.recentViolations, config.contractViolationLimit); break;
    default: return null;
  }
  return { code: issue.code, action, path: issue.path };
}

function buildConsistencyReport(world, issues, diagnostics, config, metadata = {}) {
  return {
    version: WORLD_CONSISTENCY_VERSION,
    tick: Number(world?.tick || 0),
    ok: issues.length === 0,
    dryRun: Boolean(metadata.dryRun),
    checkedAtTick: Number(world?.tick || 0),
    issues,
    diagnostics,
    issueCount: issues.length,
    repairableCount: issues.filter(issue => issue.repairable !== false).length,
    beforeIssues: metadata.beforeIssues ?? issues.length,
    repairs: metadata.repairs || [],
    repairedCount: (metadata.repairs || []).length,
    limits: {
      maxIssues: config.maxIssues,
      memoryLimit: config.memoryLimit,
      reportLimit: config.reportLimit,
    },
  };
}

function recordConsistencyReport(world, report, config) {
  const state = ensureWorldConsistencyState(world, config);
  state.lastCheckTick = report.tick;
  if (!report.dryRun && report.repairedCount > 0) state.lastRepairTick = report.tick;
  state.lastReport = compactReport(report);
  state.reports.push(compactReport(report));
  trimArray(state.reports, config.reportLimit);
  state.stats.checks += 1;
  state.stats.repairs += report.repairedCount;
  state.stats.issues += report.issueCount;
  return state;
}

function compactReport(report) {
  return {
    version: report.version,
    tick: report.tick,
    ok: report.ok,
    dryRun: report.dryRun,
    issueCount: report.issueCount,
    repairedCount: report.repairedCount,
    topIssues: (report.issues || []).slice(0, 10).map(issue => ({ code: issue.code, path: issue.path, action: issue.action })),
  };
}

function ensureBaseMaps(world) {
  if (!world.entities || typeof world.entities !== 'object') world.entities = {};
  if (!world.locations || typeof world.locations !== 'object') world.locations = {};
  if (!Array.isArray(world.memory)) world.memory = [];
}

function ensureFallbackLocation(world, id = 'void') {
  if (!world.locations[id]) world.locations[id] = { id, name: id === 'void' ? 'Void' : id, resources: {} };
}

function rebuildPopulationIndexes(world) {
  if (!world.population) world.population = {};
  if (!world.population.indexes) world.population.indexes = {};
  world.population.indexes.byAgeGroup = {};
  world.population.indexes.byGeneration = {};
  for (const [entityId, entity] of Object.entries(world.entities || {})) {
    const demo = entity.demographics || {};
    addUnique(world.population.indexes.byAgeGroup, demo.ageGroup || 'unknown', entityId);
    addUnique(world.population.indexes.byGeneration, String(demo.generation || 1), entityId);
  }
}

function rebuildEcologyLocationIndex(world) {
  if (!world.ecology?.populations) return;
  world.ecology.populations.byLocation = {};
  for (const pop of Object.values(world.ecology.populations.byKey || {})) {
    if (!pop || pop.population <= 0 || !pop.locationId || !pop.speciesId) continue;
    addUnique(world.ecology.populations.byLocation, pop.locationId, pop.speciesId);
  }
  for (const list of Object.values(world.ecology.populations.byLocation)) list.sort();
}

function sortIndex(index) {
  const out = {};
  for (const [key, values] of Object.entries(index || {}).sort(([a], [b]) => a.localeCompare(b))) out[key] = [...(values || [])].sort();
  return out;
}

function addUnique(index, key, value) {
  if (!index[key]) index[key] = [];
  if (!index[key].includes(value)) index[key].push(value);
}

function setPath(root, path, value) {
  const parts = String(path || '').split('.');
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!current[parts[index]] || typeof current[parts[index]] !== 'object') current[parts[index]] = {};
    current = current[parts[index]];
  }
  current[parts[parts.length - 1]] = value;
}

function removeFromArray(array, value) {
  if (!Array.isArray(array)) return;
  let index = array.indexOf(value);
  while (index >= 0) {
    array.splice(index, 1);
    index = array.indexOf(value);
  }
}

function trimArray(array, limit) {
  if (!Array.isArray(array)) return;
  while (array.length > Number(limit || 0)) array.shift();
}

function firstKey(object) {
  return Object.keys(object || {}).sort()[0] || null;
}

function mergeConsistencyOptions(options = {}) {
  return { ...DEFAULT_CONSISTENCY_OPTIONS, ...(options || {}) };
}

module.exports = {
  WORLD_CONSISTENCY_VERSION,
  DEFAULT_CONSISTENCY_OPTIONS,
  ensureWorldConsistencyState,
  createWorldConsistencyState,
  auditWorldConsistency,
  repairWorldConsistency,
  runWorldConsistencyCheck,
  getWorldConsistencySummary,
};
