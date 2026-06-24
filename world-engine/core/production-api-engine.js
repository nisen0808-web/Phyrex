'use strict';

const crypto = require('crypto');
const { URL } = require('url');
const {
  createWorldApiServer: createTemplateWorldApiServer,
} = require('./world-template-api-engine');
const {
  readJsonBody,
} = require('./api-server-engine');
const {
  ACCOUNT_STATUS,
  createAccount,
  getAccount,
  getAccountView,
  createSession,
  validateSession,
  sanitizeSession,
} = require('./account-session-engine');
const {
  canRunWorldControl,
  requireSession,
} = require('./api-permission-engine');
const {
  setAccountPassword,
  verifyAccountPassword,
  accountHasPassword,
} = require('./password-auth-engine');
const {
  recordApiRequest,
} = require('./api-audit-engine');
const {
  getRuntimeLoopSummary,
} = require('./runtime-loop-engine');
const {
  RELEASE_VERSION,
} = require('./production-config-engine');

const DEFAULT_PRODUCTION_API_OPTIONS = {
  requireAuth: true,
  allowRegistration: false,
  requirePasswords: true,
  sessionTtlTicks: 10000,
  corsOrigins: [],
  trustProxy: false,
  rateLimitWindowMs: 60000,
  rateLimitMax: 600,
  authRateLimitMax: 30,
  metricsPublic: false,
  securityHeaders: true,
  logger: null,
  admin: null,
};

const AUTH_PATHS = new Set(['/accounts', '/sessions']);
const PUBLIC_PROBE_PATHS = new Set(['/livez', '/readyz', '/version']);

function createProductionApiServer(worldInput = null, options = {}) {
  const opts = mergeOptions(DEFAULT_PRODUCTION_API_OPTIONS, options || {});
  const result = createTemplateWorldApiServer(worldInput, {
    ...opts,
    requireAuth: opts.requireAuth !== false,
  });

  const production = {
    releaseVersion: RELEASE_VERSION,
    startedAt: new Date().toISOString(),
    ready: false,
    shuttingDown: false,
    requests: 0,
    errors: 0,
    rateLimited: 0,
    authFailures: 0,
    requestBuckets: new Map(),
    authBuckets: new Map(),
  };
  result.api.production = production;
  result.api.productionOptions = opts;

  const bootstrap = bootstrapAdminAccount(result.api.getWorld(), opts.admin, opts);
  production.bootstrapAccountId = bootstrap?.id || null;

  wrapRequestHandling(result, opts, production);
  wrapWebSocketHandling(result, opts, production);
  production.ready = true;

  return {
    ...result,
    production,
    productionOptions: opts,
  };
}

