'use strict';

const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');
const { createPostgresDatabaseStore } = require('../storage/postgres/store');
const { createPostgresCommandApiAuditStore } = require('../storage/postgres/command-api-audit-store');
const { playerStateView, worldSummaryView } = require('./durable-state-view-engine');
const { validateSession } = require('./account-session-engine');
const { canAccessPlayer, isPrivileged, requirePermission, requireSession } = require('./api-permission-engine');
const { createFixedWindowRateLimiter } = require('./request-rate-limit-engine');
const { createConsoleAssets, serveConsoleAsset } = require('../service/console-assets');
const { serviceStatusView } = require('../service/operational-status');

const DEFAULT_DURABLE_COMMAND_API_OPTIONS = Object.freeze({
  maxBodyBytes: 64 * 1024,
  authorizationAttempts: 3,
  sourceRateLimit: 240,
  accountSubmitRateLimit: 60,
  accountReadRateLimit: 240,
  rateLimitWindowMs: 60 * 1000,
  maxTrackedSources: 5000,
  maxTrackedAccounts: 10000,
});

function apiError(statusCode, code, details = {}) {
  const error = new Error(code);
  error.statusCode = statusCode;
  error.apiCode = code;
  if (details.retryAfterMs !== undefined) error.retryAfterMs = details.retryAfterMs;
  return error;
}

