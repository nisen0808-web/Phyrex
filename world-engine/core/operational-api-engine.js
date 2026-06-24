'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const {
  createWorldApiServer: createTemplateWorldApiServer,
  synchronizeLoopAfterWorldReset,
} = require('./world-template-api-engine');
const {
  createAccount,
  createSession,
  getAccount,
  getAccountView,
  getAccountStats,
  getSessionByToken,
  validateSession,
  sanitizeSession,
} = require('./account-session-engine');
const { canRunWorldControl } = require('./api-permission-engine');
const { saveWorld, loadWorld, listSaves } = require('./persistence-engine');
const { queryWorld } = require('./query-engine');
const { getApiAuditStats, recordApiRequest } = require('./api-audit-engine');
const {
  RUNTIME_LOOP_STATUS,
  pauseRuntimeLoop,
  getRuntimeLoopSummary,
} = require('./runtime-loop-engine');
const {
  resolveManagedPath,
  redactProductionConfig,
} = require('./production-config-engine');

const OPERATIONAL_PATHS = new Set([
  '/livez',
  '/readyz',
  '/version',
  '/metrics',
  '/admin/config',
  '/admin/maintenance',
  '/admin/backups',
  '/admin/backups/restore',
]);

const AUTH_PATHS = new Set(['/accounts', '/sessions']);
const PERSISTENCE_PATHS = new Set(['/save', '/load', '/saves']);
const RATE_LIMIT_EXEMPT_PREFIXES = ['/client/', '/livez', '/readyz', '/version'];

function createOperationalWorldApiServer(worldInput = null, options = {}) {
  const production = options.productionConfig || {
    enabled: false,
    requireAuth: Boolean(options.requireAuth),
    dataDir: path.resolve('world-engine/output'),
    defaultSavePath: path.resolve('world-engine/output/world.json'),
    corsOrigins: ['*'],
    rateLimitWindowMs: 60000,
    rateLimitMax: 300,
    authRateLimitMax: 30,
    metricsPublic: true,
    maintenanceAtStart: false,
    releaseVersion: '0.1.0',
    releaseSha: null,
  };
  fs.mkdirSync(production.dataDir, { recursive: true });

  const result = createTemplateWorldApiServer(worldInput, {
    ...options,
    requireAuth: production.enabled ? true : Boolean(options.requireAuth || production.requireAuth),
    defaultSavePath: production.defaultSavePath || options.defaultSavePath,
  });
  const state = {
    startedAtMs: Date.now(),
    requestCount: 0,
    rejectedCount: 0,
    rateLimitedCount: 0,
    maintenance: {
      enabled: Boolean(production.maintenanceAtStart),
      reason: production.maintenanceAtStart ? 'startup_maintenance' : null,
      changedAt: new Date().toISOString(),
      changedBy: 'system',
    },
    limiter: createRateLimiter({
      windowMs: production.rateLimitWindowMs,
      max: production.rateLimitMax,
      authMax: production.authRateLimitMax,
    }),
  };
  result.api.operationalState = state;
  result.api.productionConfig = production;

  if (production.enabled) ensureOperatorAccess(result.api.getWorld(), production);

  const listeners = result.server.listeners('request');
  const downstream = listeners[0];
  if (typeof downstream !== 'function') throw new Error('Operational API requires downstream request listener');
  result.server.removeListener('request', downstream);
  result.server.on('request', (req, res) => {
    return handleOperationalRequest(req, res, result.api, result.options, production, state, downstream)
      .catch(error => {
        if (!res.headersSent) writeJson(res, error.statusCode || 500, {
          ok: false,
          error: error.message || 'operational_api_error',
          requestId: req.apiRequestId || null,
        });
        else if (!res.writableEnded) res.end();
      });
  });

  return {
    ...result,
    operationalState: state,
    productionConfig: production,
  };
}

