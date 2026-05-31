'use strict';

const { changeRelationship, getRelationship } = require('./relationship-engine');
const { getFamily, getFamilyChronicle, updateFamilyStatuses } = require('./family-engine');
const { recordLifeEvent, LIFE_EVENT_TYPES } = require('./history-engine');

const DEFAULT_LEGACY_OPTIONS = {
  resourceInheritanceRate: 0.85,
  reputationInheritanceRate: 0.35,
  debtInheritanceRate: 0.4,
  hatredInheritanceRate: 0.28,
  loyaltyInheritanceRate: 0.2,
  maxInheritedRelationshipMagnitude: 50,
  maxLegacyRecordsPerEntity: 50,
};

const LEGACY_STATUS = {
  PENDING: 'pending',
  SETTLED: 'settled',
  DISPUTED: 'disputed',
  FAILED: 'failed',
};

function ensureLegacyState(world) {
  if (!world.legacy) {
    world.legacy = {
      records: {},
      byEntity: {},
      byFamily: {},
      pending: [],
      settled: [],
      disputes: [],
      stats: {
        created: 0,
        settled: 0,
        disputed: 0,
      },
    };
  }
  return world.legacy;
}

function createLegacyRecord(world, deceasedId, options = {}) {
  const entity = world.entities[deceasedId];
  if (!entity) throw new Error(`Missing deceased entity ${deceasedId}`);

  const legacy = ensureLegacyState(world);
  const familyId = entity.familyId || entity.demographics?.familyId || null;
  const heirs = chooseLegacyHeirs(world, deceasedId, options);
  const record = {
    id: options.id || `legacy_${world.tick}_${deceasedId}`,
    deceasedId,
    familyId,
    status: heirs.length ? LEGACY_STATUS.PENDING : LEGACY_STATUS.FAILED,
    createdAt: world.tick,
    settledAt: null,
    heirs,
    estate: snapshotEstate(entity),
    relationshipLegacy: snapshotRelationshipLegacy(world, deceasedId, options),
    goalLegacy: snapshotGoalLegacy(entity),
    reputationLegacy: snapshotReputationLegacy(world, entity),
    disputes: [],
    payload: { ...(options.payload || {}) },
  };

  legacy.records[record.id] = record;
  addIndex(legacy.byEntity, deceasedId, record.id);
  if (familyId) addIndex(legacy.byFamily, familyId, record.id);
  if (record.status === LEGACY_STATUS.PENDING) legacy.pending.push(record.id);
  legacy.stats.created += 1;

  recordLifeEvent(world, {
    entityId: deceasedId,
    type: LIFE_EVENT_TYPES.WORLD_EVENT,
    title: 'legacy created',
    summary: `${entity.name || deceasedId} left a legacy record for future inheritance.`,
    importance: 90,
    participants: [deceasedId, ...heirs.map(h => h.entityId)],
    locationId: entity.locationId,
    tags: ['legacy', 'inheritance'],
    payload: { legacyId: record.id, familyId, heirs },
  });

  return record;
}

function settleLegacy(world, legacyId, options = {}) {
  const legacy = ensureLegacyState(world);
  const record = legacy.records[legacyId];
  if (!record) throw new Error(`Missing legacy record ${legacyId}`);
  if (record.status !== LEGACY_STATUS.PENDING && options.force !== true) return record;

  const heirs = record.heirs.map(h => ({ ...h, entity: world.entities[h.entityId] })).filter(h => h.entity && h.entity.status === 'alive');
  if (!heirs.length) {
    record.status = LEGACY_STATUS.FAILED;
    return record;
  }

  const totalWeight = heirs.reduce((sum, heir) => sum + Number(heir.weight || 1), 0) || 1;
  for (const heir of heirs) {
    const share = Number(heir.weight || 1) / totalWeight;
    inheritResources(world, record, heir.entity, share, options);
    inheritRelationships(world, record, heir.entity, share, options);
    inheritGoals(world, record, heir.entity, share, options);
    inheritReputation(world, record, heir.entity, share, options);

    recordLifeEvent(world, {
      entityId: heir.entityId,
      type: LIFE_EVENT_TYPES.WORLD_EVENT,
      title: 'received inheritance',
      summary: `${heir.entity.name || heir.entityId} inherited part of ${record.deceasedId}'s legacy.`,
      importance: 70,
      participants: [record.deceasedId, heir.entityId],
      locationId: heir.entity.locationId,
      tags: ['legacy', 'inheritance'],
      payload: { legacyId: record.id, share },
    });
  }

  record.status = LEGACY_STATUS.SETTLED;
  record.settledAt = world.tick;
  legacy.pending = legacy.pending.filter(id => id !== legacyId);
  if (!legacy.settled.includes(legacyId)) legacy.settled.push(legacyId);
  legacy.stats.settled += 1;

  if (record.familyId) updateFamilyStatuses(world);
  return record;
}

