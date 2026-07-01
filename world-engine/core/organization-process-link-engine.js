'use strict';

const DEFAULT_ORGANIZATION_PROCESS_LINK_OPTIONS = {
  maxProcessRecruitsPerOrganizationTick: 3,
  minProcessRecruitScore: 28,
  processMemoryLimit: 300,
};

function ensureOrganizationProcessStats(world) {
  if (!world.organizations) world.organizations = { byId: {}, indexes: { byType: {}, byStatus: {}, byMember: {}, byLocation: {} }, stats: { created: 0, dissolved: 0 } };
  if (!world.organizations.stats || typeof world.organizations.stats !== 'object') world.organizations.stats = { created: 0, dissolved: 0 };
  if (world.organizations.stats.processLinkedRecruits === undefined) world.organizations.stats.processLinkedRecruits = 0;
  if (world.organizations.stats.processSupportActions === undefined) world.organizations.stats.processSupportActions = 0;
  return world.organizations.stats;
}

function processOrganizationLinkedProcesses(world, organization, options = {}, helpers = {}) {
  ensureOrganizationProcessStats(world);
  const config = { ...DEFAULT_ORGANIZATION_PROCESS_LINK_OPTIONS, ...(options || {}) };
  const processes = getActiveLinkedProcesses(world, organization);
  const actions = [];
  let recruits = 0;
  for (const process of processes) {
    const responseType = String(process.payload?.responseType || '');
    const effect = applyOrganizationProcessEffect(world, organization, process, responseType);
    if (effect) actions.push(effect);
    const role = roleForProcess(organization, responseType);
    if (!role) continue;
    const limit = Math.max(0, Number(config.maxProcessRecruitsPerOrganizationTick || 0) - recruits);
    if (limit <= 0) continue;
    const candidates = rankProcessRecruitCandidates(world, organization, process, role)
      .filter(item => item.score >= Number(config.minProcessRecruitScore || DEFAULT_ORGANIZATION_PROCESS_LINK_OPTIONS.minProcessRecruitScore))
      .slice(0, limit);
    for (const candidate of candidates) {
      helpers.addOrganizationMember(world, organization.id, candidate.entity.id, { role, createContract: true });
      recruits += 1;
      actions.push({ type: 'process_recruit', processId: process.id, responseType, entityId: candidate.entity.id, role, score: round(candidate.score) });
    }
  }
  if (actions.length && helpers.recordOrganizationMemory) {
    helpers.recordOrganizationMemory(world, organization, 'organization.process_link', { actions });
  }
  world.organizations.stats.processLinkedRecruits += recruits;
  world.organizations.stats.processSupportActions += actions.length;
  trimProcessLinkMemory(organization, config);
  return actions;
}