async function handleOperationalRequest(req, res, api, options, production, state, downstream) {
  const started = Date.now();
  const parsed = new URL(req.url || '/', 'http://localhost');
  const pathname = normalizePath(parsed.pathname);
  const method = req.method || 'GET';
  req.apiRequestId = req.headers['x-request-id'] || req.apiRequestId || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.apiRequestId);
  applyOperationalHeaders(req, res, pathname, production);
  state.requestCount += 1;

  const originAllowed = applyCors(req, res, production.corsOrigins || ['*']);
  if (!originAllowed) {
    state.rejectedCount += 1;
    return finishHandled(req, res, api, started, 403, { ok: false, error: 'cors_origin_forbidden' });
  }
  if (method === 'OPTIONS') return finishHandled(req, res, api, started, 204, null, { text: '' });

  const auth = getRequestAuth(api.getWorld(), req, parsed);
  req.apiAccountId = auth?.account?.id || null;
  const privileged = Boolean(auth && canRunWorldControl(auth.account));

  const rate = consumeRequestRate(state.limiter, req, pathname, production, privileged);
  if (!rate.allowed) {
    state.rateLimitedCount += 1;
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))));
    res.setHeader('X-RateLimit-Limit', String(rate.limit));
    res.setHeader('X-RateLimit-Remaining', '0');
    return finishHandled(req, res, api, started, 429, {
      ok: false,
      error: 'rate_limit_exceeded',
      retryAfterMs: Math.max(0, rate.resetAt - Date.now()),
    });
  }
  if (rate.limit) {
    res.setHeader('X-RateLimit-Limit', String(rate.limit));
    res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
  }

  if (isMaintenanceBlocked(state.maintenance, method, pathname, privileged)) {
    state.rejectedCount += 1;
    res.setHeader('Retry-After', '60');
    return finishHandled(req, res, api, started, 503, {
      ok: false,
      error: 'service_in_maintenance',
      maintenance: { ...state.maintenance },
    });
  }

  if (OPERATIONAL_PATHS.has(pathname)) {
    return handleOperationalEndpoint(req, res, parsed, pathname, api, production, state, auth, started);
  }

  if (production.enabled && AUTH_PATHS.has(pathname) && method === 'POST') {
    return handlePrivilegedIdentityEndpoint(req, res, pathname, api, production, auth, started);
  }

  if (production.enabled && PERSISTENCE_PATHS.has(pathname)) {
    return handleSafePersistenceEndpoint(req, res, parsed, pathname, api, production, auth, started);
  }

  if (production.enabled && method === 'POST' && pathname === '/admin/templates/reset') {
    requireOperator(auth);
    const body = await readJsonBody(req, options);
    if (body.backup === true) {
      const fallback = `template-reset-${sanitizeFilePart(api.getWorld()?.id)}-${Date.now()}.json`;
      body.backupPath = resolveManagedPath(production.dataDir, body.backupPath || fallback, { extension: '.json' });
    }
    req.apiJsonBody = body;
  }

  return downstream.call(api.server || null, req, res);
}

