'use strict';

const { nextWorldId } = require('./world-id-engine');

const GOVERNANCE_PROCESS_VERSION = 1;

const GOVERNANCE_PROCESS_TYPES = {
  DISASTER_RELIEF: 'disaster_relief',
  PUBLIC_WORKS: 'public_works',
  RATIONING: 'rationing',
  SECURITY_CRACKDOWN: 'security_crackdown',
  TAX_ADJUSTMENT: 'tax_adjustment',
  MOBILIZATION: 'mobilization',
};

const DEFAULT_GOVERNANCE_PROCESS_OPTIONS = {
  maxGovernanceResponseIds: 3000,
  defaultDurationTicks: 8,
  minimumProgressPerTick: 4,
  maximumProgressPerTick: 28,
};

function ensureGovernanceProcessState(world) {
  if (!world.processes || typeof world.processes !== 'object') {
    world.processes = {
      byId: {},
      indexes: { byType: {}, byStatus: {}, byParticipant: {}, byOwner: {} },
      consumedMemoryIds: [],
      stats: { created: 0, updated: 0, resolved: 0, stalled: 0, pruned: 0 },
    };
  }
  if (!Array.isArray(world.processes.consumedGovernanceResponseIds)) world.processes.consumedGovernanceResponseIds = [];
  if (!world.processes.stats || typeof world.processes.stats !== 'object') world.processes.stats = { created: 0, updated: 0, resolved: 0, stalled: 0, pruned: 0 };
  if (world.processes.stats.governanceResponsesIngested === undefined) world.processes.stats.governanceResponsesIngested = 0;
  if (world.processes.stats.governanceProcessesAdvanced === undefined) world.processes.stats.governanceProcessesAdvanced = 0;
  return world.processes;
}

function ingestGovernanceResponsesAsProcesses(world, options = {}, helpers = {}) {
  const state = ensureGovernanceProcessState(world);
  const config = { ...DEFAULT_GOVERNANCE_PROCESS_OPTIONS, ...(options || {}) };
  const consumed = new Set(state.consumedGovernanceResponseIds || []);
  const created = [];
  const updated = [];
  const log = (Array.isArray(world.governance?.responseLog) ? world.governance.responseLog : [])
    .filter(response => response && response.id)
    .sort(compareResponses);

  for (const response of log) {
    if (consumed.has(response.id)) continue;
    const descriptor = describeGovernanceResponseProcess(world, response, helpers.processType || 'governance_response');
    if (!descriptor) {
      consumed.add(response.id);
      continue;
    }
    let process = helpers.findActiveProcess?.(world, descriptor.type, descriptor.ownerType, descriptor.ownerId, descriptor.key) || null;
    if (!process) {
      process = helpers.createProcess(world, {
        id: nextWorldId(world, 'process', `process.${descriptor.type}`),
        type: descriptor.type,
        title: descriptor.title,
        ownerType: descriptor.ownerType,
        ownerId: descriptor.ownerId,
        participants: descriptor.participants,
        sourceIds: [response.id],
        tags: descriptor.tags,
        payload: descriptor.payload,
      });
      created.push(process);
    }

    mergeGovernanceResponseIntoProcess(process, response, descriptor);
    helpers.addProcessStep(world, process.id, {
      tick: response.tick ?? world.tick,
      sourceId: response.id,
      type: `governance.response.${response.type}`,
      importance: descriptor.importance,
      participants: descriptor.participants,
      payload: descriptor.payload,
    }, options);
    updated.push(process);
    consumed.add(response.id);
  }

  state.consumedGovernanceResponseIds = Array.from(consumed).slice(-Number(config.maxGovernanceResponseIds || DEFAULT_GOVERNANCE_PROCESS_OPTIONS.maxGovernanceResponseIds));
  state.stats.governanceResponsesIngested += updated.length;
  return { created, updated };
}

