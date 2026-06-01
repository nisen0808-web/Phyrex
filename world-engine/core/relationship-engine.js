'use strict';

const { RELATION_KEYS, createRelationship, relationKey, clamp } = require('./schema');

const EVENT_RELATION_EFFECTS = {
  'entity.interacted': event => {
    const effect = event.payload.effect || 'social';
    const amount = Number(event.payload.amount || 1);
    if (effect === 'hostile') return { affection: -amount, trust: -amount, fear: amount, hatred: amount };
    if (effect === 'help') return { affection: amount, trust: amount, debt: amount };
    if (effect === 'trade') return { trust: amount * 0.5, debt: -amount * 0.25 };
    return { affection: amount, trust: amount * 0.5 };
  },
  'resource.transferred': event => {
    const amount = Number(event.payload.amount || 0);
    return { affection: Math.min(10, amount * 0.1), trust: Math.min(8, amount * 0.08), debt: Math.min(20, amount * 0.15) };
  },
  'entity.damaged': event => {
    const amount = Number(event.payload.amount || 0);
    return { affection: -Math.min(30, amount * 0.5), trust: -Math.min(20, amount * 0.35), fear: Math.min(40, amount * 0.45), hatred: Math.min(45, amount * 0.55) };
  },
};

function getRelationship(world, fromId, toId) {
  const key = relationKey(fromId, toId);
  if (!world.relationships[key]) world.relationships[key] = createRelationship();
  return world.relationships[key];
}

function setRelationshipValue(world, fromId, toId, key, value) {
  if (!RELATION_KEYS.includes(key)) throw new Error(`Unknown relationship key ${key}`);
  const relation = getRelationship(world, fromId, toId);
  relation[key] = clamp(value, -100, 100);
  return relation[key];
}

function changeRelationship(world, fromId, toId, changes = {}, options = {}) {
  const relation = getRelationship(world, fromId, toId);
  const applied = {};

  for (const [key, delta] of Object.entries(changes)) {
    if (!RELATION_KEYS.includes(key)) continue;
    const next = clamp(Number(relation[key] || 0) + Number(delta || 0), -100, 100);
    relation[key] = next;
    applied[key] = next;
  }

  if (options.record !== false) {
    pushWorldMemory(world, {
      id: `memory_${world.tick}_${world.memory.length + 1}`,
      tick: world.tick,
      type: 'relationship.changed',
      payload: { fromId, toId, changes, applied, reason: options.reason || null },
    });
  }

  return relation;
}

function applyEventRelationshipEffects(world, event) {
  const actorIds = event.actorIds || [];
  if (actorIds.length < 2) return [];

  const [sourceId, targetId] = actorIds;
  if (!sourceId || !targetId || sourceId === targetId) return [];

  const resolver = EVENT_RELATION_EFFECTS[event.type];
  if (!resolver) return [];

  const changes = resolver(event);
  const targetPerspective = invertRelationshipChanges(changes, event);

  const a = changeRelationship(world, sourceId, targetId, changes, { reason: event.type });
  const b = changeRelationship(world, targetId, sourceId, targetPerspective, { reason: event.type });

  return [
    { fromId: sourceId, toId: targetId, relationship: a },
    { fromId: targetId, toId: sourceId, relationship: b },
  ];
}

function invertRelationshipChanges(changes, event) {
  if (event.type === 'entity.damaged') {
    return {
      affection: changes.affection,
      trust: changes.trust,
      fear: changes.fear * 0.7,
      hatred: changes.hatred,
    };
  }
  return changes;
}

function scoreRelationship(world, fromId, toId) {
  const relation = getRelationship(world, fromId, toId);
  return {
    cooperation: relation.affection + relation.trust + relation.loyalty + relation.debt * 0.5 - relation.fear * 0.3 - relation.hatred,
    hostility: relation.hatred + relation.fear * 0.5 - relation.trust * 0.4,
    vulnerability: relation.trust + relation.affection + relation.loyalty - relation.fear,
    obligation: relation.debt + relation.loyalty + relation.affection * 0.3,
  };
}

function decayRelationships(world, rate = 0.01) {
  for (const relation of Object.values(world.relationships)) {
    for (const key of RELATION_KEYS) {
      relation[key] = relation[key] > 0
        ? Math.max(0, relation[key] - rate)
        : Math.min(0, relation[key] + rate);
    }
  }
}

function propagateRelationship(world, sourceId, targetId, amount = 1) {
  for (const entity of Object.values(world.entities || {})) {
    if (entity.id === sourceId || entity.id === targetId) continue;
    const towardSource = getRelationship(world, entity.id, sourceId);
    if (towardSource.trust + towardSource.affection < 20) continue;
    changeRelationship(world, entity.id, targetId, { trust: amount * 0.2, affection: amount * 0.2 }, { reason: 'relationship.propagated' });
  }
}

function rebuildRelationshipIndexes(world) {
  if (!world.relationshipIndexes) world.relationshipIndexes = { byEntity: {} };
  world.relationshipIndexes.byEntity = {};
  for (const key of Object.keys(world.relationships || {})) {
    const [fromId, toId] = key.split('->');
    if (!world.relationshipIndexes.byEntity[fromId]) world.relationshipIndexes.byEntity[fromId] = [];
    if (!world.relationshipIndexes.byEntity[toId]) world.relationshipIndexes.byEntity[toId] = [];
    world.relationshipIndexes.byEntity[fromId].push(key);
    world.relationshipIndexes.byEntity[toId].push(key);
  }
}

function pushWorldMemory(world, memory) {
  world.memory.push(memory);
  if (world.memory.length > 1000) world.memory.shift();
  return memory;
}

module.exports = {
  EVENT_RELATION_EFFECTS,
  getRelationship,
  setRelationshipValue,
  changeRelationship,
  applyEventRelationshipEffects,
  invertRelationshipChanges,
  scoreRelationship,
  decayRelationships,
  propagateRelationship,
  rebuildRelationshipIndexes,
};