function getActiveLinkedProcesses(world, organization) {
  return Object.values(world.processes?.byId || {})
    .filter(process => process.status === 'active')
    .filter(process => process.type === 'governance_response')
    .filter(process => process.payload?.organizationId === organization.id || process.ownerId === organization.id || process.payload?.governmentId && isGovernmentOrganization(world, process.payload.governmentId, organization.id))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function applyOrganizationProcessEffect(world, organization, process, responseType) {
  const severity = clamp(Number(process.payload?.severity || 0.1), 0, 1);
  const progress = clamp(Number(process.progress || 0) / 100, 0, 1);
  const scale = 0.5 + severity + progress * 0.5;
  const before = { cohesion: Number(organization.cohesion || 0), reputation: Number(organization.reputation || 0), authority: Number(organization.authority || 0), currency: Number(organization.assets?.currency || 0) };
  if (!organization.assets) organization.assets = {};

  if (responseType === 'disaster_relief') {
    organization.reputation = round(Number(organization.reputation || 0) + 4 * scale);
    organization.cohesion = clamp(Number(organization.cohesion || 0) + 1.5 * scale, 0, 100);
  } else if (responseType === 'public_works') {
    organization.assets.currency = round(Number(organization.assets.currency || 0) + 18 * scale);
    organization.reputation = round(Number(organization.reputation || 0) + 2.5 * scale);
  } else if (responseType === 'rationing') {
    organization.reputation = round(Number(organization.reputation || 0) + 1.8 * scale);
    organization.cohesion = clamp(Number(organization.cohesion || 0) + 0.8 * scale, 0, 100);
  } else if (responseType === 'security_crackdown') {
    organization.authority = round(Number(organization.authority || 0) + 2.5 * scale);
    organization.cohesion = clamp(Number(organization.cohesion || 0) + 0.5 * scale, 0, 100);
  } else if (responseType === 'mobilization') {
    organization.authority = round(Number(organization.authority || 0) + 3.2 * scale);
    organization.cohesion = clamp(Number(organization.cohesion || 0) + 2.2 * scale, 0, 100);
  } else {
    return null;
  }

  return {
    type: 'process_support',
    processId: process.id,
    responseType,
    deltas: {
      cohesion: round(Number(organization.cohesion || 0) - before.cohesion),
      reputation: round(Number(organization.reputation || 0) - before.reputation),
      authority: round(Number(organization.authority || 0) - before.authority),
      currency: round(Number(organization.assets.currency || 0) - before.currency),
    },
  };
}

function rankProcessRecruitCandidates(world, organization, process, role) {
  const locations = new Set([organization.homeLocationId, ...(process.payload?.locationIds || [])].filter(Boolean));
  return Object.values(world.entities || {})
    .filter(entity => entity.status === 'alive')
    .filter(entity => !organization.members.includes(entity.id))
    .map(entity => ({ entity, score: scoreProcessRecruitCandidate(entity, locations, role) }))
    .sort((left, right) => right.score - left.score || String(left.entity.id).localeCompare(String(right.entity.id)));
}

function scoreProcessRecruitCandidate(entity, locations, role) {
  const sameLocation = locations.has(entity.locationId) ? 20 : 0;
  const social = Number(entity.stats?.social || 0);
  const intelligence = Number(entity.stats?.intelligence || 0);
  const power = Number(entity.stats?.power || 0);
  const health = Number(entity.stats?.health || 0) / Math.max(1, Number(entity.stats?.maxHealth || 100)) * 20;
  let roleScore = 0;
  if (['relief_worker', 'logistics'].includes(role)) roleScore = social * 0.5 + intelligence * 0.5 + health;
  else if (['worker', 'engineer'].includes(role)) roleScore = power * 0.35 + intelligence * 0.55 + health;
  else if (['guard', 'auxiliary'].includes(role)) roleScore = power * 0.75 + social * 0.2 + health;
  else roleScore = social * 0.4 + intelligence * 0.3 + power * 0.3;
  return sameLocation + roleScore;
}

function roleForProcess(organization, responseType) {
  if (responseType === 'disaster_relief') return 'relief_worker';
  if (responseType === 'rationing') return 'logistics';
  if (responseType === 'public_works') return organization.type === 'school' ? 'engineer' : 'worker';
  if (responseType === 'security_crackdown') return organization.type === 'state' ? 'guard' : 'member';
  if (responseType === 'mobilization') return organization.type === 'state' ? 'auxiliary' : 'member';
  return null;
}

function isGovernmentOrganization(world, governmentId, organizationId) {
  return world.governance?.governments?.[governmentId]?.organizationId === organizationId;
}

function trimProcessLinkMemory(organization, config) {
  const limit = Number(config.processMemoryLimit || DEFAULT_ORGANIZATION_PROCESS_LINK_OPTIONS.processMemoryLimit);
  while (organization.memory.length > limit) organization.memory.shift();
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value || 0))); }

module.exports = {
  DEFAULT_ORGANIZATION_PROCESS_LINK_OPTIONS,
  ensureOrganizationProcessStats,
  processOrganizationLinkedProcesses,
  getActiveLinkedProcesses,
  roleForProcess,
};