async function handleOperationalEndpoint(req, res, parsed, pathname, api, production, state, auth, started) {
  const method = req.method || 'GET';
  if (method === 'GET' && pathname === '/livez') {
    return finishHandled(req, res, api, started, 200, {
      ok: true,
      service: 'phyrex-world-engine',
      uptimeSeconds: Math.floor((Date.now() - state.startedAtMs) / 1000),
    });
  }

  if (method === 'GET' && pathname === '/readyz') {
    const readiness = getReadiness(api, state);
    return finishHandled(req, res, api, started, readiness.ready ? 200 : 503, {
      ok: readiness.ready,
      ...readiness,
    });
  }

  if (method === 'GET' && pathname === '/version') {
    return finishHandled(req, res, api, started, 200, {
      ok: true,
      service: 'phyrex-world-engine',
      version: production.releaseVersion || '0.1.0',
      releaseSha: production.releaseSha || null,
      production: Boolean(production.enabled),
      authRequired: Boolean(production.enabled || production.requireAuth),
      node: process.version,
    });
  }

  if (method === 'GET' && pathname === '/metrics') {
    if (!production.metricsPublic) requireOperator(auth);
    const text = formatPrometheusMetrics(api, state, production);
    recordHandledAudit(req, api, pathname, 200, Date.now() - started, null);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(text));
    res.end(text);
    return;
  }

  if (pathname === '/admin/config' && method === 'GET') {
    requireOperator(auth);
    return finishHandled(req, res, api, started, 200, {
      ok: true,
      data: redactProductionConfig(production),
    });
  }

  if (pathname === '/admin/maintenance' && method === 'GET') {
    requireOperator(auth);
    return finishHandled(req, res, api, started, 200, { ok: true, data: { ...state.maintenance } });
  }

  if (pathname === '/admin/maintenance' && method === 'POST') {
    const operator = requireOperator(auth);
    const body = await readJsonBody(req, {});
    state.maintenance = {
      enabled: Boolean(body.enabled),
      reason: body.enabled ? String(body.reason || 'operator_maintenance') : null,
      changedAt: new Date().toISOString(),
      changedBy: operator.account.id,
    };
    api.broadcast({
      type: 'service.maintenance',
      worldId: api.getWorld()?.id || null,
      tick: api.getWorld()?.tick ?? null,
      maintenance: { ...state.maintenance },
    });
    return finishHandled(req, res, api, started, 200, { ok: true, data: { ...state.maintenance } });
  }

  if (pathname === '/admin/backups' && method === 'GET') {
    requireOperator(auth);
    return finishHandled(req, res, api, started, 200, {
      ok: true,
      data: { directory: production.dataDir, saves: listSaves(production.dataDir) },
    });
  }

  if (pathname === '/admin/backups' && method === 'POST') {
    const operator = requireOperator(auth);
    const body = await readJsonBody(req, {});
    const fallback = `backup-${sanitizeFilePart(api.getWorld()?.id)}-tick-${Number(api.getWorld()?.tick || 0)}-${Date.now()}.json`;
    const filePath = resolveManagedPath(production.dataDir, body.filePath || fallback, { extension: '.json' });
    const saved = saveWorld(api.getWorld(), filePath, {
      createBackup: body.createBackup !== false,
      reason: body.reason || 'operator_backup',
      metadata: {
        ...(body.metadata || {}),
        source: 'operational_api',
        operatorAccountId: operator.account.id,
      },
    });
    api.broadcast({ type: 'backup.created', worldId: saved.worldId, tick: saved.tick, file: saved.file });
    return finishHandled(req, res, api, started, 201, { ok: true, data: saved });
  }

  if (pathname === '/admin/backups/restore' && method === 'POST') {
    const operator = requireOperator(auth);
    const body = await readJsonBody(req, {});
    const current = api.getWorld();
    if (String(body.confirmWorldId || '') !== String(current?.id || '')) throw httpError(409, 'restore_confirmation_mismatch');
    const restored = restoreManagedWorld(api, production, body.filePath, {
      pauseLoop: body.pauseLoop !== false,
      source: 'operator_restore',
      operatorAccountId: operator.account.id,
    });
    return finishHandled(req, res, api, started, 200, { ok: true, data: restored });
  }

  return finishHandled(req, res, api, started, 405, { ok: false, error: 'method_not_allowed' });
}

async function handlePrivilegedIdentityEndpoint(req, res, pathname, api, production, auth, started) {
  requireOperator(auth);
  const body = await readJsonBody(req, {});
  if (pathname === '/accounts') {
    const account = createAccount(api.getWorld(), body.account || body || {});
    api.broadcast({
      type: 'account.created',
      worldId: api.getWorld().id,
      tick: api.getWorld().tick,
      accountId: account.id,
    });
    return finishHandled(req, res, api, started, 201, { ok: true, data: getAccountView(api.getWorld(), account.id) });
  }
  if (pathname === '/sessions') {
    const accountId = requiredBody(body, 'accountId');
    const session = createSession(api.getWorld(), accountId, body.options || {});
    return finishHandled(req, res, api, started, 201, {
      ok: true,
      data: {
        token: session.token,
        session: sanitizeSession(session),
        account: getAccountView(api.getWorld(), accountId),
      },
    });
  }
  throw httpError(404, 'identity_endpoint_not_found');
}