function wrapRequestHandling(result, options, production) {
  const listeners = result.server.listeners('request');
  const baseRequestListener = listeners[0];
  if (typeof baseRequestListener !== 'function') throw new Error('production_api_requires_base_request_listener');

  result.server.removeListener('request', baseRequestListener);
  result.server.on('request', async (req, res) => {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    const parsed = new URL(req.url || '/', 'http://localhost');
    const pathname = normalizePath(parsed.pathname);
    const clientIp = requestClientIp(req, options);
    let handledByProduction = false;
    let productionError = null;

    installResponsePolicy(req, res, options, requestId);
    res.on('finish', () => {
      production.requests += 1;
      if (Number(res.statusCode || 200) >= 400) production.errors += 1;
      emitProductionLog(options, {
        level: Number(res.statusCode || 200) >= 500 ? 'error' : Number(res.statusCode || 200) >= 400 ? 'warn' : 'info',
        event: 'http_request',
        requestId,
        method: req.method || 'GET',
        path: pathname,
        statusCode: res.statusCode || 200,
        durationMs: Date.now() - started,
        clientIp,
        handledByProduction,
      });
    });

    try {
      const cors = authorizeOrigin(req, options);
      if (!cors.allowed) throw httpError(403, 'origin_forbidden');
      applyCorsHeaders(res, cors.origin);

      const rate = consumeRateLimit(req, pathname, options, production, clientIp);
      applyRateLimitHeaders(res, rate);
      if (!rate.allowed) {
        production.rateLimited += 1;
        throw httpError(429, 'rate_limit_exceeded');
      }

      if (req.method === 'GET' && pathname === '/livez') {
        handledByProduction = true;
        return writeJson(res, 200, liveStatus(result.api, production));
      }
      if (req.method === 'GET' && pathname === '/readyz') {
        handledByProduction = true;
        const status = readinessStatus(result.api, production, options);
        return writeJson(res, status.ok ? 200 : 503, status);
      }
      if (req.method === 'GET' && pathname === '/version') {
        handledByProduction = true;
        return writeJson(res, 200, {
          ok: true,
          service: 'world-engine',
          version: RELEASE_VERSION,
          environment: options.environment || 'production',
        });
      }
      if (req.method === 'GET' && pathname === '/metrics') {
        handledByProduction = true;
        if (!options.metricsPublic) requireWorldController(result.api.getWorld(), req, parsed);
        return writePrometheus(res, productionMetrics(result.api, production));
      }
      if (pathname === '/stream' && options.requireAuth !== false) {
        requireAuthenticatedRequest(result.api.getWorld(), req, parsed);
      }
      if (pathname === '/accounts') {
        handledByProduction = true;
        return await handleAccountRegistration(req, res, parsed, result.api, options);
      }
      if (pathname === '/sessions') {
        handledByProduction = true;
        return await handlePasswordSession(req, res, parsed, result.api, options, production);
      }

      return await baseRequestListener.call(result.server, req, res);
    } catch (error) {
      productionError = error;
      if (res.writableEnded) return undefined;
      if (Number(error.statusCode || 500) === 401) production.authFailures += 1;
      const statusCode = Number(error.statusCode || 500);
      if (handledByProduction || PUBLIC_PROBE_PATHS.has(pathname) || AUTH_PATHS.has(pathname) || pathname === '/metrics' || pathname === '/stream') {
        recordProductionAudit(result.api.getWorld(), req, pathname, statusCode, started, error);
      }
      return writeJson(res, statusCode, {
        ok: false,
        error: error.message || 'production_api_error',
        requestId,
      });
    } finally {
      if (productionError && !res.writableEnded) {
        emitProductionLog(options, {
          level: 'error',
          event: 'request_unfinished',
          requestId,
          path: pathname,
          error: productionError.message || String(productionError),
        });
      }
    }
  });
}

