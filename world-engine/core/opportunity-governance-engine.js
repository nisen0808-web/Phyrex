'use strict';

const DEFAULT_GOVERNANCE_OPPORTUNITY_OPTIONS = {
  highRiskThreshold: 0.62,
  resourcePressureThreshold: 0.55,
  migrationPressureThreshold: 0.45,
  conflictIntensityThreshold: 65,
  maxGovernanceOpportunitiesPerTick: 10,
};

function generateGovernanceOpportunities(world, options = {}, helpers = {}) {
  const config = { ...DEFAULT_GOVERNANCE_OPPORTUNITY_OPTIONS, ...(options || {}) };
  const createOpportunity = helpers.createOpportunity;
  const types = helpers.OPPORTUNITY_TYPES;
  if (!createOpportunity || !types) return [];
  const out = [];
  out.push(...generateGovernanceEnvironmentOpportunities(world, config, createOpportunity, types));
  out.push(...generateGovernanceProcessOpportunities(world, config, createOpportunity, types));
  out.push(...generateGovernanceConflictOpportunities(world, config, createOpportunity, types));
  return out.slice(0, Number(config.maxGovernanceOpportunitiesPerTick || DEFAULT_GOVERNANCE_OPPORTUNITY_OPTIONS.maxGovernanceOpportunitiesPerTick));
}

function generateGovernanceEnvironmentOpportunities(world, config, createOpportunity, types) {
  const out = [];
  const summary = world.governance?.environment;
  if (!summary?.byGovernment) return out;
  for (const [governmentId, env] of Object.entries(summary.byGovernment).sort(([left], [right]) => left.localeCompare(right))) {
    const government = world.governance?.governments?.[governmentId];
    const locationId = firstLocationForGovernment(world, government);
    if (Number(env.totalRisk || 0) >= Number(config.highRiskThreshold || 0.62)) {
      out.push(createGovernanceOpportunity(world, createOpportunity, {
        key: `governance:environment:${governmentId}:high_risk`,
        type: types.CRISIS,
        title: `public relief: ${government?.name || governmentId}`,
        locationId,
        targetId: governmentId,
        difficulty: Math.round(Number(env.totalRisk || 0) * 100),
        importance: 140,
        reward: { reputation: 100 },
        risk: { governance: Math.round(Number(env.totalRisk || 0) * 50) },
        tags: ['governance', 'public_relief', 'environment'],
        payload: { governmentId, environment: env },
      }));
    }
    if (Number(env.resourcePressure || 0) >= Number(config.resourcePressureThreshold || 0.55) || Number(env.pricePressure || 0) >= 0.55) {
      out.push(createGovernanceOpportunity(world, createOpportunity, {
        key: `governance:environment:${governmentId}:supply_route`,
        type: types.TRADE,
        title: `relief supply route: ${government?.name || governmentId}`,
        locationId,
        targetId: governmentId,
        difficulty: 55,
        importance: 95,
        reward: { currency: 120, reputation: 30 },
        risk: { shortage: Math.round(Math.max(Number(env.resourcePressure || 0), Number(env.pricePressure || 0)) * 40) },
        tags: ['governance', 'trade', 'relief_supply'],
        payload: { governmentId, resourcePressure: env.resourcePressure, pricePressure: env.pricePressure },
      }));
    }
    if (Number(env.migrationPressure || 0) >= Number(config.migrationPressureThreshold || 0.45)) {
      out.push(createGovernanceOpportunity(world, createOpportunity, {
        key: `governance:environment:${governmentId}:migration_support`,
        type: types.MIGRATION,
        title: `migration support: ${government?.name || governmentId}`,
        locationId,
        targetId: governmentId,
        difficulty: 50,
        importance: 90,
        reward: { reputation: 60 },
        risk: { travel: Math.round(Number(env.migrationPressure || 0) * 45) },
        tags: ['governance', 'migration', 'support'],
        payload: { governmentId, migrationPressure: env.migrationPressure },
      }));
    }
  }
  return out.filter(Boolean);
}