async function createDurableCommandApiServer(options = {}) {
  const maxBodyBytes = boundedInteger(options.maxBodyBytes ?? DEFAULT_DURABLE_COMMAND_API_OPTIONS.maxBodyBytes, 1024, 1024 * 1024, 'maxBodyBytes');
  const authorizationAttempts = boundedInteger(options.authorizationAttempts ?? DEFAULT_DURABLE_COMMAND_API_OPTIONS.authorizationAttempts, 1, 10, 'authorizationAttempts');
  const sourceRateLimit = boundedInteger(options.sourceRateLimit ?? DEFAULT_DURABLE_COMMAND_API_OPTIONS.sourceRateLimit, 1, 1000000, 'sourceRateLimit');
  const accountSubmitRateLimit = boundedInteger(options.accountSubmitRateLimit ?? DEFAULT_DURABLE_COMMAND_API_OPTIONS.accountSubmitRateLimit, 1, 1000000, 'accountSubmitRateLimit');
  const accountReadRateLimit = boundedInteger(options.accountReadRateLimit ?? DEFAULT_DURABLE_COMMAND_API_OPTIONS.accountReadRateLimit, 1, 1000000, 'accountReadRateLimit');
  const rateLimitWindowMs = boundedInteger(options.rateLimitWindowMs ?? DEFAULT_DURABLE_COMMAND_API_OPTIONS.rateLimitWindowMs, 10, 24 * 60 * 60 * 1000, 'rateLimitWindowMs');
  const maxTrackedSources = boundedInteger(options.maxTrackedSources ?? DEFAULT_DURABLE_COMMAND_API_OPTIONS.maxTrackedSources, 10, 1000000, 'maxTrackedSources');
  const maxTrackedAccounts = boundedInteger(options.maxTrackedAccounts ?? DEFAULT_DURABLE_COMMAND_API_OPTIONS.maxTrackedAccounts, 10, 1000000, 'maxTrackedAccounts');
  if (typeof options.rateLimitNow !== 'function') throw apiError(500, 'rate_limit_clock_required');
  const requestIdFactory = options.requestIdFactory || (() => crypto.randomUUID());
  if (typeof requestIdFactory !== 'function') throw apiError(500, 'request_id_factory_required');
  const limiterCommon = { windowMs: rateLimitWindowMs, now: options.rateLimitNow };
  const rateLimiters = Object.freeze({
    source: createFixedWindowRateLimiter({ ...limiterCommon, limit: sourceRateLimit, maxKeys: maxTrackedSources }),
    submit: createFixedWindowRateLimiter({ ...limiterCommon, limit: accountSubmitRateLimit, maxKeys: maxTrackedAccounts }),
    read: createFixedWindowRateLimiter({ ...limiterCommon, limit: accountReadRateLimit, maxKeys: maxTrackedAccounts }),
  });

  const shutdownTimeoutMs = boundedInteger(options.shutdownTimeoutMs ?? 5000, 10, 60000, 'shutdownTimeoutMs');
  if (options.health !== undefined && typeof options.health !== 'function') throw apiError(500, 'invalid_health');
  if (options.canSubmit !== undefined && typeof options.canSubmit !== 'function') throw apiError(500, 'invalid_admission');
  if (options.serviceStatus !== undefined && (typeof options.serviceStatus !== 'function' || typeof options.worldId !== 'string' || !options.worldId)) throw apiError(500, 'invalid_service_status');
  const consoleAssets = options.webConsole === true ? createConsoleAssets() : null;
  const ownsStore = !options.store || options.closeStore === true;
  const store = options.store || createPostgresDatabaseStore({ ...(options.database || {}), env: options.env });
  if (store.provider !== 'postgres' || !['loadWorld','enqueueCommand','getCommand','summary','close'].every(key => typeof store[key] === 'function')) {
    if (ownsStore && typeof store.close === 'function') await store.close().catch(() => {});
    throw apiError(500, 'transactional_store_required');
  }
  const ownsAuditStore = !options.auditStore;
  const auditStore = options.auditStore || (!options.store
    ? createPostgresCommandApiAuditStore({ ...(options.database || {}), env: options.env })
    : createCompatibilityAuditStore());
  if (!['append','close'].every(key => typeof auditStore[key] === 'function')) {
    if (ownsStore) await store.close().catch(() => {});
    throw apiError(500, 'audit_store_required');
  }
  try {
    await store.summary();
    if (typeof auditStore.summary === 'function') await auditStore.summary();
  } catch (error) {
    if (ownsStore) await store.close().catch(() => {});
    if (ownsAuditStore) await auditStore.close().catch(() => {});
    throw error;
  }

  let closePromise = null, closing = false;
  let auditFailures = 0;
  const pendingAudits = new Set();
  const requestOptions = Object.freeze({ maxBodyBytes, authorizationAttempts, rateLimiters,
    worldId: options.worldId, health: options.health, canSubmit: options.canSubmit, consoleAssets,
    serviceStatus: options.serviceStatus, auditStats });
  const server = http.createServer((req, res) => {
    setSafeHeaders(res);
    if (closing) { req.resume(); res.setHeader('Connection', 'close'); return writeMappedError(res, apiError(503, 'service_unavailable')); }
    let audit;
    try { audit = createRequestAudit(req, requestIdFactory); }
    catch (error) { auditFailures++; req.resume(); return writeMappedError(res, error); }
    res.setHeader('X-Request-Id', audit.requestId);
    const task = handleRequest(req, res, store, auditStore, requestOptions, audit)
      .then(() => audit.probe ? null : persistAudit(auditStore, audit, res.statusCode, null), error => {
        const mapped = mapError(error);
        writeMappedError(res, error);
        req.resume();
        return audit.probe ? null : persistAudit(auditStore, audit, mapped.status, mapped.code);
      })
      .catch(() => { auditFailures += 1; });
    pendingAudits.add(task);
    task.finally(() => pendingAudits.delete(task));
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      if (server.listening) await new Promise(resolve => {
        const timer = setTimeout(() => server.closeAllConnections(), shutdownTimeoutMs);
        server.close(() => { clearTimeout(timer); resolve(); });
      });
      // Responses finish before their operational audit. Drain those writes
      // before closing either database pool during graceful shutdown.
      await Promise.all([...pendingAudits]);
      const closing = [];
      if (ownsStore) closing.push(store.close());
      if (ownsAuditStore) closing.push(auditStore.close());
      await Promise.all(closing);
    })();
    return closePromise;
  }
  function rateLimitStats() {
    return { trackedSources: rateLimiters.source.size(), trackedSubmitAccounts: rateLimiters.submit.size(), trackedReadAccounts: rateLimiters.read.size() };
  }
  function auditStats() { return { failures: auditFailures, durable: auditStore.provider === 'postgres' }; }

  return Object.freeze({
    server, store, auditStore, close, rateLimitStats, auditStats,
    options: Object.freeze({ maxBodyBytes, authorizationAttempts, sourceRateLimit, accountSubmitRateLimit,
      accountReadRateLimit, rateLimitWindowMs, maxTrackedSources, maxTrackedAccounts }),
  });
}