function describeGovernanceResponseProcess(world, response, processType) {
  const government = response.governmentId ? world.governance?.governments?.[response.governmentId] : null;
  const responseType = String(response.type || '').trim();
  if (!responseType) return null;
  const governmentId = response.governmentId || response.organizationId || 'world';
  const cityIds = normalizeList(response.cityIds);
  const locationIds = normalizeList(response.locationIds);
  const participants = collectGovernanceParticipants(world, response, government);
  const key = `governance:${governmentId}:${responseType}:${cityIds.join('|') || locationIds.join('|') || 'world'}`;
  const severity = clamp(Number(response.severity || response.inputs?.totalRisk || 0.1), 0, 1);
  return {
    type: processType,
    key,
    title: `${responseType}: ${government?.name || governmentId}`,
    ownerType: 'government',
    ownerId: governmentId,
    participants,
    tags: ['governance', 'governance_response', responseType],
    importance: responseImportance(responseType, severity),
    payload: {
      version: GOVERNANCE_PROCESS_VERSION,
      key,
      responseType,
      governmentId,
      organizationId: response.organizationId || government?.organizationId || null,
      cityIds,
      locationIds,
      severity,
      startedByResponseId: response.id,
      lastResponseId: response.id,
      lastResponseTick: Number(response.tick ?? world.tick ?? 0),
      responseCount: 1,
      durationTicks: durationForResponse(responseType, severity),
      ticksAdvanced: 0,
      effectsApplied: {},
    },
  };
}

function mergeGovernanceResponseIntoProcess(process, response, descriptor) {
  if (!process.payload || typeof process.payload !== 'object') process.payload = {};
  process.payload.version = GOVERNANCE_PROCESS_VERSION;
  process.payload.key = descriptor.key;
  process.payload.responseType = descriptor.payload.responseType;
  process.payload.governmentId = descriptor.payload.governmentId;
  process.payload.organizationId = descriptor.payload.organizationId;
  process.payload.cityIds = unique([...(process.payload.cityIds || []), ...(descriptor.payload.cityIds || [])]);
  process.payload.locationIds = unique([...(process.payload.locationIds || []), ...(descriptor.payload.locationIds || [])]);
  process.payload.severity = Math.max(Number(process.payload.severity || 0), Number(descriptor.payload.severity || 0));
  process.payload.durationTicks = Math.max(Number(process.payload.durationTicks || 0), Number(descriptor.payload.durationTicks || 0));
  process.payload.lastResponseId = response.id;
  process.payload.lastResponseTick = Number(response.tick ?? 0);
  process.payload.responseCount = Number(process.payload.responseCount || 0) + 1;
  return process;
}

function updateGovernanceProcessProgress(world, process, options = {}) {
  ensureGovernanceProcessState(world);
  const config = { ...DEFAULT_GOVERNANCE_PROCESS_OPTIONS, ...(options || {}) };
  const payload = process.payload || {};
  const severity = clamp(Number(payload.severity || 0.1), 0, 1);
  const duration = Math.max(2, Number(payload.durationTicks || config.defaultDurationTicks || 8));
  const increment = clamp((100 / duration) * (0.75 + severity * 0.5), config.minimumProgressPerTick, config.maximumProgressPerTick);
  const effects = applyGovernanceProcessTickEffects(world, process, increment, config);
  process.progress = clamp(Number(process.progress || 0) + increment, 0, 100);
  process.lastUpdatedAt = world.tick;
  process.payload.ticksAdvanced = Number(process.payload.ticksAdvanced || 0) + 1;
  process.payload.lastTickEffects = effects;
  if (!process.payload.effectsApplied || typeof process.payload.effectsApplied !== 'object') process.payload.effectsApplied = {};
  for (const [key, value] of Object.entries(effects || {})) {
    if (typeof value === 'number') process.payload.effectsApplied[key] = round(Number(process.payload.effectsApplied[key] || 0) + value);
  }
  world.processes.stats.governanceProcessesAdvanced += 1;
  return process;
}