function processPendingLegacies(world, options = {}) {
  const legacy = ensureLegacyState(world);
  const settled = [];
  const failed = [];
  for (const legacyId of [...legacy.pending]) {
    const record = settleLegacy(world, legacyId, options);
    if (record.status === LEGACY_STATUS.SETTLED) settled.push(record);
    if (record.status === LEGACY_STATUS.FAILED) failed.push(record);
  }
  return { settled, failed, pending: legacy.pending.length };
}

function createLegacyForRecentDeaths(world, options = {}) {
  const legacy = ensureLegacyState(world);
  const created = [];
  for (const entity of Object.values(world.entities)) {
    if (entity.status !== 'dead') continue;
    if (legacy.byEntity[entity.id]?.length) continue;
    const deathTick = entity.demographics?.deathTick;
    if (deathTick !== null && deathTick !== undefined && world.tick - deathTick > (options.maxDeathAgeTicks || 10)) continue;
    created.push(createLegacyRecord(world, entity.id, options));
  }
  return created;
}

function chooseLegacyHeirs(world, deceasedId, options = {}) {
  const deceased = world.entities[deceasedId];
  if (!deceased) return [];
  const familyId = deceased.familyId || deceased.demographics?.familyId || null;
  const family = familyId ? getFamily(world, familyId) : null;
  const candidates = [];

  for (const childId of deceased.demographics?.childrenIds || []) {
    const child = world.entities[childId];
    if (child && child.status === 'alive') candidates.push({ entityId: child.id, reason: 'child', weight: 5 });
  }

  if (family) {
    for (const heirId of family.heirs || []) {
      const heir = world.entities[heirId];
      if (heir && heir.status === 'alive' && heir.id !== deceasedId) candidates.push({ entityId: heir.id, reason: 'family_heir', weight: 3 });
    }
    for (const elderId of family.elders || []) {
      const elder = world.entities[elderId];
      if (elder && elder.status === 'alive' && elder.id !== deceasedId) candidates.push({ entityId: elder.id, reason: 'family_elder', weight: 1 });
    }
  }

  if (deceased.demographics?.fatherId) addParentCandidate(world, candidates, deceased.demographics.fatherId);
  if (deceased.demographics?.motherId) addParentCandidate(world, candidates, deceased.demographics.motherId);

  const deduped = new Map();
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.entityId);
    if (!existing) deduped.set(candidate.entityId, candidate);
    else existing.weight += candidate.weight;
  }

  return Array.from(deduped.values())
    .sort((a, b) => b.weight - a.weight)
    .slice(0, options.maxHeirs || 5);
}

function addParentCandidate(world, candidates, parentId) {
  const parent = world.entities[parentId];
  if (parent && parent.status === 'alive') candidates.push({ entityId: parent.id, reason: 'parent', weight: 2 });
}

function snapshotEstate(entity) {
  return {
    resources: { ...(entity.resources || {}) },
    inventory: Array.isArray(entity.inventory) ? [...entity.inventory] : [],
    familyRole: entity.meta?.familyRole || null,
    factionId: entity.factionId || null,
    locationId: entity.locationId || null,
  };
}

function snapshotRelationshipLegacy(world, deceasedId, options = {}) {
  const out = [];
  const max = options.maxRelationships || 50;
  for (const [key, relation] of Object.entries(world.relationships || {})) {
    const [fromId, toId] = key.split('->');
    if (fromId !== deceasedId && toId !== deceasedId) continue;
    out.push({ fromId, toId, relation: { ...relation } });
  }
  return out.slice(0, max);
}

function snapshotGoalLegacy(entity) {
  return (entity.goals || [])
    .filter(goal => goal.status === 'active' && (goal.scope === 'dream' || goal.priority >= 70))
    .map(goal => ({ ...goal, inheritedFrom: entity.id }));
}

function snapshotReputationLegacy(world, entity) {
  const familyId = entity.familyId || entity.demographics?.familyId || null;
  const family = familyId ? getFamily(world, familyId) : null;
  return {
    personal: Number(entity.meta?.reputation || 0),
    family: family ? Number(family.reputation || 0) : 0,
    familyId,
  };
}

function inheritResources(world, record, heir, share, options = {}) {
  const rate = Number(options.resourceInheritanceRate ?? DEFAULT_LEGACY_OPTIONS.resourceInheritanceRate);
  for (const [resource, amount] of Object.entries(record.estate.resources || {})) {
    const inherited = Math.floor(Number(amount || 0) * share * rate);
    if (!inherited) continue;
    heir.resources[resource] = Number(heir.resources[resource] || 0) + inherited;
  }

  if (Array.isArray(record.estate.inventory) && record.estate.inventory.length) {
    const count = Math.floor(record.estate.inventory.length * share * rate);
    const items = record.estate.inventory.splice(0, count);
    heir.inventory = Array.isArray(heir.inventory) ? heir.inventory : [];
    heir.inventory.push(...items);
  }
}