async function handleSafePersistenceEndpoint(req, res, parsed, pathname, api, production, auth, started) {
  requireOperator(auth);
  const method = req.method || 'GET';
  if (pathname === '/saves' && method === 'GET') {
    const requestedDir = parsed.searchParams.get('dir');
    const directory = requestedDir ? resolveManagedPath(production.dataDir, requestedDir) : production.dataDir;
    return finishHandled(req, res, api, started, 200, { ok: true, data: { saves: listSaves(directory) } });
  }

  if (pathname === '/save' && method === 'POST') {
    const body = await readJsonBody(req, {});
    const filePath = resolveManagedPath(
      production.dataDir,
      body.filePath || body.path || production.defaultSavePath,
      { extension: '.json' },
    );
    const saved = saveWorld(api.getWorld(), filePath, body.options || {});
    api.broadcast({ type: 'save', worldId: saved.worldId, tick: saved.tick, file: saved.file });
    return finishHandled(req, res, api, started, 200, { ok: true, data: saved });
  }

  if (pathname === '/load' && method === 'POST') {
    const body = await readJsonBody(req, {});
    const restored = restoreManagedWorld(api, production, body.filePath || body.path || production.defaultSavePath, {
      pauseLoop: body.pauseLoop !== false,
      source: 'safe_load',
    });
    return finishHandled(req, res, api, started, 200, { ok: true, data: restored });
  }

  return finishHandled(req, res, api, started, 405, { ok: false, error: 'method_not_allowed' });
}

function restoreManagedWorld(api, production, requestedPath, metadata = {}) {
  const summary = getRuntimeLoopSummary(api.runtimeLoop);
  if (summary.busy) throw httpError(409, 'runtime_loop_busy');
  if (summary.status === RUNTIME_LOOP_STATUS.RUNNING) {
    if (!metadata.pauseLoop) throw httpError(409, 'runtime_loop_running');
    pauseRuntimeLoop(api.runtimeLoop, metadata.source || 'world_restore');
  }
  const filePath = resolveManagedPath(production.dataDir, requestedPath, { extension: '.json' });
  const loaded = loadWorld(filePath);
  api.setWorld(loaded.world);
  if (production.enabled) ensureOperatorAccess(loaded.world, production);
  synchronizeLoopAfterWorldReset(api.runtimeLoop, loaded.world);
  api.broadcast({ type: 'load', worldId: loaded.worldId, tick: loaded.tick, file: loaded.file });
  return {
    file: loaded.file,
    worldId: loaded.worldId,
    tick: loaded.tick,
    savedAt: loaded.savedAt,
    loop: getRuntimeLoopSummary(api.runtimeLoop),
  };
}

function ensureOperatorAccess(world, production) {
  if (!production.enabled) return null;
  let account = getAccount(world, production.operatorAccountId);
  if (!account) {
    account = createAccount(world, {
      id: production.operatorAccountId,
      name: production.operatorAccountName,
      roles: ['admin', 'gm'],
      meta: { systemOperator: true },
    });
  }
  account.status = 'active';
  account.roles = [...new Set([...(account.roles || []), 'admin', 'gm'])];
  const existingSession = getSessionByToken(world, production.operatorToken);
  if (existingSession && existingSession.accountId !== account.id) {
    throw new Error('operator_token_already_assigned');
  }
  if (!existingSession) {
    createSession(world, account.id, {
      token: production.operatorToken,
      sessionTtlTicks: 0,
      meta: { systemOperator: true },
    });
  }
  return { account, session: getSessionByToken(world, production.operatorToken) };
}

function getReadiness(api, state) {
  const world = api.getWorld();
  const loop = getRuntimeLoopSummary(api.runtimeLoop);
  const reasons = [];
  if (!world) reasons.push('world_missing');
  if (state.maintenance.enabled) reasons.push('maintenance');
  if (loop.busy) reasons.push('runtime_loop_busy');
  return {
    ready: reasons.length === 0,
    reasons,
    worldId: world?.id || null,
    tick: world?.tick ?? null,
    maintenance: { ...state.maintenance },
    loop: { status: loop.status, busy: loop.busy, errorCount: loop.errorCount },
  };
}

function createRateLimiter(options = {}) {
  return {
    options: {
      windowMs: Math.max(1000, Number(options.windowMs || 60000)),
      max: Math.max(1, Number(options.max || 300)),
      authMax: Math.max(1, Number(options.authMax || 30)),
    },
    buckets: new Map(),
    lastPruneAt: 0,
  };
}