async function handleRequest(req, res, store, auditStore, options, audit) {
  setSafeHeaders(res);
  const method = String(req.method || 'GET').toUpperCase();
  audit.method = method;
  const parsed = new URL(req.url || '/', 'http://localhost');
  const asset = options.consoleAssets?.get(parsed.pathname);
  // Static shell requests contain no operational data and must not fill SQL audit.
  if (asset) audit.probe = true;
  if (options.health && ['/health/live', '/health/ready'].includes(parsed.pathname)) audit.probe = true;
  enforceRateLimit(options.rateLimiters.source.consume(requestSourceKey(req)));
  if (asset) {
    if (!['GET', 'HEAD'].includes(method)) throw apiError(405, 'method_not_allowed');
    if (parsed.search) throw apiError(400, 'invalid_query');
    return serveConsoleAsset(req, res, asset);
  }
  if (audit.probe) {
    if (method !== 'GET') throw apiError(405, 'method_not_allowed');
    if (parsed.search) throw apiError(400, 'invalid_query');
    const ready = parsed.pathname === '/health/live' || await options.health();
    return writeJson(res, ready ? 200 : 503, { ok: ready === true, status: ready ? 'ok' : 'unavailable' });
  }
  const route = parseCommandRoute(parsed.pathname);
  if (!route) throw apiError(404, 'not_found');
  if (route.kind === 'submit' && method === 'GET') route.kind = 'history';
  audit.route = route.kind;
  audit.worldId = route.worldId;
  if (route.playerId) audit.playerId = route.playerId;
  if (route.commandId) audit.commandId = route.commandId;
  if (options.worldId !== undefined && route.worldId !== options.worldId) throw apiError(404, 'world_not_found');

  if (route.kind === 'submit') {
    if (method !== 'POST') throw apiError(405, 'method_not_allowed');
    const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') { req.resume(); throw apiError(415, 'json_required'); }
    const body = await readJsonBody(req, options.maxBodyBytes);
    if (!isObject(body)) throw apiError(400, 'invalid_command');
    if (typeof body.id !== 'string' || !body.id) throw apiError(400, 'command_id_required');
    if (typeof body.type !== 'string' || !body.type) throw apiError(400, 'command_type_required');
    audit.commandId = body.id;
    const token = bearerToken(req);
    const row = await withFreshPlayerAuthorization(store, route.worldId, route.playerId, token,
      options.authorizationAttempts, options.rateLimiters.submit, audit,
      async context => {
        if (options.canSubmit && !await options.canSubmit()) throw apiError(503, 'service_unavailable', { retryAfterMs: 1000 });
        return store.enqueueCommand({ worldId: route.worldId, id: body.id, playerId: route.playerId, input: body },
          { expectedWorldRevision: context.revision });
      });
    return writeJson(res, row.status === 'applied' ? 200 : 202, { ok: true, data: commandView(row) });
  }

  if (route.kind === 'history') {
    const query = parseCommandHistoryQuery(parsed.searchParams);
    const page = await withFreshPlayerAuthorization(store, route.worldId, route.playerId, bearerToken(req),
      options.authorizationAttempts, options.rateLimiters.read, audit, context => {
        if (typeof store.listCommandReceipts !== 'function') throw apiError(503, 'service_unavailable');
        return store.listCommandReceipts({ ...query, worldId: route.worldId, playerId: route.playerId }, { expectedWorldRevision: context.revision });
      });
    const records = page.records.map(commandReceiptView);
    return writeJson(res, 200, { ok: true, data: { worldId: route.worldId, playerId: route.playerId, revision: page.revision, records,
      nextBeforeSequence: records.length === query.limit ? records[records.length - 1].sequence : null } });
  }
  if (route.kind === 'queue' || route.kind === 'operations') {
    if (method !== 'GET') throw apiError(405, 'method_not_allowed');
    if (parsed.search) throw apiError(400, 'invalid_query');
    let checked = false;
    for (let attempt = 0; attempt < options.authorizationAttempts; attempt++) {
      const context = await authenticateWorld(store, route.worldId, bearerToken(req), audit);
      if (!checked) { enforceRateLimit(options.rateLimiters.read.consume(accountRateKey(route.worldId, context.auth.account.id))); checked = true; }
      requirePermission(isPrivileged(context.auth.account), route.kind === 'operations' ? 'operations_forbidden' : 'queue_forbidden');
      if (typeof store.getCommandQueue !== 'function') throw apiError(503, 'service_unavailable');
      try {
        const queue = await store.getCommandQueue(route.worldId, { expectedWorldRevision: context.revision });
        if (route.kind === 'operations') {
          const service = serviceStatusView(options.serviceStatus?.());
          return writeJson(res, 200, { ok: true, data: {
            worldId: route.worldId, revision: context.revision, tick: context.world.tick,
            service, queue: commandQueueView(queue), audit: options.auditStats(),
          } });
        }
        return writeJson(res, 200, { ok: true, data: commandQueueView(queue) });
      } catch (error) {
        if (error?.code === 'WORLD_DB_REVISION_CONFLICT' && attempt + 1 < options.authorizationAttempts) continue;
        throw error;
      }
    }
  }
  if (route.kind === 'status') {
    if (method !== 'GET') throw apiError(405, 'method_not_allowed');
    const token = bearerToken(req);
    const row = await withFreshCommandAuthorization(store, route.worldId, route.commandId, token,
      options.authorizationAttempts, options.rateLimiters.read, audit);
    audit.playerId = row.playerId;
    return writeJson(res, 200, { ok: true, data: commandView(row) });
  }
  if (route.kind === 'state' || route.kind === 'summary') {
    if (method !== 'GET') throw apiError(405, 'method_not_allowed');
    if (parsed.search) throw apiError(400, 'invalid_query');
    // Authorization and data come from the same committed checkpoint. No second
    // world read may race a revoked session or a player ownership change.
    const context = await authenticateWorld(store, route.worldId, bearerToken(req), audit);
    enforceRateLimit(options.rateLimiters.read.consume(accountRateKey(route.worldId, context.auth.account.id)));
    let data;
    if (route.kind === 'state') {
      requirePermission(canAccessPlayer(context.auth.account, route.playerId), 'player_forbidden');
      if (!context.world.players?.byId?.[route.playerId]) throw apiError(404, 'player_not_found');
      data = playerStateView(context.world, context.revision, route.playerId);
    } else {
      requirePermission(isPrivileged(context.auth.account), 'summary_forbidden');
      data = worldSummaryView(context.world, context.revision);
    }
    return writeJson(res, 200, { ok: true, data });
  }
  if (route.kind === 'audit') {
    if (method !== 'GET') throw apiError(405, 'method_not_allowed');
    const query = parseAuditQuery(parsed.searchParams);
    const rows = await withFreshAuditAuthorization(store, auditStore, route.worldId, bearerToken(req),
      options.authorizationAttempts, options.rateLimiters.read, audit, query);
    const records = rows.map(auditView);
    return writeJson(res, 200, { ok: true, data: {
      records,
      nextBeforeSequence: records.length === query.limit ? records[records.length - 1].sequence : null,
    } });
  }
  throw apiError(404, 'not_found');
}

