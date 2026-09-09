'use strict';

const { wallClockIso } = require('../platform/runtime-clock');

const {
  getDatabaseStatus,
  listDatabaseWorlds,
  listDatabaseEvents,
} = require('./database-engine');

const DATABASE_VIEWER_SUMMARY_VERSION = 1;

function buildDatabaseViewerSummary(options = {}) {
  const database = options.database || options;
  const status = getDatabaseStatus(database);
  const worlds = listDatabaseWorlds({ database }).slice(0, Number(options.worldLimit || 20));
  const events = listDatabaseEvents({
    database,
    limit: Number(options.eventLimit || 20),
    order: options.eventOrder || 'desc',
    worldId: options.worldId,
    type: options.type,
  });
  return {
    version: DATABASE_VIEWER_SUMMARY_VERSION,
    generatedAt: wallClockIso(),
    status,
    totals: {
      worlds: worlds.length,
      records: Number(status.records || 0),
      events: Number(status.events || 0),
    },
    latestWorld: worlds[0] || null,
    worlds,
    events,
    health: summarizeDatabaseHealth(status, worlds, events),
  };
}

function summarizeDatabaseHealth(status = {}, worlds = [], events = []) {
  const ready = Boolean(status.ready);
  const supported = Boolean(status.supported);
  const hasRecords = Number(status.records || 0) > 0;
  const hasEvents = Number(status.events || 0) > 0;
  const warnings = [];
  if (!ready) warnings.push('database_not_ready');
  if (!supported) warnings.push('database_provider_not_supported');
  if (ready && !hasRecords) warnings.push('no_world_records');
  return {
    ok: ready && supported,
    ready,
    supported,
    hasRecords,
    hasEvents,
    latestTick: worlds[0]?.tick ?? null,
    latestWorldId: worlds[0]?.worldId || null,
    recentEventTypes: summarizeRecentEventTypes(events),
    warnings,
  };
}

function summarizeRecentEventTypes(events = []) {
  const counts = new Map();
  for (const event of events) {
    const type = event.type || 'event';
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type));
}

module.exports = {
  DATABASE_VIEWER_SUMMARY_VERSION,
  buildDatabaseViewerSummary,
  summarizeDatabaseHealth,
  summarizeRecentEventTypes,
};
