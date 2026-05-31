'use strict';

const LIFE_EVENT_TYPES = {
  BIRTH: 'birth',
  GOAL_ASSIGNED: 'goal_assigned',
  GOAL_COMPLETED: 'goal_completed',
  MOVED: 'moved',
  WORKED: 'worked',
  GATHERED: 'gathered',
  RESTED: 'rested',
  RELATIONSHIP_CHANGED: 'relationship_changed',
  RESOURCE_TRANSFERRED: 'resource_transferred',
  DAMAGED: 'damaged',
  DEATH: 'death',
  WORLD_EVENT: 'world_event',
};

const LIFE_STAGES = [
  { id: 'origin', minAge: 0, maxAge: 12 },
  { id: 'youth', minAge: 13, maxAge: 25 },
  { id: 'growth', minAge: 26, maxAge: 60 },
  { id: 'peak', minAge: 61, maxAge: 140 },
  { id: 'decline', minAge: 141, maxAge: Infinity },
];

const EVENT_IMPORTANCE = {
  birth: 100,
  goal_assigned: 12,
  goal_completed: 80,
  moved: 8,
  worked: 5,
  gathered: 6,
  rested: 3,
  relationship_changed: 24,
  resource_transferred: 20,
  damaged: 65,
  death: 200,
  world_event: 35,
};

function ensureHistoryState(world) {
  if (!world.history) {
    world.history = {
      lifeEventsByEntity: {},
      arcsByEntity: {},
      globalTimeline: [],
      indexes: {
        byType: {},
        byLocation: {},
        byTick: {},
      },
    };
  }
  return world.history;
}

function ensureEntityHistory(world, entityId) {
  const history = ensureHistoryState(world);
  if (!history.lifeEventsByEntity[entityId]) history.lifeEventsByEntity[entityId] = [];
  if (!history.arcsByEntity[entityId]) history.arcsByEntity[entityId] = [];
  return history.lifeEventsByEntity[entityId];
}

function createLifeEvent(world, input = {}) {
  if (!input.entityId) throw new Error('Life event requires entityId');
  if (!input.type) throw new Error('Life event requires type');

  const entity = world.entities[input.entityId];
  const age = input.age ?? entity?.meta?.age ?? entity?.age ?? null;
  const stage = input.stage || inferLifeStage(age);
  const importance = clampImportance(input.importance ?? EVENT_IMPORTANCE[input.type] ?? 10);

  return {
    id: input.id || `life_${world.tick}_${input.entityId}_${Math.random().toString(16).slice(2)}`,
    entityId: input.entityId,
    type: input.type,
    tick: input.tick ?? world.tick,
    calendar: input.calendar ? { ...input.calendar } : { ...(world.calendar || {}) },
    age,
    stage,
    title: input.title || input.type,
    summary: input.summary || '',
    importance,
    participants: Array.isArray(input.participants) ? [...input.participants] : [input.entityId],
    locationId: input.locationId || entity?.locationId || null,
    causeIds: Array.isArray(input.causeIds) ? [...input.causeIds] : [],
    eventId: input.eventId || null,
    actionId: input.actionId || null,
    goalId: input.goalId || null,
    effects: Array.isArray(input.effects) ? [...input.effects] : [],
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    payload: { ...(input.payload || {}) },
  };
}

function recordLifeEvent(world, input = {}) {
  const event = createLifeEvent(world, input);
  const history = ensureHistoryState(world);
  const entityEvents = ensureEntityHistory(world, event.entityId);

  entityEvents.push(event);
  history.globalTimeline.push({
    id: event.id,
    entityId: event.entityId,
    type: event.type,
    tick: event.tick,
    importance: event.importance,
  });

  addIndex(history.indexes.byType, event.type, event.id);
  if (event.locationId) addIndex(history.indexes.byLocation, event.locationId, event.id);
  addIndex(history.indexes.byTick, String(event.tick), event.id);

  updateLifeArcs(world, event.entityId);
  return event;
}

function ingestWorldMemory(world, options = {}) {
  ensureHistoryState(world);
  const minImportance = Number(options.minImportance || 0);
  const consumed = new Set(world.history.consumedMemoryIds || []);
  const created = [];

  for (const memory of world.memory || []) {
    if (consumed.has(memory.id)) continue;
    const events = memoryToLifeEvents(world, memory).filter(item => item.importance >= minImportance);
    for (const eventInput of events) created.push(recordLifeEvent(world, eventInput));
    consumed.add(memory.id);
  }

  world.history.consumedMemoryIds = Array.from(consumed);
  return created;
}

