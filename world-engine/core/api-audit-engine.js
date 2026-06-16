'use strict';

const DEFAULT_AUDIT_OPTIONS = {
  maxEntries: 1000,
  maxErrors: 200,
};

function ensureApiAuditState(world) {
  if (!world.apiAudit) {
    world.apiAudit = {
      log: [],
      errors: [],
      stats: {
        requests: 0,
        errors: 0,
        byMethod: {},
        byStatus: {},
        byPath: {},
      },
    };
  }
  return world.apiAudit;
}

function recordApiRequest(world, input = {}, options = {}) {
  const state = ensureApiAuditState(world);
  const entry = {
    id: input.id || `api_${world.tick}_${state.stats.requests + 1}`,
    tick: world.tick,
    at: input.at || new Date().toISOString(),
    method: input.method || 'GET',
    path: input.path || '/',
    statusCode: Number(input.statusCode || 200),
    durationMs: Number(input.durationMs || 0),
    accountId: input.accountId || null,
    playerId: input.playerId || null,
    route: input.route || null,
    error: input.error || null,
    userAgent: input.userAgent || null,
  };
  state.log.push(entry);
  state.stats.requests += 1;
  increment(state.stats.byMethod, entry.method);
  increment(state.stats.byStatus, String(entry.statusCode));
  increment(state.stats.byPath, entry.path);
  if (entry.error || entry.statusCode >= 400) {
    state.errors.push(entry);
    state.stats.errors += 1;
  }
  trimApiAudit(world, options);
  return entry;
}

function getApiAuditLog(world, options = {}) {
  const state = ensureApiAuditState(world);
  const limit = Math.max(1, Number(options.limit || 100));
  const status = options.statusCode ? String(options.statusCode) : null;
  const accountId = options.accountId || null;
  const playerId = options.playerId || null;
  return state.log
    .filter(entry => !status || String(entry.statusCode) === status)
    .filter(entry => !accountId || entry.accountId === accountId)
    .filter(entry => !playerId || entry.playerId === playerId)
    .slice(-limit)
    .reverse();
}

function getApiErrors(world, options = {}) {
  const state = ensureApiAuditState(world);
  const limit = Math.max(1, Number(options.limit || 50));
  return state.errors.slice(-limit).reverse();
}

function getApiAuditStats(world) {
  const state = ensureApiAuditState(world);
  return {
    requests: state.stats.requests,
    errors: state.stats.errors,
    logSize: state.log.length,
    errorSize: state.errors.length,
    byMethod: { ...(state.stats.byMethod || {}) },
    byStatus: { ...(state.stats.byStatus || {}) },
    byPath: { ...(state.stats.byPath || {}) },
  };
}

function trimApiAudit(world, options = {}) {
  const state = ensureApiAuditState(world);
  const maxEntries = Number(options.maxEntries || DEFAULT_AUDIT_OPTIONS.maxEntries);
  const maxErrors = Number(options.maxErrors || DEFAULT_AUDIT_OPTIONS.maxErrors);
  while (state.log.length > maxEntries) state.log.shift();
  while (state.errors.length > maxErrors) state.errors.shift();
}

function increment(target, key) {
  target[key] = Number(target[key] || 0) + 1;
}

module.exports = {
  DEFAULT_AUDIT_OPTIONS,
  ensureApiAuditState,
  recordApiRequest,
  getApiAuditLog,
  getApiErrors,
  getApiAuditStats,
  trimApiAudit,
};