async function withFreshAuditAuthorization(store, auditStore, worldId, token, attempts, accountLimiter, audit, query) {
  let accountRateChecked = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const context = await authenticateWorld(store, worldId, token, audit);
    if (!accountRateChecked) {
      enforceRateLimit(accountLimiter.consume(accountRateKey(worldId, context.auth.account.id)));
      accountRateChecked = true;
    }
    requirePermission(isPrivileged(context.auth.account), 'audit_forbidden');
    if (auditStore.provider !== 'postgres' || typeof auditStore.list !== 'function') throw apiError(503, 'service_unavailable');
    try {
      return await auditStore.list({ ...query, worldId, order: 'desc' }, { expectedWorldRevision: context.revision });
    } catch (error) {
      if (error?.code === 'WORLD_DB_REVISION_CONFLICT' && attempt + 1 < attempts) continue;
      throw error;
    }
  }
}

function parseCommandHistoryQuery(params) {
  const query = { limit: 50 }, seen = new Set();
  for (const [key, value] of params) {
    if (seen.has(key)) throw apiError(400, 'invalid_command_query');
    seen.add(key);
    if (key === 'limit' || key === 'beforeSequence') {
      const number = Number(value), max = key === 'limit' ? 100 : Number.MAX_SAFE_INTEGER;
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > max) throw apiError(400, 'invalid_command_query');
      query[key] = number;
    } else if (key === 'status' && ['pending', 'applied'].includes(value)) query.status = value;
    else throw apiError(400, 'invalid_command_query');
  }
  return query;
}

