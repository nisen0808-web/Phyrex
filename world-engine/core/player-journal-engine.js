'use strict';

const { recordMemory } = require('./world-engine');
const { getPlayerView } = require('./player-engine');

const JOURNAL_TYPES = {
  SYSTEM: 'system',
  COMMAND: 'command',
  QUEST: 'quest',
  ENCOUNTER: 'encounter',
  EXPLORATION: 'exploration',
  REWARD: 'reward',
  LOCATION: 'location',
};

const DEFAULT_JOURNAL_OPTIONS = {
  maxEntriesPerPlayer: 300,
};

function ensureJournalState(world) {
  if (!world.journals) {
    world.journals = {
      byPlayer: {},
      stats: {
        entries: 0,
        pruned: 0,
      },
    };
  }
  return world.journals;
}

function recordPlayerJournal(world, playerId, input = {}, options = {}) {
  const state = ensureJournalState(world);
  if (!state.byPlayer[playerId]) state.byPlayer[playerId] = [];
  const view = getPlayerView(world, playerId);
  const active = view?.activeEntity || null;
  const entry = {
    id: input.id || `journal_${world.tick}_${playerId}_${state.byPlayer[playerId].length + 1}_${Math.random().toString(16).slice(2)}`,
    tick: input.tick ?? world.tick,
    playerId,
    entityId: input.entityId || active?.id || null,
    locationId: input.locationId || active?.locationId || null,
    type: input.type || JOURNAL_TYPES.SYSTEM,
    title: input.title || input.type || 'journal',
    summary: input.summary || input.title || input.type || 'journal entry',
    importance: Number(input.importance || 10),
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    payload: { ...(input.payload || {}) },
  };

  state.byPlayer[playerId].push(entry);
  state.stats.entries += 1;
  trimPlayerJournal(world, playerId, options.maxEntriesPerPlayer || DEFAULT_JOURNAL_OPTIONS.maxEntriesPerPlayer);
  recordMemory(world, { type: `player.journal.${entry.type}`, payload: { playerId, journalId: entry.id, title: entry.title, locationId: entry.locationId } });
  return entry;
}

function getPlayerJournal(world, playerId, filters = {}) {
  const entries = [...(ensureJournalState(world).byPlayer[playerId] || [])];
  return entries
    .filter(entry => !filters.type || entry.type === filters.type)
    .filter(entry => !filters.tag || entry.tags.includes(filters.tag))
    .filter(entry => filters.sinceTick === undefined || entry.tick >= filters.sinceTick)
    .filter(entry => filters.locationId === undefined || entry.locationId === filters.locationId)
    .sort((a, b) => Number(b.tick || 0) - Number(a.tick || 0))
    .slice(0, filters.limit || entries.length);
}

function getJournalStats(world) {
  const state = ensureJournalState(world);
  const entries = Object.values(state.byPlayer).flat();
  return {
    players: Object.keys(state.byPlayer).length,
    total: entries.length,
    byType: countBy(entries.map(entry => entry.type)),
    stats: { ...state.stats },
  };
}

function trimPlayerJournal(world, playerId, limit = DEFAULT_JOURNAL_OPTIONS.maxEntriesPerPlayer) {
  const state = ensureJournalState(world);
  const entries = state.byPlayer[playerId] || [];
  if (entries.length <= limit) return [];
  const removeCount = entries.length - limit;
  const removed = entries.splice(0, removeCount);
  state.stats.pruned += removed.length;
  return removed;
}

function formatJournalEntries(entries = []) {
  if (!entries.length) return 'No journal entries.';
  return entries
    .slice()
    .reverse()
    .map(entry => `[${entry.tick}] ${entry.title} (${entry.type})\n${entry.summary}`)
    .join('\n\n');
}

function summarizePlayerJournal(world, playerId, limit = 10) {
  return {
    playerId,
    entries: getPlayerJournal(world, playerId, { limit }).map(entry => ({
      id: entry.id,
      tick: entry.tick,
      type: entry.type,
      title: entry.title,
      summary: entry.summary,
      locationId: entry.locationId,
      importance: entry.importance,
      tags: [...(entry.tags || [])],
    })),
  };
}

function countBy(values) {
  const out = {};
  for (const value of values || []) {
    const key = value === undefined || value === null ? 'unknown' : String(value);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

module.exports = {
  JOURNAL_TYPES,
  DEFAULT_JOURNAL_OPTIONS,
  ensureJournalState,
  recordPlayerJournal,
  getPlayerJournal,
  getJournalStats,
  trimPlayerJournal,
  formatJournalEntries,
  summarizePlayerJournal,
};