function generateGovernanceProcessOpportunities(world, config, createOpportunity, types) {
  const out = [];
  const processes = Object.values(world.processes?.byId || {})
    .filter(process => process.status === 'active')
    .filter(process => process.type === 'governance_response')
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  for (const process of processes) {
    const responseType = String(process.payload?.responseType || '');
    const governmentId = process.payload?.governmentId || process.ownerId;
    const locationId = first(process.payload?.locationIds) || firstLocationForGovernment(world, world.governance?.governments?.[governmentId]);
    if (responseType === 'disaster_relief') {
      out.push(createGovernanceOpportunity(world, createOpportunity, {
        key: `governance:process:${process.id}:relief_work`,
        type: types.CRISIS,
        title: `relief work: ${process.title}`,
        locationId,
        targetId: governmentId,
        difficulty: 45,
        importance: 115,
        reward: { reputation: 80, food: 20 },
        risk: { disaster: 35 },
        tags: ['governance', 'disaster_relief', 'process'],
        payload: { processId: process.id, responseType, governmentId },
      }));
    }
    if (responseType === 'public_works') {
      out.push(createGovernanceOpportunity(world, createOpportunity, {
        key: `governance:process:${process.id}:public_works`,
        type: types.CRISIS,
        title: `public works contract: ${process.title}`,
        locationId,
        targetId: governmentId,
        difficulty: 55,
        importance: 100,
        reward: { currency: 100, reputation: 40 },
        risk: { labor: 25 },
        tags: ['governance', 'public_works', 'process'],
        payload: { processId: process.id, responseType, governmentId },
      }));
    }
    if (responseType === 'rationing') {
      out.push(createGovernanceOpportunity(world, createOpportunity, {
        key: `governance:process:${process.id}:ration_logistics`,
        type: types.TRADE,
        title: `ration logistics: ${process.title}`,
        locationId,
        targetId: governmentId,
        difficulty: 50,
        importance: 85,
        reward: { currency: 80, reputation: 30 },
        risk: { shortage: 35 },
        tags: ['governance', 'rationing', 'logistics'],
        payload: { processId: process.id, responseType, governmentId },
      }));
    }
    if (responseType === 'security_crackdown' || responseType === 'mobilization') {
      out.push(createGovernanceOpportunity(world, createOpportunity, {
        key: `governance:process:${process.id}:mediation`,
        type: types.ALLIANCE,
        title: `stabilization channel: ${process.title}`,
        locationId,
        targetId: governmentId,
        difficulty: 65,
        importance: 95,
        reward: { reputation: 70, authority: 10 },
        risk: { negotiation: 45 },
        tags: ['governance', 'stabilization', responseType],
        payload: { processId: process.id, responseType, governmentId },
      }));
    }
  }
  return out.filter(Boolean);
}

function generateGovernanceConflictOpportunities(world, config, createOpportunity, types) {
  const out = [];
  const conflicts = Object.values(world.conflicts?.byId || {})
    .filter(conflict => conflict.status !== 'resolved')
    .filter(conflict => Number(conflict.intensity || 0) >= Number(config.conflictIntensityThreshold || 65) || conflict.tags?.some(tag => ['governance_suppressed', 'governance_mobilization'].includes(tag)))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  for (const conflict of conflicts) {
    out.push(createGovernanceOpportunity(world, createOpportunity, {
      key: `governance:conflict:${conflict.id}:mediation`,
      type: types.ALLIANCE,
      title: `conflict mediation: ${conflict.title}`,
      locationId: first(conflict.locationIds),
      targetId: conflict.id,
      difficulty: Math.min(95, 45 + Math.round(Number(conflict.intensity || 0) * 0.25)),
      importance: 100 + Math.round(Number(conflict.intensity || 0) * 0.25),
      reward: { reputation: 90, authority: 15 },
      risk: { conflict: Math.round(Number(conflict.intensity || 0) * 0.35) },
      tags: ['governance', 'conflict', 'mediation'],
      payload: { conflictId: conflict.id, intensity: conflict.intensity, conflictType: conflict.type },
    }));
  }
  return out.filter(Boolean);
}

function createGovernanceOpportunity(world, createOpportunity, input) {
  if (!input.key) return null;
  if (hasExistingGovernanceOpportunity(world, input.key)) return null;
  return createOpportunity(world, {
    type: input.type,
    title: input.title,
    locationId: input.locationId || null,
    targetId: input.targetId || null,
    difficulty: input.difficulty,
    importance: input.importance,
    reward: input.reward,
    risk: input.risk,
    visibility: input.visibility ?? 65,
    durationTicks: input.durationTicks || 180,
    tags: ['governance_generated', ...(input.tags || [])],
    payload: { governanceOpportunityKey: input.key, ...(input.payload || {}) },
  });
}

function hasExistingGovernanceOpportunity(world, key) {
  return Object.values(world.opportunities?.byId || {}).some(opportunity => opportunity.payload?.governanceOpportunityKey === key && ['active', 'claimed'].includes(opportunity.status));
}

function firstLocationForGovernment(world, government) {
  if (!government) return null;
  for (const cityId of government.cityIds || []) {
    const city = world.cities?.byId?.[cityId];
    if (city?.locationId) return city.locationId;
  }
  const org = world.organizations?.byId?.[government.organizationId];
  return org?.homeLocationId || null;
}

function first(items) {
  return Array.isArray(items) && items.length ? items[0] : null;
}

module.exports = {
  DEFAULT_GOVERNANCE_OPPORTUNITY_OPTIONS,
  generateGovernanceOpportunities,
};
