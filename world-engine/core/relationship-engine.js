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
    world.memory.push({
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

  if (event.type === 'resource.transferred') {
    return {
      affection: changes.affection * 0.8,
      trust: changes.trust,
      debt: -changes.debt,
    };
  }

  return { ...changes };
}

function decayRelationships(world, options = {}) {
  const decay = Number(options.decay || 0.02);
  const deadZone = Number(options.deadZone || 0.5);

  for (const relation of Object.values(world.relationships)) {
    for (const key of RELATION_KEYS) {
      const value = Number(relation[key] || 0);
      if (Math.abs(value) <= deadZone) {
        relation[key] = 0;
      } else if (value > 0) {
        relation[key] = clamp(value - decay, -100, 100);
      } else {
        relation[key] = clamp(value + decay, -100, 100);
      }
    }
  }
}

function propagateRelationship(world, fromId, toId, options = {}) {
  const relation = getRelationship(world, fromId, toId);
  const strength = Number(options.strength || 0.1);
  const fromEntity = world.entities[fromId];
  const toEntity = world.entities[toId];

  if (!fromEntity || !toEntity) return [];

  const affected = [];
  const factionId = fromEntity.factionId;
  if (!factionId) return affected;

  for (const entity of Object.values(world.entities)) {
    if (entity.id === fromId || entity.id === toId) continue;
    if (entity.factionId !== factionId) continue;

    const propagated = {};
    for (const key of ['trust', 'fear', 'hatred', 'loyalty']) {
      propagated[key] = Number(relation[key] || 0) * strength;
    }

    changeRelationship(world, entity.id, toId, propagated, { reason: 'relationship.propagated' });
    affected.push(entity.id);
  }

  return affected;
}

function scoreRelationship(world, fromId, toId) {
  const r = getRelationship(world, fromId, toId);
  return {
    cooperation: clamp((r.affection * 0.35) + (r.trust * 0.45) + (r.loyalty * 0.25) - (r.fear * 0.15) - (r.hatred * 0.6), -100, 100),
    hostility: clamp((r.hatred * 0.55) + (r.fear * 0.2) - (r.affection * 0.2) - (r.trust * 0.25), -100, 100),
    vulnerability: clamp((r.trust * 0.5) + (r.affection * 0.25) - (r.hatred * 0.4) - (r.fear * 0.2), -100, 100),
    obligation: clamp((r.debt * 0.65) + (r.loyalty * 0.35), -100, 100),
  };
}

function rebuildRelationshipIndexes(world) {
  if (!world.indexes.relationshipsByEntity) world.indexes.relationshipsByEntity = {};
  world.indexes.relationshipsByEntity = {};

  for (const key of Object.keys(world.relationships)) {
    const [fromId, toId] = key.split('->');
    if (!world.indexes.relationshipsByEntity[fromId]) world.indexes.relationshipsByEntity[fromId] = [];
    world.indexes.relationshipsByEntity[fromId].push({ toId, key });
  }
}

module.exports = {
  EVENT_RELATION_EFFECTS,
  getRelationship,
  setRelationshipValue,
  changeRelationship,
  applyEventRelationshipEffects,
  decayRelationships,
  propagateRelationship,
  scoreRelationship,
  rebuildRelationshipIndexes,
};