function parseAuditQuery(params) {
  const query = { limit: 100 };
  const seen = new Set();
  const textLimits = { accountId: 200, playerId: 200, commandId: 256 };
  for (const [key, value] of params) {
    if (seen.has(key)) throw apiError(400, 'invalid_audit_query');
    seen.add(key);
    if (['limit', 'beforeSequence', 'statusCode'].includes(key)) {
      const min = key === 'statusCode' ? 100 : 1;
      const max = key === 'limit' ? 1000 : key === 'statusCode' ? 599 : Number.MAX_SAFE_INTEGER;
      const number = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) throw apiError(400, 'invalid_audit_query');
      query[key] = number;
    } else if (Object.hasOwn(textLimits, key)) {
      if (!value.trim() || value.length > textLimits[key] || value.includes('\u0000')) throw apiError(400, 'invalid_audit_query');
      query[key] = value;
    } else if (key === 'method' && ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','CONNECT','TRACE'].includes(value)) {
      query.method = value;
    } else if (key === 'route' && ['submit','status','audit','state','summary','history','queue','operations','unknown'].includes(value)) {
      query.route = value;
    } else {
      throw apiError(400, 'invalid_audit_query');
    }
  }
  return query;
}

async function withFreshPlayerAuthorization(store, worldId, playerId, token, attempts, accountLimiter, audit, action) {
  let lastConflict = null, accountRateChecked = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const context = await authenticateWorld(store, worldId, token, audit);
    if (!accountRateChecked) { enforceRateLimit(accountLimiter.consume(accountRateKey(worldId, context.auth.account.id))); accountRateChecked = true; }
    if (!context.world.players?.byId?.[playerId]) throw apiError(404, 'player_not_found');
    requirePermission(canAccessPlayer(context.auth.account, playerId), 'player_forbidden');
    try { return await action(context); }
    catch (error) {
      if (error?.code === 'WORLD_DB_REVISION_CONFLICT' && attempt + 1 < attempts) { lastConflict = error; continue; }
      throw error;
    }
  }
  throw lastConflict || apiError(409, 'world_revision_changed');
}

async function withFreshCommandAuthorization(store, worldId, commandId, token, attempts, accountLimiter, audit) {
  let lastConflict = null, accountRateChecked = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const context = await authenticateWorld(store, worldId, token, audit);
    if (!accountRateChecked) { enforceRateLimit(accountLimiter.consume(accountRateKey(worldId, context.auth.account.id))); accountRateChecked = true; }
    try {
      const row = await store.getCommand(worldId, commandId, { expectedWorldRevision: context.revision });
      if (!row) throw apiError(404, 'command_not_found');
      requirePermission(canAccessPlayer(context.auth.account, row.playerId), 'command_forbidden');
      return row;
    } catch (error) {
      if (error?.code === 'WORLD_DB_REVISION_CONFLICT' && attempt + 1 < attempts) { lastConflict = error; continue; }
      throw error;
    }
  }
  throw lastConflict || apiError(409, 'world_revision_changed');
}