function consumeRequestRate(limiter, req, pathname, production, privileged = false) {
  if (!production.enabled || privileged || isRateLimitExempt(req.method, pathname)) {
    return { allowed: true, limit: 0, remaining: 0, resetAt: Date.now() };
  }
  const now = Date.now();
  pruneRateLimiter(limiter, now);
  const category = AUTH_PATHS.has(pathname) ? 'auth' : 'default';
  const limit = category === 'auth' ? limiter.options.authMax : limiter.options.max;
  const key = `${category}:${clientAddress(req)}`;
  let bucket = limiter.buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + limiter.options.windowMs };
    limiter.buckets.set(key, bucket);
  }
  bucket.count += 1;
  return {
    allowed: bucket.count <= limit,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt,
  };
}

function pruneRateLimiter(limiter, now = Date.now()) {
  if (now - limiter.lastPruneAt < limiter.options.windowMs) return;
  limiter.lastPruneAt = now;
  for (const [key, bucket] of limiter.buckets.entries()) {
    if (bucket.resetAt <= now) limiter.buckets.delete(key);
  }
}

function isRateLimitExempt(method, pathname) {
  if (method === 'GET' && pathname === '/client') return true;
  return RATE_LIMIT_EXEMPT_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(prefix));
}

function isMaintenanceBlocked(maintenance, method, pathname, privileged) {
  if (!maintenance?.enabled || privileged) return false;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false;
  if (pathname === '/sessions/revoke') return false;
  return true;
}

function formatPrometheusMetrics(api, state, production) {
  const world = api.getWorld();
  const overview = queryWorld(world, { type: 'world' });
  const audit = getApiAuditStats(world);
  const accounts = getAccountStats(world);
  const loop = getRuntimeLoopSummary(api.runtimeLoop);
  const lines = [
    '# HELP phyrex_up Whether the process is alive.',
    '# TYPE phyrex_up gauge',
    'phyrex_up 1',
    '# HELP phyrex_ready Whether the service is ready for traffic.',
    '# TYPE phyrex_ready gauge',
    `phyrex_ready ${getReadiness(api, state).ready ? 1 : 0}`,
    '# HELP phyrex_world_tick Current world tick.',
    '# TYPE phyrex_world_tick gauge',
    `phyrex_world_tick ${Number(world?.tick || 0)}`,
    '# HELP phyrex_world_entities Total entities.',
    '# TYPE phyrex_world_entities gauge',
    `phyrex_world_entities ${Number(overview?.totals?.entities || 0)}`,
    '# HELP phyrex_world_players Total players.',
    '# TYPE phyrex_world_players gauge',
    `phyrex_world_players ${Number(overview?.totals?.players || 0)}`,
    '# HELP phyrex_accounts_total Total accounts.',
    '# TYPE phyrex_accounts_total gauge',
    `phyrex_accounts_total ${Number(accounts.accounts || 0)}`,
    '# HELP phyrex_sessions_active Active sessions.',
    '# TYPE phyrex_sessions_active gauge',
    `phyrex_sessions_active ${Number(accounts.activeSessions || 0)}`,
    '# HELP phyrex_api_requests_total Audited API requests.',
    '# TYPE phyrex_api_requests_total counter',
    `phyrex_api_requests_total ${Number(audit.requests || 0)}`,
    '# HELP phyrex_api_errors_total Audited API errors.',
    '# TYPE phyrex_api_errors_total counter',
    `phyrex_api_errors_total ${Number(audit.errors || 0)}`,
    '# HELP phyrex_operational_requests_total Requests observed by the operational wrapper.',
    '# TYPE phyrex_operational_requests_total counter',
    `phyrex_operational_requests_total ${Number(state.requestCount || 0)}`,
    '# HELP phyrex_rate_limited_total Rate-limited requests.',
    '# TYPE phyrex_rate_limited_total counter',
    `phyrex_rate_limited_total ${Number(state.rateLimitedCount || 0)}`,
    '# HELP phyrex_maintenance_mode Maintenance mode flag.',
    '# TYPE phyrex_maintenance_mode gauge',
    `phyrex_maintenance_mode ${state.maintenance.enabled ? 1 : 0}`,
    '# HELP phyrex_runtime_loop_status Runtime loop state as labels.',
    '# TYPE phyrex_runtime_loop_status gauge',
    `phyrex_runtime_loop_status{status="${escapeMetricLabel(loop.status || 'unknown')}"} 1`,
    '# HELP phyrex_build_info Release information.',
    '# TYPE phyrex_build_info gauge',
    `phyrex_build_info{version="${escapeMetricLabel(production.releaseVersion || '0.1.0')}",sha="${escapeMetricLabel(production.releaseSha || 'unknown')}"} 1`,
  ];
  return `${lines.join('\n')}\n`;
}

