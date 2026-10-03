'use strict';
// Frozen 441d2d0 all-candidates sort, for exact link/order/statistics comparisons.
const { ensureInfoFlowState, DEFAULT_INFO_FLOW_OPTIONS } = require('../../core/info-flow-engine');

function buildInfoFlowLinks(world, options = {}) {
  const links = [];
  const seen = new Set();
  const groups = groupAliveEntitiesByLocation(world);
  for (const [locationId, entityIds] of Object.entries(groups)) {
    const city = findCityByLocation(world, locationId);
    for (const sourceId of entityIds) {
      for (const targetId of entityIds) {
        if (sourceId !== targetId) pushLink(world, links, seen, 'entity', sourceId, 'entity', targetId, 'same_location', 65);
      }
      if (city) {
        pushLink(world, links, seen, 'entity', sourceId, 'city', city.id, 'local_city', 55);
        pushLink(world, links, seen, 'city', city.id, 'entity', sourceId, 'city_context', 35);
      }
      for (const orgId of getEntityOrganizationIds(world, sourceId)) {
        pushLink(world, links, seen, 'entity', sourceId, 'organization', orgId, 'member_to_organization', 60);
        pushLink(world, links, seen, 'organization', orgId, 'entity', sourceId, 'organization_to_member', 55);
        if (city) pushLink(world, links, seen, 'organization', orgId, 'city', city.id, 'organization_city', 40);
      }
    }
  }
  return links
    .sort((left, right) => right.weight - left.weight || linkKey(left).localeCompare(linkKey(right)))
    .slice(0, Math.max(0, Number(options.maxLinksPerTick || DEFAULT_INFO_FLOW_OPTIONS.maxLinksPerTick)));
}

function pushLink(world, links, seen, sourceType, sourceId, targetType, targetId, reason, weight) {
  if (!sourceId || !targetId) return;
  const link = { sourceType, sourceId, targetType, targetId, reason, weight: Number(weight || 0) };
  const key = linkKey(link);
  if (seen.has(key)) return;
  seen.add(key);
  links.push(link);
  const state = ensureInfoFlowState(world);
  state.stats.linksCreated += 1;
}


function groupAliveEntitiesByLocation(world) {
  const groups = {};
  for (const entity of Object.values(world.entities || {})) {
    if (entity.status !== 'alive') continue;
    const locationId = entity.locationId || 'unknown';
    if (!groups[locationId]) groups[locationId] = [];
    groups[locationId].push(entity.id);
  }
  return groups;
}

function getEntityOrganizationIds(world, entityId) {
  const entity = world.entities?.[entityId];
  const ids = new Set(entity?.organizationIds || []);
  for (const org of Object.values(world.organizations?.byId || {})) {
    if ((org.members || []).includes(entityId)) ids.add(org.id);
  }
  return Array.from(ids).filter(id => world.organizations?.byId?.[id]);
}

function findCityByLocation(world, locationId) {
  return Object.values(world.cities?.byId || {}).find(city => city.locationId === locationId) || null;
}


function linkKey(link) {
  return `${link.sourceType}:${link.sourceId}->${link.targetType}:${link.targetId}:${link.reason}`;
}


module.exports = { buildInfoFlowLinks };