async function authenticateWorld(store, worldId, token, audit) {
  if (!token) throw apiError(401, 'auth_required');
  const loaded = await (typeof store.loadWorldView === 'function' ? store.loadWorldView(worldId) : store.loadWorld(worldId));
  if (!loaded) throw apiError(404, 'world_not_found');
  // Session validation repairs legacy account indexes and marks expiry locally.
  // Keep those mutations private to this request, never in a shared checkpoint.
  const authWorld = { tick: loaded.world.tick, accounts: loaded.world.accounts === undefined
    ? undefined : JSON.parse(JSON.stringify(loaded.world.accounts)) };
  const auth = requireSession(validateSession(authWorld, token));
  audit.accountId = auth.account.id;
  return { world: loaded.world, revision: loaded.revision, auth };
}

function createRequestAudit(req, factory) {
  const requestId = String(factory());
  if (!requestId || requestId.length > 128 || requestId.includes('\u0000')) throw apiError(500, 'invalid_request_id');
  http.validateHeaderValue('X-Request-Id', requestId);
  return { requestId, method: String(req.method || 'GET').toUpperCase(), route: 'unknown', worldId: null,
    accountId: null, playerId: null, commandId: null };
}
async function persistAudit(store, audit, statusCode, errorCode) {
  return store.append({ ...audit, statusCode, errorCode: errorCode || null });
}
function createCompatibilityAuditStore() {
  return Object.freeze({ provider: 'memory', async append() { return null; }, async close() {}, async summary() { return { records: 0 }; } });
}

function parseCommandRoute(pathname) {
  const segments = String(pathname || '/').split('/').filter(Boolean).map(decodeSegment);
  if (segments.length === 6 && segments[0] === 'durable' && segments[1] === 'worlds' && segments[3] === 'players' && ['commands','state'].includes(segments[5])) {
    return { kind: segments[5] === 'commands' ? 'submit' : 'state', worldId: segments[2], playerId: segments[4] };
  }
  if (segments.length === 5 && segments[0] === 'durable' && segments[1] === 'worlds' && segments[3] === 'commands') {
    return { kind: 'status', worldId: segments[2], commandId: segments[4] };
  }
  if (segments.length === 5 && segments[0] === 'durable' && segments[1] === 'worlds' && segments[3] === 'admin' && ['audit','summary','queue','operations'].includes(segments[4])) {
    return { kind: segments[4], worldId: segments[2] };
  }
  return null;
}
function decodeSegment(value) {
  try { const decoded = decodeURIComponent(value); if (!decoded || decoded.includes('\u0000')) throw new Error('bad'); return decoded; }
  catch (_) { throw apiError(400, 'invalid_path'); }
}
function bearerToken(req) { const match = String(req.headers.authorization || '').match(/^Bearer\s+([^\s]+)$/i); return match ? match[1] : null; }
function requestSourceKey(req) { let address = String(req?.socket?.remoteAddress || 'unknown').trim().toLowerCase(); if (address.startsWith('::ffff:')) address = address.slice(7); return `socket:${address || 'unknown'}`; }
function accountRateKey(worldId, accountId) { return `world:${String(worldId)}\u0001account:${String(accountId)}`; }
function enforceRateLimit(result) { if (!result?.allowed) throw apiError(429, 'rate_limited', { retryAfterMs: result?.retryAfterMs || 1000 }); return result; }

function readJsonBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, settled = false;
    req.on('data', chunk => { if (settled) return; size += chunk.length; if (size > maxBodyBytes) { settled = true; req.resume(); reject(apiError(413, 'request_body_too_large')); return; } chunks.push(chunk); });
    req.on('end', () => { if (settled) return; settled = true; if (!chunks.length) return reject(apiError(400, 'json_body_required')); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(apiError(400, 'invalid_json')); } });
    req.on('aborted', () => { if (!settled) { settled = true; reject(apiError(400, 'request_aborted')); } });
    req.on('error', error => { if (!settled) { settled = true; reject(error); } });
  });
}
function commandReceiptView(row) {
  return { id: row.id, worldId: row.worldId, playerId: row.playerId, sequence: row.sequence,
    status: row.status, submittedAt: row.submittedAt || null, appliedAt: row.appliedAt || null };
}
function commandQueueView(row) {
  return { worldId: row.worldId, revision: row.revision, pending: row.pending, pendingIsLowerBound: row.pendingIsLowerBound,
    oldestPendingSequence: row.oldestPendingSequence, worldCapacityAvailable: row.worldCapacityAvailable,
    limits: { maxPendingCommands: row.limits.maxPendingCommands, maxPendingPerPlayer: row.limits.maxPendingPerPlayer } };
}
function commandView(row) { return { id: row.id, worldId: row.worldId, playerId: row.playerId, sequence: row.sequence, status: row.status,
  result: row.status === 'applied' ? row.result : null, submittedAt: row.submittedAt || null, appliedAt: row.appliedAt || null, idempotent: row.idempotent === true }; }