function memoryToLifeEvents(world, memory) {
  const payload = memory.payload || {};
  const type = memory.type || '';
  const out = [];

  if (type === 'entity.registered') {
    out.push({
      entityId: payload.entityId || memory.entityId,
      type: LIFE_EVENT_TYPES.BIRTH,
      tick: memory.tick,
      title: 'entity entered the world',
      summary: 'A new entity began its life in the world simulation.',
      importance: EVENT_IMPORTANCE.birth,
      tags: ['origin'],
    });
  }

  if (type === 'goal.assigned') {
    out.push({
      entityId: payload.entityId,
      type: LIFE_EVENT_TYPES.GOAL_ASSIGNED,
      tick: memory.tick,
      title: `new goal: ${payload.goalType}`,
      summary: `The entity formed a new ${payload.scope || 'goal'}: ${payload.goalType}.`,
      importance: payload.scope === 'dream' ? 45 : EVENT_IMPORTANCE.goal_assigned,
      goalId: payload.goalId,
      payload,
      tags: ['goal'],
    });
  }

  if (type === 'goal.completed') {
    out.push({
      entityId: payload.entityId,
      type: LIFE_EVENT_TYPES.GOAL_COMPLETED,
      tick: memory.tick,
      title: `completed goal: ${payload.goalType}`,
      summary: `The entity completed a meaningful goal: ${payload.goalType}.`,
      importance: payload.scope === 'dream' ? 150 : EVENT_IMPORTANCE.goal_completed,
      goalId: payload.goalId,
      payload,
      tags: ['goal', 'achievement'],
    });
  }

  if (type.startsWith('event.')) {
    const actorIds = payload.actorIds || [];
    for (const entityId of actorIds) {
      const mapped = eventMemoryTypeToLifeType(type);
      out.push({
        entityId,
        type: mapped.type,
        tick: memory.tick,
        title: mapped.title,
        summary: summarizeEventMemory(type, payload, entityId),
        importance: mapped.importance,
        participants: actorIds,
        locationId: payload.locationId,
        eventId: payload.eventId,
        payload,
        tags: mapped.tags,
      });
    }
  }

  return out.filter(item => item.entityId);
}

function eventMemoryTypeToLifeType(memoryType) {
  const map = {
    'event.entity.moved': { type: LIFE_EVENT_TYPES.MOVED, title: 'changed location', importance: EVENT_IMPORTANCE.moved, tags: ['movement'] },
    'event.entity.rested': { type: LIFE_EVENT_TYPES.RESTED, title: 'rested and recovered', importance: EVENT_IMPORTANCE.rested, tags: ['recovery'] },
    'event.entity.worked': { type: LIFE_EVENT_TYPES.WORKED, title: 'worked for resources', importance: EVENT_IMPORTANCE.worked, tags: ['labor'] },
    'event.resource.gathered': { type: LIFE_EVENT_TYPES.GATHERED, title: 'gathered resources', importance: EVENT_IMPORTANCE.gathered, tags: ['resource'] },
    'event.resource.transferred': { type: LIFE_EVENT_TYPES.RESOURCE_TRANSFERRED, title: 'transferred resources', importance: EVENT_IMPORTANCE.resource_transferred, tags: ['resource', 'relationship'] },
    'event.entity.interacted': { type: LIFE_EVENT_TYPES.RELATIONSHIP_CHANGED, title: 'formed a social interaction', importance: EVENT_IMPORTANCE.relationship_changed, tags: ['relationship'] },
    'event.entity.damaged': { type: LIFE_EVENT_TYPES.DAMAGED, title: 'suffered conflict', importance: EVENT_IMPORTANCE.damaged, tags: ['conflict'] },
    'event.entity.dead': { type: LIFE_EVENT_TYPES.DEATH, title: 'life ended', importance: EVENT_IMPORTANCE.death, tags: ['death'] },
  };
  return map[memoryType] || { type: LIFE_EVENT_TYPES.WORLD_EVENT, title: memoryType.replace('event.', ''), importance: EVENT_IMPORTANCE.world_event, tags: ['world'] };
}