function applyGovernanceProcessTickEffects(world, process, increment, _config = {}) {
  const payload = process.payload || {};
  const type = payload.responseType;
  const severity = clamp(Number(payload.severity || 0.1), 0, 1);
  const government = payload.governmentId ? world.governance?.governments?.[payload.governmentId] : null;
  const org = payload.organizationId ? world.organizations?.byId?.[payload.organizationId] : null;
  const cityIds = normalizeList(payload.cityIds);
  const locationIds = normalizeList(payload.locationIds);
  const effectScale = clamp(increment / 100, 0.01, 0.35) * (0.8 + severity);
  const effects = {};

  if (type === GOVERNANCE_PROCESS_TYPES.DISASTER_RELIEF) {
    for (const locationId of locationIds) {
      const location = world.locations?.[locationId];
      if (!location) continue;
      if (!location.resources) location.resources = {};
      const food = round(12 * effectScale, 3);
      const water = round(14 * effectScale, 3);
      location.resources.food = round(Number(location.resources.food || 0) + food, 3);
      location.resources.water = round(Number(location.resources.water || 0) + water, 3);
      effects.foodAdded = round(Number(effects.foodAdded || 0) + food, 3);
      effects.waterAdded = round(Number(effects.waterAdded || 0) + water, 3);
    }
    if (government) {
      government.services = clamp(Number(government.services || 0) + 4 * effectScale, 0, 100);
      government.legitimacy = clamp(Number(government.legitimacy || 0) + 2 * effectScale, 0, 100);
      government.unrest = clamp(Number(government.unrest || 0) - 3 * effectScale, 0, 100);
      effects.unrestDelta = round(Number(effects.unrestDelta || 0) - 3 * effectScale, 3);
    }
  }

  if (type === GOVERNANCE_PROCESS_TYPES.PUBLIC_WORKS) {
    for (const cityId of cityIds) {
      const city = world.cities?.byId?.[cityId];
      if (!city) continue;
      const infrastructureGain = round(5 * effectScale, 3);
      const stabilityGain = round(3 * effectScale, 3);
      city.infrastructure = round(clamp(Number(city.infrastructure || 0) + infrastructureGain, 0, 1000000), 3);
      city.stability = round(clamp(Number(city.stability || 0) + stabilityGain, 0, 100), 3);
      if (city.maintenance) city.maintenance.gap = round(clamp(Number(city.maintenance.gap || 0) - 0.04 * effectScale, 0, 1), 3);
      effects.infrastructureGain = round(Number(effects.infrastructureGain || 0) + infrastructureGain, 3);
      effects.stabilityGain = round(Number(effects.stabilityGain || 0) + stabilityGain, 3);
    }
  }

  if (type === GOVERNANCE_PROCESS_TYPES.RATIONING) {
    const food = world.economy?.markets?.global?.resources?.food;
    if (food) {
      const before = Number(food.demand || 0);
      food.demand = round(Math.max(1, before * (1 - 0.035 * effectScale)), 3);
      effects.foodDemandReduced = round(before - food.demand, 3);
    }
    for (const locationId of locationIds) {
      const location = world.locations?.[locationId];
      if (!location) continue;
      if (!location.meta) location.meta = {};
      location.meta.rationingProcessTick = Number(world.tick || 0);
      location.meta.rationingProcessSeverity = severity;
    }
  }

  if (type === GOVERNANCE_PROCESS_TYPES.SECURITY_CRACKDOWN) {
    for (const cityId of cityIds) {
      const city = world.cities?.byId?.[cityId];
      if (!city) continue;
      const securityGain = round(4 * effectScale, 3);
      city.security = round(clamp(Number(city.security || 0) + securityGain, 0, 100), 3);
      effects.securityGain = round(Number(effects.securityGain || 0) + securityGain, 3);
    }
    if (government) {
      government.enforcement = clamp(Number(government.enforcement || 0) + 4 * effectScale, 0, 100);
      government.unrest = clamp(Number(government.unrest || 0) - 4 * effectScale, 0, 100);
      government.legitimacy = clamp(Number(government.legitimacy || 0) - 0.8 * effectScale, 0, 100);
      effects.unrestDelta = round(Number(effects.unrestDelta || 0) - 4 * effectScale, 3);
    }
  }

  if (type === GOVERNANCE_PROCESS_TYPES.TAX_ADJUSTMENT && government) {
    const relief = Number(government.policies?.taxRate || 0) <= 40 ? 2 : 0.5;
    government.legitimacy = clamp(Number(government.legitimacy || 0) + relief * effectScale, 0, 100);
    government.unrest = clamp(Number(government.unrest || 0) - relief * effectScale, 0, 100);
    effects.unrestDelta = round(Number(effects.unrestDelta || 0) - relief * effectScale, 3);
  }

  if (type === GOVERNANCE_PROCESS_TYPES.MOBILIZATION) {
    if (org) {
      org.cohesion = clamp(Number(org.cohesion || 0) + 3 * effectScale, 0, 100);
      effects.cohesionGain = round(3 * effectScale, 3);
    }
    if (government) {
      government.enforcement = clamp(Number(government.enforcement || 0) + 3 * effectScale, 0, 100);
      government.services = clamp(Number(government.services || 0) + 1.5 * effectScale, 0, 100);
    }
    for (const cityId of cityIds) {
      const city = world.cities?.byId?.[cityId];
      if (!city) continue;
      const securityGain = round(2.5 * effectScale, 3);
      city.security = round(clamp(Number(city.security || 0) + securityGain, 0, 100), 3);
      effects.securityGain = round(Number(effects.securityGain || 0) + securityGain, 3);
    }
  }

  return effects;
}