function inheritRelationships(world, record, heir, share, options = {}) {
  const hatredRate = Number(options.hatredInheritanceRate ?? DEFAULT_LEGACY_OPTIONS.hatredInheritanceRate);
  const debtRate = Number(options.debtInheritanceRate ?? DEFAULT_LEGACY_OPTIONS.debtInheritanceRate);
  const loyaltyRate = Number(options.loyaltyInheritanceRate ?? DEFAULT_LEGACY_OPTIONS.loyaltyInheritanceRate);
  const maxMag = Number(options.maxInheritedRelationshipMagnitude ?? DEFAULT_LEGACY_OPTIONS.maxInheritedRelationshipMagnitude);

  for (const item of record.relationshipLegacy || []) {
    const otherId = item.fromId === record.deceasedId ? item.toId : item.fromId;
    if (!world.entities[otherId] || otherId === heir.id) continue;
    const relation = item.relation || {};
    const changes = {
      hatred: clampMagnitude(Number(relation.hatred || 0) * hatredRate * share, maxMag),
      debt: clampMagnitude(Number(relation.debt || 0) * debtRate * share, maxMag),
      loyalty: clampMagnitude(Number(relation.loyalty || 0) * loyaltyRate * share, maxMag),
      fear: clampMagnitude(Number(relation.fear || 0) * hatredRate * 0.5 * share, maxMag),
    };
    changeRelationship(world, heir.id, otherId, changes, { reason: 'legacy.inherited_relationship' });
  }
}

function inheritGoals(world, record, heir, share, options = {}) {
  heir.goals = Array.isArray(heir.goals) ? heir.goals : [];
  for (const goal of record.goalLegacy || []) {
    if (share < (options.minGoalShare || 0.2)) continue;
    const inherited = {
      ...goal,
      id: `goal_${world.tick}_${heir.id}_${Math.random().toString(16).slice(2)}`,
      priority: Math.max(30, Math.round(Number(goal.priority || 50) * share * 0.8)),
      progress: 0,
      createdAt: world.tick,
      updatedAt: world.tick,
      completedAt: null,
      tags: [...(goal.tags || []), 'inherited'],
      payload: { ...(goal.payload || {}), inheritedFrom: record.deceasedId, legacyId: record.id },
    };
    heir.goals.push(inherited);
  }
}

function inheritReputation(world, record, heir, share, options = {}) {
  const rate = Number(options.reputationInheritanceRate ?? DEFAULT_LEGACY_OPTIONS.reputationInheritanceRate);
  const gained = Math.round((record.reputationLegacy.personal + record.reputationLegacy.family * 0.1) * share * rate);
  heir.meta = { ...(heir.meta || {}) };
  heir.meta.reputation = Number(heir.meta.reputation || 0) + gained;
}

function markLegacyDispute(world, legacyId, challengerId, reason = 'inheritance_dispute') {
  const legacy = ensureLegacyState(world);
  const record = legacy.records[legacyId];
  if (!record) throw new Error(`Missing legacy record ${legacyId}`);
  const dispute = {
    id: `dispute_${world.tick}_${record.disputes.length + 1}`,
    legacyId,
    challengerId,
    reason,
    tick: world.tick,
    status: 'open',
  };
  record.status = LEGACY_STATUS.DISPUTED;
  record.disputes.push(dispute);
  legacy.disputes.push(dispute);
  legacy.stats.disputed += 1;
  return dispute;
}

function getLegacySummary(world, entityId) {
  const legacy = ensureLegacyState(world);
  const ids = legacy.byEntity[entityId] || [];
  return ids.map(id => legacy.records[id]).filter(Boolean);
}

function getFamilyLegacySummary(world, familyId) {
  const legacy = ensureLegacyState(world);
  const ids = legacy.byFamily[familyId] || [];
  return ids.map(id => legacy.records[id]).filter(Boolean);
}

function clampMagnitude(value, max) {
  if (value > max) return max;
  if (value < -max) return -max;
  return value;
}

function addIndex(index, key, value) {
  if (!key) return;
  if (!index[key]) index[key] = [];
  if (!index[key].includes(value)) index[key].push(value);
}

module.exports = {
  DEFAULT_LEGACY_OPTIONS,
  LEGACY_STATUS,
  ensureLegacyState,
  createLegacyRecord,
  settleLegacy,
  processPendingLegacies,
  createLegacyForRecentDeaths,
  chooseLegacyHeirs,
  snapshotEstate,
  snapshotRelationshipLegacy,
  snapshotGoalLegacy,
  snapshotReputationLegacy,
  markLegacyDispute,
  getLegacySummary,
  getFamilyLegacySummary,
};
