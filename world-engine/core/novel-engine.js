'use strict';

const { getEntityChronicle } = require('./history-engine');
const { calculateEntityNarrativeScore, getNovelTier } = require('./narrative-score-engine');

const NOVEL_STATUS = {
  SERIALIZING: 'serializing',
  COMPLETED: 'completed',
  PAUSED: 'paused',
  NOT_STARTED: 'not_started',
};

const DEFAULT_CHAPTER_WORDS = 3200;
const DEFAULT_VOLUME_WORDS = 180000;

function ensureNovelState(world) {
  if (!world.novels) {
    world.novels = {
      byEntity: {},
      library: [],
      lastUpdatedTick: null,
    };
  }
  return world.novels;
}

function createOrUpdateNovelBlueprint(world, entityId, options = {}) {
  const entity = world.entities[entityId];
  if (!entity) throw new Error(`Missing entity ${entityId}`);

  const novels = ensureNovelState(world);
  const chronicle = getEntityChronicle(world, entityId);
  const narrative = options.narrativeScore || calculateEntityNarrativeScore(world, entityId);
  const tier = getNovelTier(narrative.score);

  const existing = novels.byEntity[entityId] || null;
  const status = entity.status === 'dead' ? NOVEL_STATUS.COMPLETED : tier.id === 'none' ? NOVEL_STATUS.NOT_STARTED : NOVEL_STATUS.SERIALIZING;
  const title = existing?.title || generateWorkingTitle(entity, chronicle, narrative);
  const targetWords = options.targetWords || tier.targetWords || 0;
  const currentWords = estimateCurrentWords(chronicle, narrative, targetWords, status);

  const blueprint = {
    id: existing?.id || `novel_${entityId}`,
    entityId,
    title,
    status,
    tier: tier.id,
    tierLabel: tier.label,
    targetWords,
    currentWords,
    estimatedChapters: targetWords ? Math.ceil(targetWords / DEFAULT_CHAPTER_WORDS) : 0,
    updatedAt: world.tick,
    protagonist: {
      id: entity.id,
      name: entity.name || entity.id,
      status: entity.status,
      factionId: entity.factionId || null,
    },
    premise: buildPremise(entity, chronicle, narrative),
    themes: inferThemes(chronicle, narrative),
    volumes: buildVolumes(world, entityId, chronicle, narrative, targetWords),
    supportingCharacters: findSupportingCharacters(world, entityId, chronicle),
    majorConflicts: findMajorConflicts(chronicle),
    source: {
      eventCount: chronicle.summary.eventCount,
      arcCount: chronicle.summary.arcCount,
      majorEvents: chronicle.summary.majorEvents,
      narrativeScore: narrative.score,
    },
  };

  novels.byEntity[entityId] = blueprint;
  upsertLibraryEntry(world, blueprint);
  novels.lastUpdatedTick = world.tick;
  return blueprint;
}

function updateNovelBlueprints(world, options = {}) {
  const novels = ensureNovelState(world);
  const minTier = options.minTier || 'biography';
  const created = [];

  for (const entityId of Object.keys(world.entities)) {
    const score = calculateEntityNarrativeScore(world, entityId);
    const tier = getNovelTier(score.score);
    if (!isTierAtLeast(tier.id, minTier)) continue;
    created.push(createOrUpdateNovelBlueprint(world, entityId, { narrativeScore: score }));
  }

  novels.library.sort((a, b) => b.narrativeScore - a.narrativeScore);
  novels.library.forEach((entry, index) => { entry.rank = index + 1; });
  return created;
}

function generateWorkingTitle(entity, chronicle, narrative) {
  const name = entity.name || entity.id;
  const themes = inferThemes(chronicle, narrative);
  const lead = themes[0] || 'life';
  const titleMap = {
    origin: `${name}: Origin Chronicle`,
    ambition: `${name}: Road of Ambition`,
    achievement: `${name}: The Long Ascent`,
    conflict: `${name}: Years of Conflict`,
    relationship: `${name}: Bonds and Debts`,
    ending: `${name}: Final Chronicle`,
    legend: `${name}: World Legend`,
  };
  return titleMap[lead] || `${name}: A Life in the World`;
}

function buildPremise(entity, chronicle, narrative) {
  const majorEvents = chronicle.events.filter(event => event.importance >= 80).length;
  const status = entity.status === 'dead' ? 'completed life' : 'ongoing life';
  return {
    logline: `${entity.name || entity.id} has an ${status} shaped by ${majorEvents} major life events and a narrative score of ${narrative.score}.`,
    centralQuestion: inferCentralQuestion(chronicle, narrative),
    promise: inferReaderPromise(chronicle, narrative),
  };
}

function inferCentralQuestion(chronicle, narrative) {
  const themes = inferThemes(chronicle, narrative);
  if (themes.includes('ambition')) return 'Can ambition reshape a life before the world reshapes it first?';
  if (themes.includes('conflict')) return 'Can a person survive the consequences of conflict and still remain themselves?';
  if (themes.includes('relationship')) return 'How much can bonds, debts, and loyalty change a life?';
  if (themes.includes('ending')) return 'What remains after a life becomes history?';
  return 'How does an ordinary life become worthy of memory?';
}

function inferReaderPromise(chronicle, narrative) {
  if (narrative.tier === 'world_legend') return 'A world-level epic built from real simulated history.';
  if (narrative.tier === 'epic') return 'A long-form epic following ambition, conflict, and consequence.';
  if (narrative.tier === 'long_novel') return 'A traditional long novel shaped by growth, setbacks, and major turning points.';
  if (narrative.tier === 'short_novel') return 'A focused character novel built around the strongest arcs.';
  return 'A concise biography of a life that mattered.';
}