function summarizeEventMemory(type, payload, entityId) {
  if (type === 'event.entity.moved') return `Entity ${entityId} moved from ${payload.from || 'unknown'} to ${payload.to || payload.locationId || 'unknown'}.`;
  if (type === 'event.entity.worked') return `Entity ${entityId} worked and gained ${payload.resource || 'resource'}.`;
  if (type === 'event.resource.transferred') return `Entity ${entityId} participated in a resource transfer.`;
  if (type === 'event.entity.interacted') return `Entity ${entityId} participated in a social interaction.`;
  if (type === 'event.entity.damaged') return `Entity ${entityId} was involved in a harmful conflict.`;
  if (type === 'event.entity.dead') return `Entity ${entityId}'s life ended.`;
  return `Entity ${entityId} participated in ${type}.`;
}

function updateLifeArcs(world, entityId) {
  const history = ensureHistoryState(world);
  const events = history.lifeEventsByEntity[entityId] || [];
  const arcs = [];
  let current = null;

  for (const event of events) {
    const arcKey = inferArcKey(event);
    if (!current || current.key !== arcKey) {
      current = {
        id: `arc_${entityId}_${arcs.length + 1}`,
        entityId,
        key: arcKey,
        title: arcTitle(arcKey),
        startTick: event.tick,
        endTick: event.tick,
        eventIds: [],
        importance: 0,
        tags: [],
      };
      arcs.push(current);
    }
    current.endTick = event.tick;
    current.eventIds.push(event.id);
    current.importance += event.importance;
    for (const tag of event.tags || []) if (!current.tags.includes(tag)) current.tags.push(tag);
  }

  history.arcsByEntity[entityId] = arcs;
  return arcs;
}

function inferArcKey(event) {
  if (event.tags.includes('origin')) return 'origin';
  if (event.tags.includes('goal') && event.importance >= 100) return 'great_ambition';
  if (event.tags.includes('achievement')) return 'achievement';
  if (event.tags.includes('conflict')) return 'conflict';
  if (event.tags.includes('relationship')) return 'relationship';
  if (event.tags.includes('death')) return 'ending';
  return event.stage || 'ordinary_life';
}

function arcTitle(key) {
  const titles = {
    origin: 'Origin',
    great_ambition: 'Great Ambition',
    achievement: 'Achievement',
    conflict: 'Conflict',
    relationship: 'Relationship',
    ending: 'Ending',
    ordinary_life: 'Ordinary Life',
    youth: 'Youth',
    growth: 'Growth',
    peak: 'Peak',
    decline: 'Decline',
  };
  return titles[key] || key;
}

function getEntityChronicle(world, entityId, options = {}) {
  const history = ensureHistoryState(world);
  const events = [...(history.lifeEventsByEntity[entityId] || [])];
  const arcs = [...(history.arcsByEntity[entityId] || [])];
  const minImportance = Number(options.minImportance || 0);
  return {
    entityId,
    events: events.filter(event => event.importance >= minImportance),
    arcs,
    summary: summarizeChronicle(events, arcs),
  };
}

function summarizeChronicle(events, arcs) {
  const totalImportance = events.reduce((sum, item) => sum + item.importance, 0);
  const majorEvents = events.filter(item => item.importance >= 80).length;
  return {
    eventCount: events.length,
    arcCount: arcs.length,
    majorEvents,
    totalImportance,
    firstTick: events[0]?.tick ?? null,
    lastTick: events[events.length - 1]?.tick ?? null,
  };
}

function inferLifeStage(age) {
  if (age === null || age === undefined) return 'unknown';
  const found = LIFE_STAGES.find(stage => age >= stage.minAge && age <= stage.maxAge);
  return found ? found.id : 'unknown';
}

function addIndex(index, key, value) {
  if (!index[key]) index[key] = [];
  index[key].push(value);
}

function clampImportance(value) {
  return Math.max(0, Math.min(1000, Number(value || 0)));
}

module.exports = {
  LIFE_EVENT_TYPES,
  LIFE_STAGES,
  EVENT_IMPORTANCE,
  ensureHistoryState,
  ensureEntityHistory,
  createLifeEvent,
  recordLifeEvent,
  ingestWorldMemory,
  memoryToLifeEvents,
  updateLifeArcs,
  getEntityChronicle,
  summarizeChronicle,
  inferLifeStage,
};