function wrapWebSocketHandling(result, options, production) {
  const listeners = result.server.listeners('upgrade');
  if (!listeners.length) return;
  result.server.removeAllListeners('upgrade');
  result.server.on('upgrade', (req, socket, head) => {
    const parsed = new URL(req.url || '/', 'http://localhost');
    const pathname = normalizePath(parsed.pathname);
    const started = Date.now();
    try {
      const cors = authorizeOrigin(req, options);
      if (!cors.allowed) throw httpError(403, 'origin_forbidden');
      const clientIp = requestClientIp(req, options);
      const rate = consumeRateLimit(req, pathname, options, production, clientIp);
      if (!rate.allowed) {
        production.rateLimited += 1;
        throw httpError(429, 'rate_limit_exceeded');
      }
      if (pathname === '/ws/ticks' && options.requireAuth !== false) {
        requireAuthenticatedRequest(result.api.getWorld(), req, parsed);
      }
      for (const listener of listeners) listener.call(result.server, req, socket, head);
    } catch (error) {
      const statusCode = Number(error.statusCode || 500);
      if (statusCode === 401) production.authFailures += 1;
      socket.write(`HTTP/1.1 ${statusCode} ${httpStatusText(statusCode)}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      recordApiRequest(result.api.getWorld(), {
        method: 'GET',
        path: pathname,
        statusCode,
        durationMs: Date.now() - started,
        error: error.message || 'websocket_rejected',
      });
    }
  });
}

async function handleAccountRegistration(req, res, parsed, api, options) {
  if (req.method === 'OPTIONS') return end(res, 204, '');
  if (req.method !== 'POST') throw httpError(405, 'method_not_allowed');

  const auth = requestAuth(api.getWorld(), req, parsed);
  const privileged = Boolean(auth?.account && canRunWorldControl(auth.account));
  if (!options.allowRegistration && !privileged) throw httpError(auth ? 403 : 401, auth ? 'registration_forbidden' : 'auth_required');

  const body = await readJsonBody(req, options);
  const input = body.account || body || {};
  const id = normalizeAccountId(input.id);
  if (getAccount(api.getWorld(), id)) throw httpError(409, 'account_already_exists');
  const password = body.password || input.password || null;
  if (options.requirePasswords && !password) throw httpError(400, 'password_required');

  const roles = privileged ? sanitizeRoles(input.roles) : ['player'];
  const account = createAccount(api.getWorld(), {
    ...input,
    id,
    name: String(input.name || id).slice(0, 100),
    roles,
    meta: { ...(input.meta || {}) },
    password: undefined,
  });
  if (password) {
    try {
      setAccountPassword(api.getWorld(), account.id, password, options.password || {});
    } catch (error) {
      delete api.getWorld().accounts.byId[account.id];
      throw httpError(400, error.code || error.message || 'invalid_password');
    }
  }

  api.broadcast({
    type: 'account.created',
    worldId: api.getWorld().id,
    tick: api.getWorld().tick,
    accountId: account.id,
  });
  recordProductionAudit(api.getWorld(), req, '/accounts', 201, Date.now(), null, account.id);
  return writeJson(res, 201, {
    ok: true,
    data: getAccountView(api.getWorld(), account.id),
  });
}

async function handlePasswordSession(req, res, parsed, api, options, production) {
  if (req.method === 'OPTIONS') return end(res, 204, '');
  if (req.method !== 'POST') throw httpError(405, 'method_not_allowed');
  const body = await readJsonBody(req, options);
  const accountId = String(body.accountId || '').trim();
  const password = body.password;
  const account = getAccount(api.getWorld(), accountId);
  const requiresPassword = options.requirePasswords || (account && accountHasPassword(api.getWorld(), accountId));

  if (!account || account.status !== ACCOUNT_STATUS.ACTIVE) {
    production.authFailures += 1;
    throw httpError(401, 'invalid_credentials');
  }
  if (requiresPassword && !verifyAccountPassword(api.getWorld(), accountId, password, options.password || {})) {
    production.authFailures += 1;
    throw httpError(401, 'invalid_credentials');
  }

  const requestedTtl = Number(body.options?.sessionTtlTicks || options.sessionTtlTicks);
  const ttl = Math.max(100, Math.min(Number(options.sessionTtlTicks || 10000), requestedTtl || Number(options.sessionTtlTicks || 10000)));
  const session = createSession(api.getWorld(), accountId, {
    ...(body.options || {}),
    sessionTtlTicks: ttl,
    token: undefined,
    meta: {
      ...(body.options?.meta || {}),
      source: 'production_password_login',
    },
  });
  req.apiAccountId = accountId;
  api.broadcast({
    type: 'session.created',
    worldId: api.getWorld().id,
    tick: api.getWorld().tick,
    accountId,
    sessionId: session.id,
  });
  recordProductionAudit(api.getWorld(), req, '/sessions', 201, Date.now(), null, accountId);
  return writeJson(res, 201, {
    ok: true,
    data: {
      token: session.token,
      session: sanitizeSession(session),
      account: getAccountView(api.getWorld(), accountId),
    },
  });
}

function bootstrapAdminAccount(world, admin, options = {}) {
  if (!admin || !admin.id) {
    if (options.requirePasswords) throw new Error('production_admin_configuration_required');
    return null;
  }
  const id = normalizeAccountId(admin.id);
  let account = getAccount(world, id);
  if (!account) {
    account = createAccount(world, {
      id,
      name: admin.name || 'World Administrator',
      roles: ['admin', 'gm'],
      meta: { bootstrap: true },
    });
  }
  account.status = ACCOUNT_STATUS.ACTIVE;
  account.roles = [...new Set([...(account.roles || []), 'admin', 'gm'])];
  account.name = admin.name || account.name || id;
  account.meta = { ...(account.meta || {}), bootstrap: true };
  if (admin.password) setAccountPassword(world, id, admin.password, options.password || {});
  if (options.requirePasswords && !accountHasPassword(world, id)) {
    throw new Error('production_admin_password_required');
  }
  return account;
}

function liveStatus(api, production) {
  return {
    ok: !production.shuttingDown,
    service: 'world-engine',
    version: RELEASE_VERSION,
    uptimeSeconds: Math.floor(process.uptime()),
    shuttingDown: production.shuttingDown,
    worldId: api.getWorld()?.id || null,
  };
}

function readinessStatus(api, production, options) {
  const world = api.getWorld();
  const reasons = [];
  if (!production.ready) reasons.push('not_initialized');
  if (production.shuttingDown) reasons.push('shutting_down');
  if (!world || !world.id) reasons.push('world_unavailable');
  if (options.requirePasswords && production.bootstrapAccountId && !accountHasPassword(world, production.bootstrapAccountId)) {
    reasons.push('admin_credentials_unavailable');
  }
  return {
    ok: reasons.length === 0,
    service: 'world-engine',
    version: RELEASE_VERSION,
    worldId: world?.id || null,
    tick: world?.tick ?? null,
    runtimeLoop: api.runtimeLoop ? getRuntimeLoopSummary(api.runtimeLoop) : null,
    reasons,
  };
}

function productionMetrics(api, production) {
  const world = api.getWorld();
  const loop = api.runtimeLoop ? getRuntimeLoopSummary(api.runtimeLoop) : {};
  const memory = process.memoryUsage();
  return {
    world_engine_up: production.ready && !production.shuttingDown ? 1 : 0,
    world_engine_uptime_seconds: Math.floor(process.uptime()),
    world_engine_world_tick: Number(world?.tick || 0),
    world_engine_players: Object.keys(world?.players?.byId || {}).length,
    world_engine_accounts: Object.keys(world?.accounts?.byId || {}).length,
    world_engine_streams: api.streams?.size || 0,
    world_engine_websockets: api.sockets?.size || 0,
    world_engine_http_requests_total: production.requests,
    world_engine_http_errors_total: production.errors,
    world_engine_rate_limited_total: production.rateLimited,
    world_engine_auth_failures_total: production.authFailures,
    world_engine_runtime_cycles_total: Number(loop.cycles || 0),
    world_engine_runtime_ticks_total: Number(loop.ticksRun || 0),
    world_engine_runtime_errors: Number(loop.errorCount || 0),
    process_resident_memory_bytes: Number(memory.rss || 0),
    process_heap_used_bytes: Number(memory.heapUsed || 0),
  };
}

function requireWorldController(world, req, parsed) {
  const auth = requireAuthenticatedRequest(world, req, parsed);
  if (!canRunWorldControl(auth.account)) throw httpError(403, 'world_control_forbidden');
  return auth;
}

function requireAuthenticatedRequest(world, req, parsed) {
  const auth = requestAuth(world, req, parsed);
  if (!auth) throw httpError(401, 'auth_required');
  return requireSession(auth);
}

function requestAuth(world, req, parsed) {
  const token = bearerToken(req) || parsed.searchParams.get('token') || null;
  return token ? validateSession(world, token) : null;
}

function consumeRateLimit(req, pathname, options, production, clientIp) {
  if (PUBLIC_PROBE_PATHS.has(pathname) || pathname.startsWith('/client/')) {
    return { allowed: true, limit: 0, remaining: 0, resetAt: 0, exempt: true };
  }
  const authPath = AUTH_PATHS.has(pathname);
  const store = authPath ? production.authBuckets : production.requestBuckets;
  const limit = Number(authPath ? options.authRateLimitMax : options.rateLimitMax);
  const windowMs = Number(options.rateLimitWindowMs || 60000);
  const now = Date.now();
  const key = `${clientIp}:${authPath ? 'auth' : 'general'}`;
  let bucket = store.get(key);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
  bucket.count += 1;
  store.set(key, bucket);
  if (store.size > 10000) pruneRateLimitStore(store, now);
  return {
    allowed: bucket.count <= limit,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt,
    exempt: false,
  };
}

function pruneRateLimitStore(store, now = Date.now()) {
  for (const [key, bucket] of store.entries()) {
    if (!bucket || bucket.resetAt <= now) store.delete(key);
  }
}

function installResponsePolicy(req, res, options, requestId) {
  const originalSetHeader = res.setHeader.bind(res);
  const originalWriteHead = res.writeHead.bind(res);
  let approvedOrigin = null;

  res.setApprovedCorsOrigin = origin => {
    approvedOrigin = origin || null;
    if (approvedOrigin) originalSetHeader('Access-Control-Allow-Origin', approvedOrigin);
  };
  res.setHeader = (name, value) => {
    if (String(name).toLowerCase() === 'access-control-allow-origin') {
      if (approvedOrigin) return originalSetHeader(name, approvedOrigin);
      return res;
    }
    return originalSetHeader(name, value);
  };
  res.writeHead = (statusCode, statusMessage, headers) => {
    let message = statusMessage;
    let headerValues = headers;
    if (message && typeof message === 'object') {
      headerValues = message;
      message = undefined;
    }
    if (headerValues && typeof headerValues === 'object') {
      headerValues = { ...headerValues };
      for (const key of Object.keys(headerValues)) {
        if (key.toLowerCase() === 'access-control-allow-origin') {
          if (approvedOrigin) headerValues[key] = approvedOrigin;
          else delete headerValues[key];
        }
      }
    }
    return message === undefined
      ? originalWriteHead(statusCode, headerValues)
      : originalWriteHead(statusCode, message, headerValues);
  };

  originalSetHeader('X-Request-Id', requestId);
  if (options.securityHeaders !== false) {
    originalSetHeader('X-Content-Type-Options', 'nosniff');
    originalSetHeader('X-Frame-Options', 'DENY');
    originalSetHeader('Referrer-Policy', 'no-referrer');
    originalSetHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    originalSetHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'");
  }
  if (!String(req.url || '').startsWith('/client/')) originalSetHeader('Cache-Control', 'no-store');
}

function authorizeOrigin(req, options) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return { allowed: true, origin: null };
  const allowed = Array.isArray(options.corsOrigins) ? options.corsOrigins : [];
  if (allowed.includes('*')) return { allowed: true, origin: '*' };
  if (allowed.includes(origin)) return { allowed: true, origin };
  return { allowed: false, origin: null };
}

function applyCorsHeaders(res, origin) {
  if (origin && typeof res.setApprovedCorsOrigin === 'function') res.setApprovedCorsOrigin(origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

function applyRateLimitHeaders(res, rate) {
  if (!rate || rate.exempt) return;
  res.setHeader('X-RateLimit-Limit', String(rate.limit));
  res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(rate.resetAt / 1000)));
  if (!rate.allowed) res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))));
}

function recordProductionAudit(world, req, pathname, statusCode, started, error, accountId = null) {
  recordApiRequest(world, {
    method: req.method || 'GET',
    path: pathname,
    statusCode,
    durationMs: Math.max(0, Date.now() - Number(started || Date.now())),
    accountId: accountId || req.apiAccountId || null,
    error: error?.message || null,
    userAgent: req.headers['user-agent'] || null,
  });
}

function emitProductionLog(options, entry) {
  if (options.logger === false) return;
  const payload = { at: new Date().toISOString(), service: 'world-engine', version: RELEASE_VERSION, ...entry };
  if (typeof options.logger === 'function') return options.logger(payload);
  console.log(JSON.stringify(payload));
}

function requestClientIp(req, options) {
  if (options.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || 'unknown';
}

function normalizeAccountId(value) {
  const id = String(value || '').trim();
  if (!id.match(/^[a-zA-Z0-9_.-]{3,64}$/)) throw httpError(400, 'invalid_account_id');
  return id;
}

function sanitizeRoles(value) {
  const allowed = new Set(['player', 'gm', 'admin']);
  const roles = [...new Set((Array.isArray(value) ? value : ['player']).map(item => String(item)).filter(item => allowed.has(item)))];
  return roles.length ? roles : ['player'];
}

function bearerToken(req) {
  const value = String(req.headers.authorization || '');
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function writeJson(res, statusCode, payload) {
  const text = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

function writePrometheus(res, metrics) {
  const text = Object.entries(metrics)
    .map(([name, value]) => `${name} ${Number(value || 0)}`)
    .join('\n') + '\n';
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

function end(res, statusCode, text) {
  res.statusCode = statusCode;
  res.end(text || '');
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function httpStatusText(statusCode) {
  const values = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error' };
  return values[statusCode] || 'Error';
}

function normalizePath(value) {
  return String(value || '/').replace(/\/+$/, '') || '/';
}

function mergeOptions(base, patch) {
  const output = { ...(base || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base?.[key] && typeof base[key] === 'object') {
      output[key] = mergeOptions(base[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

module.exports = {
  DEFAULT_PRODUCTION_API_OPTIONS,
  createProductionApiServer,
  bootstrapAdminAccount,
  liveStatus,
  readinessStatus,
  productionMetrics,
  authorizeOrigin,
  consumeRateLimit,
  requestClientIp,
  sanitizeRoles,
};