function inferThemes(chronicle, narrative) {
  const themes = new Set();
  for (const arc of chronicle.arcs || []) {
    if (arc.key === 'origin') themes.add('origin');
    if (arc.key === 'great_ambition') themes.add('ambition');
    if (arc.key === 'achievement') themes.add('achievement');
    if (arc.key === 'conflict') themes.add('conflict');
    if (arc.key === 'relationship') themes.add('relationship');
    if (arc.key === 'ending') themes.add('ending');
  }
  if (narrative.score >= 6000) themes.add('legend');
  if (!themes.size) themes.add('ordinary_life');
  return Array.from(themes);
}

function buildVolumes(world, entityId, chronicle, narrative, targetWords) {
  const arcs = chronicle.arcs || [];
  if (!arcs.length) return [];

  const totalImportance = Math.max(1, arcs.reduce((sum, arc) => sum + arc.importance, 0));
  return arcs.map((arc, index) => {
    const wordBudget = targetWords ? Math.max(DEFAULT_CHAPTER_WORDS, Math.round(targetWords * (arc.importance / totalImportance))) : 0;
    const chapterCount = wordBudget ? Math.max(1, Math.ceil(wordBudget / DEFAULT_CHAPTER_WORDS)) : 0;
    return {
      id: `volume_${entityId}_${index + 1}`,
      index: index + 1,
      title: arc.title,
      arcKey: arc.key,
      startTick: arc.startTick,
      endTick: arc.endTick,
      sourceEventIds: [...arc.eventIds],
      importance: arc.importance,
      wordBudget,
      chapterCount,
      chapters: buildChapterBlueprints(entityId, arc, chapterCount, wordBudget),
      tags: [...(arc.tags || [])],
    };
  });
}

function buildChapterBlueprints(entityId, arc, chapterCount, wordBudget) {
  const chapters = [];
  if (!chapterCount) return chapters;
  const words = Math.max(1000, Math.round(wordBudget / chapterCount));
  for (let i = 0; i < chapterCount; i += 1) {
    chapters.push({
      id: `chapter_${entityId}_${arc.key}_${i + 1}`,
      index: i + 1,
      title: `${arc.title} ${i + 1}`,
      sourceEventIds: pickSourceEventsForChapter(arc.eventIds, i, chapterCount),
      targetWords: words,
      status: 'planned',
      summary: '',
    });
  }
  return chapters;
}

function pickSourceEventsForChapter(eventIds, chapterIndex, chapterCount) {
  if (!eventIds || !eventIds.length) return [];
  const size = Math.max(1, Math.ceil(eventIds.length / chapterCount));
  const start = chapterIndex * size;
  return eventIds.slice(start, start + size);
}

function findSupportingCharacters(world, entityId, chronicle) {
  const counts = new Map();
  for (const event of chronicle.events || []) {
    for (const participant of event.participants || []) {
      if (!participant || participant === entityId) continue;
      counts.set(participant, (counts.get(participant) || 0) + Math.max(1, Math.round(event.importance / 20)));
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([id, weight]) => ({ id, name: world.entities[id]?.name || id, weight }));
}

function findMajorConflicts(chronicle) {
  return (chronicle.events || [])
    .filter(event => event.tags?.includes('conflict') || event.type === 'damaged')
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 20)
    .map(event => ({
      eventId: event.id,
      tick: event.tick,
      title: event.title,
      importance: event.importance,
      participants: event.participants || [],
    }));
}

function estimateCurrentWords(chronicle, narrative, targetWords, status) {
  if (!targetWords) return 0;
  if (status === NOVEL_STATUS.COMPLETED) return targetWords;
  const progress = Math.min(1, Math.max(0.03, chronicle.summary.totalImportance / Math.max(1, narrative.score + 1000)));
  return Math.round(targetWords * progress);
}

function upsertLibraryEntry(world, blueprint) {
  const novels = ensureNovelState(world);
  const entry = {
    id: blueprint.id,
    entityId: blueprint.entityId,
    title: blueprint.title,
    tier: blueprint.tier,
    status: blueprint.status,
    narrativeScore: blueprint.source.narrativeScore,
    currentWords: blueprint.currentWords,
    targetWords: blueprint.targetWords,
    updatedAt: blueprint.updatedAt,
  };
  const index = novels.library.findIndex(item => item.id === entry.id);
  if (index >= 0) novels.library[index] = { ...novels.library[index], ...entry };
  else novels.library.push(entry);
}

function isTierAtLeast(tierId, minTierId) {
  const tiers = ['none', 'biography', 'short_novel', 'long_novel', 'epic', 'world_legend'];
  return tiers.indexOf(tierId) >= tiers.indexOf(minTierId);
}

function getNovelBlueprint(world, entityId) {
  return ensureNovelState(world).byEntity[entityId] || null;
}

function getLibraryEntries(world, options = {}) {
  const novels = ensureNovelState(world);
  const minTier = options.minTier || 'biography';
  return novels.library
    .filter(entry => isTierAtLeast(entry.tier, minTier))
    .sort((a, b) => b.narrativeScore - a.narrativeScore)
    .slice(0, options.limit || 100);
}

module.exports = {
  NOVEL_STATUS,
  DEFAULT_CHAPTER_WORDS,
  DEFAULT_VOLUME_WORDS,
  ensureNovelState,
  createOrUpdateNovelBlueprint,
  updateNovelBlueprints,
  generateWorkingTitle,
  buildPremise,
  inferThemes,
  buildVolumes,
  getNovelBlueprint,
  getLibraryEntries,
};