function applyOperationalHeaders(req, res, pathname, production) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:");
  if (pathname === '/client' || pathname.startsWith('/client/')) res.setHeader('Cache-Control', 'public, max-age=300');
  else res.setHeader('Cache-Control', 'no-store');
  if (production.enabled) res.setHeader('X-Phyrex-Production', 'true');
}

function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  const allowed = Array.isArray(allowedOrigins) ? allowedOrigins : ['*'];
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (allowed.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return true;
  }
  if (!origin) return true;
  if (!allowed.includes(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', appendHeaderValue(res.getHeader('Vary'), 'Origin'));
  return true;
}

function requireOperator(auth) {
  if (!auth?.account) throw httpError(401, 'auth_required');
  if (!canRunWorldControl(auth.account)) throw httpError(403, 'world_control_forbidden');
  return auth;
}

function getRequestAuth(world, req, parsed) {
  const token = bearerToken(req) || parsed.searchParams.get('token') || null;
  return token ? validateSession(world, token) : null;
}

function bearerToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function clientAddress(req) {
  return String(req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown');
}

function readJsonBody(req, options = {}) {
  if (req.apiJsonBody !== undefined) return Promise.resolve(req.apiJsonBody);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const maximum = Number(options.maxBodyBytes || 1024 * 1024);
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maximum) {
        reject(httpError(413, 'request_body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_error) {
        reject(httpError(400, 'invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function finishHandled(req, res, api, started, statusCode, payload, options = {}) {
  const error = statusCode >= 400 ? payload?.error || `http_${statusCode}` : null;
  recordHandledAudit(req, api, normalizePath(new URL(req.url || '/', 'http://localhost').pathname), statusCode, Date.now() - started, error);
  if (options.text !== undefined) {
    res.statusCode = statusCode;
    res.end(options.text);
    return;
  }
  return writeJson(res, statusCode, payload);
}

function recordHandledAudit(req, api, pathname, statusCode, durationMs, error) {
  recordApiRequest(api.getWorld(), {
    id: req.apiRequestId,
    method: req.method,
    path: pathname,
    statusCode,
    durationMs,
    accountId: req.apiAccountId || null,
    error,
    userAgent: req.headers['user-agent'] || null,
  });
}

function writeJson(res, statusCode, payload) {
  const text = payload === null || payload === undefined ? '' : JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

function requiredBody(body, key) {
  const value = body?.[key];
  if (value === undefined || value === null || value === '') throw httpError(400, `missing_body_field:${key}`);
  return value;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizePath(value) {
  const normalized = String(value || '/').replace(/\/+/g, '/');
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized || '/';
}

function sanitizeFilePart(value) {
  return String(value || 'world').replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function escapeMetricLabel(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function appendHeaderValue(existing, value) {
  const values = String(existing || '').split(',').map(item => item.trim()).filter(Boolean);
  if (!values.includes(value)) values.push(value);
  return values.join(', ');
}

module.exports = {
  OPERATIONAL_PATHS,
  AUTH_PATHS,
  PERSISTENCE_PATHS,
  createOperationalWorldApiServer,
  handleOperationalRequest,
  ensureOperatorAccess,
  getReadiness,
  createRateLimiter,
  consumeRequestRate,
  isRateLimitExempt,
  isMaintenanceBlocked,
  formatPrometheusMetrics,
  applyOperationalHeaders,
  applyCors,
  restoreManagedWorld,
};