function auditView(row) {
  return { sequence: row.sequence, requestId: row.requestId, worldId: row.worldId, accountId: row.accountId,
    playerId: row.playerId, commandId: row.commandId, method: row.method, route: row.route,
    statusCode: row.statusCode, errorCode: row.errorCode, createdAt: row.createdAt };
}
function writeMappedError(res, error) {
  if (res.writableEnded || res.destroyed) return;
  const mapped = mapError(error);
  if (mapped.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
  if (mapped.status === 429 || (mapped.status === 503 && mapped.retryAfterMs !== undefined)) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(Number(mapped.retryAfterMs || 1000) / 1000))));
  writeJson(res, mapped.status, { ok: false, error: mapped.code });
}
function mapError(error) {
  if (Number.isInteger(error?.statusCode)) return { status: error.statusCode, code: safeApiCode(error.apiCode || error.message), ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) };
  const code = String(error?.code || '');
  if (['WORLD_DB_INVALID_INPUT','WORLD_DB_INVALID_CONFIG'].includes(code)) return { status: 400, code: 'invalid_command' };
  if (['WORLD_DB_QUEUE_FULL','WORLD_DB_PLAYER_QUEUE_FULL'].includes(code)) return { status: 429, code: code === 'WORLD_DB_QUEUE_FULL' ? 'command_queue_full' : 'player_queue_full', retryAfterMs: 1000 };
  if (code === 'WORLD_DB_PAYLOAD_TOO_LARGE') return { status: 413, code: 'command_too_large' };
  if (code === 'WORLD_DB_MISSING_WORLD') return { status: 404, code: 'world_not_found' };
  if (['WORLD_DB_IDEMPOTENCY_CONFLICT','WORLD_DB_REVISION_CONFLICT','WORLD_DB_COMMAND_CONFLICT'].includes(code)) return { status: 409, code: code === 'WORLD_DB_IDEMPOTENCY_CONFLICT' ? 'command_id_conflict' : 'world_revision_changed' };
  if (['WORLD_DB_UNAVAILABLE','WORLD_DB_TIMEOUT','WORLD_DB_MIGRATION_REQUIRED','WORLD_DB_CLOSED'].includes(code)) return { status: 503, code: 'service_unavailable' };
  return { status: 500, code: 'internal_error' };
}
function safeApiCode(value) {
  const allowed = new Set(['invalid_command_query','queue_forbidden','operations_forbidden','request_aborted','invalid_query','summary_forbidden','auth_required','player_forbidden','command_forbidden','audit_forbidden','invalid_audit_query','service_unavailable','player_not_found','world_not_found','command_not_found','not_found','method_not_allowed','json_required','invalid_command','command_id_required','command_type_required','request_body_too_large','json_body_required','invalid_json','invalid_path','world_revision_changed','transactional_store_required','audit_store_required','rate_limited']);
  return allowed.has(value) ? value : 'internal_error';
}
function setSafeHeaders(res) { res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer'); }
function writeJson(res, statusCode, payload) { if (res.writableEnded || res.destroyed) return; const text = JSON.stringify(payload); res.statusCode = statusCode; res.setHeader('Content-Type','application/json; charset=utf-8'); res.setHeader('Content-Length',Buffer.byteLength(text)); res.end(text); }
function boundedInteger(value, min, max, name) { const number = Number(value); if (!Number.isInteger(number) || number < min || number > max) throw apiError(500, `invalid_${name}`); return number; }
function isObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }

module.exports = { DEFAULT_DURABLE_COMMAND_API_OPTIONS, createDurableCommandApiServer, parseCommandRoute, commandView, mapError,
  requestSourceKey, enforceRateLimit, createRequestAudit, persistAudit };