function collectGovernanceParticipants(world, response, government = null) {
  const ids = new Set();
  for (const id of response.participants || []) ids.add(id);
  for (const id of government?.subjectEntityIds || []) ids.add(id);
  const org = response.organizationId ? world.organizations?.byId?.[response.organizationId] : null;
  if (org?.leaderId) ids.add(org.leaderId);
  return Array.from(ids).filter(Boolean).slice(0, 200);
}

function durationForResponse(type, severity) {
  const base = {
    disaster_relief: 6,
    rationing: 8,
    public_works: 14,
    security_crackdown: 7,
    tax_adjustment: 5,
    mobilization: 10,
  }[type] || DEFAULT_GOVERNANCE_PROCESS_OPTIONS.defaultDurationTicks;
  return Math.max(2, Math.round(base * (0.8 + clamp(severity, 0, 1) * 0.6)));
}

function responseImportance(type, severity) {
  const base = {
    disaster_relief: 110,
    rationing: 85,
    public_works: 95,
    security_crackdown: 90,
    tax_adjustment: 60,
    mobilization: 100,
  }[type] || 50;
  return Math.round(base * (0.8 + clamp(severity, 0, 1) * 0.4));
}

function compareResponses(left, right) {
  const tick = Number(left.tick || 0) - Number(right.tick || 0);
  return tick || String(left.id).localeCompare(String(right.id));
}

function normalizeList(value) {
  return Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean).sort() : [];
}
function unique(items) { return Array.from(new Set((items || []).filter(Boolean))).sort(); }
function round(value, digits = 3) { const factor = 10 ** digits; return Math.round(Number(value || 0) * factor) / factor; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value || 0))); }

module.exports = {
  GOVERNANCE_PROCESS_VERSION,
  GOVERNANCE_PROCESS_TYPES,
  DEFAULT_GOVERNANCE_PROCESS_OPTIONS,
  ensureGovernanceProcessState,
  ingestGovernanceResponsesAsProcesses,
  describeGovernanceResponseProcess,
  updateGovernanceProcessProgress,
  applyGovernanceProcessTickEffects,
};
