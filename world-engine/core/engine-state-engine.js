'use strict';

const ENGINE_STATE_VERSION = 1;

function ensureEngineState(world) {
  if (!world || typeof world !== 'object') throw new Error('ensureEngineState requires world');
  if (!world.engine || typeof world.engine !== 'object') {
    world.engine = {
      version: ENGINE_STATE_VERSION,
      createdAtTick: Number(world.tick || 0),
      ids: { total: 0, byNamespace: {} },
      random: null,
      scheduler: null,
      events: null,
      replay: null,
    };
  }

  const state = world.engine;
  state.version = Number(state.version || ENGINE_STATE_VERSION);
  if (!state.ids || typeof state.ids !== 'object') state.ids = { total: 0, byNamespace: {} };
  if (!state.ids.byNamespace || typeof state.ids.byNamespace !== 'object') state.ids.byNamespace = {};
  state.ids.total = Math.max(0, Number(state.ids.total || 0));
  if (state.createdAtTick === undefined || state.createdAtTick === null) {
    state.createdAtTick = Number(world.tick || 0);
  }
  return state;
}

function nextEngineSequence(world) {
  const state = ensureEngineState(world);
  state.ids.total = Math.max(0, Number(state.ids.total || 0)) + 1;
  return state.ids.total;
}

function nextEngineId(world, namespace = 'id', options = {}) {
  const state = ensureEngineState(world);
  const key = sanitizeNamespace(namespace);
  const current = Math.max(0, Number(state.ids.byNamespace[key] || 0));
  const next = current + 1;
  state.ids.byNamespace[key] = next;
  state.ids.total = Math.max(0, Number(state.ids.total || 0)) + 1;
  const tick = Math.max(0, Number(options.tick ?? world.tick ?? 0));
  const worldPart = options.includeWorld === false ? '' : `${sanitizeNamespace(world.id || 'world')}_`;
  return `${key}_${worldPart}${tick.toString(36)}_${next.toString(36)}`;
}

function reserveEngineIds(world, namespace, count, options = {}) {
  const total = Math.max(0, Math.floor(Number(count || 0)));
  const ids = [];
  for (let index = 0; index < total; index += 1) ids.push(nextEngineId(world, namespace, options));
  return ids;
}

function getEngineStateSummary(world) {
  const state = ensureEngineState(world);
  return {
    version: state.version,
    createdAtTick: state.createdAtTick,
    totalIds: Number(state.ids.total || 0),
    namespaces: { ...(state.ids.byNamespace || {}) },
    randomStreams: Object.keys(state.random?.streams || {}).length,
    schedulerRuns: Number(state.scheduler?.runs || 0),
    engineEvents: Number(state.events?.sequence || 0),
    replayOperations: Number(state.replay?.operationsRecorded || 0),
  };
}

function sanitizeNamespace(value) {
  const normalized = String(value || 'id')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'id';
}

module.exports = {
  ENGINE_STATE_VERSION,
  ensureEngineState,
  nextEngineSequence,
  nextEngineId,
  reserveEngineIds,
  getEngineStateSummary,
  sanitizeNamespace,
};
