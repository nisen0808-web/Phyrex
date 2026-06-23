'use strict';

const { URL } = require('url');
const {
  createWorldApiServer: createTemplateWorldApiServer,
} = require('./world-template-api-engine');
const { validateSession } = require('./account-session-engine');
const { canRunWorldControl } = require('./api-permission-engine');
const { recordApiRequest, getApiAuditStats } = require('./api-audit-engine');
const { getRuntimeLoopSummary } = require('./runtime-loop-engine');
const { getVersionInfo } = require('./version-engine');

const OPERATIONAL_PATHS = new Set([
  '/live',
  '/ready',
  '/version',
  '/metrics',
  '/admin/operations',
]);

const LOCKED_ONBOARDING_PATHS = new Set([
  '/accounts',
  '/sessions',
  '/sessions/revoke',
  '/players',
]);

function createOperationalApiServer(worldInput = null, options = {}) {
  const result = createTemplateWorldApiServer(worldInput, options);
  const operational = normalizeOperationalOptions(options.operational || {});
  const state = options.operationalState || {
    ready: false,
    shuttingDown: false,
    startedAt: null,
    storageReady: true,
    storageSource: null,
    recovered: false,
  };
  const version = getVersionInfo({
    service: operational.serviceName,
    buildSha: operational.buildSha,
    buildDate: operational.buildDate,
  });
  const limiter = createMemoryRateLimiter({
    limit: operational.rateLimitPerMinute,
    windowMs: 60000,
  });

  result.api.operationalState = state;
  result.api.versionInfo = version;
  result.api.rateLimiter = limiter;

  const requestListeners = result.server.listeners('request');
  const baseRequestListener = requestListeners[0];
  if (typeof baseRequestListener !== 'function') {
    throw new Error('Operational API requires the base request listener');
  }
  result.server.removeAllListeners('request');
  result.server.on('request', (req, res) => {
    handleOperationalRequest(
      req,
      res,
      result.api,
      result.options,
      operational,
      state,
      version,
      limiter,
      baseRequestListener,
      result.server,
    ).catch(error => {
      if (!res.writableEnded) writeJson(res, error.statusCode || 500, {
        ok: false,
        error: error.message || 'operational_api_error',
      });
    });
  });

  const upgradeListeners = result.server.listeners('upgrade');
  const baseUpgradeListener = upgradeListeners[0];
  if (typeof baseUpgradeListener === 'function') {
    result.server.removeAllListeners('upgrade');
    result.server.on('upgrade', (req, socket, head) => {
      handleOperationalUpgrade(
        req,
        socket,
        head,
        result.api,
        result.options,
        operational,
        limiter,
        baseUpgradeListener,
        result.server,
      );
    });
  }

  return {
    ...result,
    operational,
    operationalState: state,
    versionInfo: version,
  };
}

async function handleOperationalRequest(
  req,
  res,
  api,
  baseOptions,
  operational,
  state,
  version,
  limiter,
  baseRequestListener,
  server,
) {
  const started = Date.now();
  const parsed = new URL(req.url || '/', 'http://localhost');
  const pathname = normalizePath(parsed.pathname);
  const method = req.method || 'GET';
  const origin = String(req.headers.origin || '').trim();
  const allowedOrigin = resolveAllowedOrigin(req, operational.corsOrigins);
  installCorsGuard(res, allowedOrigin);
  applySecurityHeaders(res);

  if (origin && !allowedOrigin) {
    return rejectOperationalRequest(api, req, res, started, pathname, 403, 'origin_forbidden');
  }

  if (!isRateLimitExempt(method, pathname)) {
    const rate = limiter.consume(clientKey(req, operational.trustProxy));
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))));
      return rejectOperationalRequest(api, req, res, started, pathname, 429, 'rate_limit_exceeded');
    }
    res.setHeader('X-RateLimit-Limit', String(rate.limit));
    res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
  }

  if (OPERATIONAL_PATHS.has(pathname)) {
    return handleOwnedOperationalPath(
      req,
      res,
      parsed,
      pathname,
      api,
      baseOptions,
      operational,
      state,
      version,
      started,
    );
  }

  if (baseOptions.requireAuth && pathname === '/stream') {
    const auth = authenticateRequest(api.getWorld(), req, parsed);
    if (!auth) return rejectOperationalRequest(api, req, res, started, pathname, 401, 'invalid_session');
    req.apiAccountId = auth.account.id;
  }

  if (
    baseOptions.requireAuth
    && operational.lockOnboarding
    && method === 'POST'
    && LOCKED_ONBOARDING_PATHS.has(pathname)
  ) {
    const auth = authenticateRequest(api.getWorld(), req, parsed);
    if (!auth) return rejectOperationalRequest(api, req, res, started, pathname, 401, 'invalid_session');
    if (!canRunWorldControl(auth.account)) {
      return rejectOperationalRequest(api, req, res, started, pathname, 403, 'world_control_forbidden');
    }
    req.apiAccountId = auth.account.id;
  }

  return baseRequestListener.call(server, req, res);
}

function handleOwnedOperationalPath(
  req,
  res,
  parsed,
  pathname,
  api,
  baseOptions,
  operational,
  state,
  version,
  started,
) {
  const method = req.method || 'GET';
  let statusCode = 200;
  let errorMessage = null;
  try {
    if (method !== 'GET') throw httpError(405, 'method_not_allowed');

    if (pathname === '/live') {
      return writeJson(res, 200, {
        ok: true,
        service: version.service,
        version: version.version,
        uptimeSeconds: Math.floor(process.uptime()),
      });
    }

    if (pathname === '/ready') {
      const world = api.getWorld();
      const ready = Boolean(state.ready && !state.shuttingDown && state.storageReady !== false && world);
      statusCode = ready ? 200 : 503;
      return writeJson(res, statusCode, {
        ok: ready,
        service: version.service,
        version: version.version,
        worldId: world?.id || null,
        tick: world?.tick ?? null,
        authRequired: Boolean(baseOptions.requireAuth),
        storageSource: state.storageSource || null,
        recovered: Boolean(state.recovered),
        runtimeLoop: api.runtimeLoop ? getRuntimeLoopSummary(api.runtimeLoop) : null,
      });
    }

    if (pathname === '/version') {
      return writeJson(res, 200, { ok: true, data: version });
    }

    if (pathname === '/metrics') {
      if (operational.metricsRequireAuth && baseOptions.requireAuth) {
        requireWorldControlRequest(api.getWorld(), req, parsed);
      }
      const text = renderPrometheusMetrics(api, state, version);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(text));
      res.end(text);
      return;
    }

    if (pathname === '/admin/operations') {
      if (baseOptions.requireAuth) requireWorldControlRequest(api.getWorld(), req, parsed);
      return writeJson(res, 200, {
        ok: true,
        data: {
          version,
          state: {
            ready: Boolean(state.ready),
            shuttingDown: Boolean(state.shuttingDown),
            startedAt: state.startedAt || null,
            storageReady: state.storageReady !== false,
            storageSource: state.storageSource || null,
            recovered: Boolean(state.recovered),
          },
          security: {
            authRequired: Boolean(baseOptions.requireAuth),
            onboardingLocked: Boolean(operational.lockOnboarding),
            metricsRequireAuth: Boolean(operational.metricsRequireAuth),
            corsOrigins: [...operational.corsOrigins],
            rateLimitPerMinute: operational.rateLimitPerMinute,
          },
          runtimeLoop: api.runtimeLoop ? getRuntimeLoopSummary(api.runtimeLoop) : null,
        },
      });
    }

    throw httpError(404, 'not_found');
  } catch (error) {
    statusCode = error.statusCode || 500;
    errorMessage = error.message || 'operational_api_error';
    return writeJson(res, statusCode, { ok: false, error: errorMessage });
  } finally {
    recordApiRequest(api.getWorld(), {
      method,
      path: pathname,
      statusCode: res.statusCode || statusCode,
      durationMs: Date.now() - started,
      accountId: req.apiAccountId || null,
      route: pathname,
      error: errorMessage,
      userAgent: req.headers['user-agent'] || null,
    });
  }
}

function handleOperationalUpgrade(
  req,
  socket,
  head,
  api,
  baseOptions,
  operational,
  limiter,
  baseUpgradeListener,
  server,
) {
  const parsed = new URL(req.url || '/', 'http://localhost');
  const pathname = normalizePath(parsed.pathname);
  const origin = String(req.headers.origin || '').trim();
  if (origin && !resolveAllowedOrigin(req, operational.corsOrigins)) {
    return endSocket(socket, 403, 'Forbidden');
  }

  const rate = limiter.consume(clientKey(req, operational.trustProxy));
  if (!rate.allowed) return endSocket(socket, 429, 'Too Many Requests', { 'Retry-After': Math.max(1, Math.ceil(rate.retryAfterMs / 1000)) });

  if (pathname === '/ws/ticks' && baseOptions.requireAuth) {
    const auth = authenticateRequest(api.getWorld(), req, parsed);
    if (!auth) return endSocket(socket, 401, 'Unauthorized');
    req.apiAccountId = auth.account.id;
  }

  return baseUpgradeListener.call(server, req, socket, head);
}

function requireWorldControlRequest(world, req, parsed) {
  const auth = authenticateRequest(world, req, parsed);
  if (!auth) throw httpError(401, 'invalid_session');
  if (!canRunWorldControl(auth.account)) throw httpError(403, 'world_control_forbidden');
  req.apiAccountId = auth.account.id;
  return auth;
}

function authenticateRequest(world, req, parsed) {
  const token = bearerToken(req) || parsed.searchParams.get('token') || null;
  return token ? validateSession(world, token) : null;
}

function rejectOperationalRequest(api, req, res, started, pathname, statusCode, error) {
  writeJson(res, statusCode, { ok: false, error });
  recordApiRequest(api.getWorld(), {
    method: req.method || 'GET',
    path: pathname,
    statusCode,
    durationMs: Date.now() - started,
    accountId: req.apiAccountId || null,
    error,
    userAgent: req.headers['user-agent'] || null,
  });
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
}

function installCorsGuard(res, allowedOrigin) {
  const originalSetHeader = res.setHeader.bind(res);
  res.setHeader = function guardedSetHeader(name, value) {
    const lower = String(name).toLowerCase();
    if (lower === 'access-control-allow-origin') {
      if (!allowedOrigin) return res;
      return originalSetHeader(name, allowedOrigin);
    }
    return originalSetHeader(name, value);
  };
  if (allowedOrigin) {
    originalSetHeader('Access-Control-Allow-Origin', allowedOrigin);
    if (allowedOrigin !== '*') originalSetHeader('Vary', 'Origin');
  }
}

function resolveAllowedOrigin(req, configuredOrigins = []) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return null;
  const origins = Array.isArray(configuredOrigins) ? configuredOrigins : [];
  if (origins.includes('*')) return '*';
  if (origins.includes(origin)) return origin;
  if (origins.includes('same-origin')) {
    try {
      const parsed = new URL(origin);
      if (parsed.host === String(req.headers.host || '')) return origin;
    } catch (_error) {
      return null;
    }
  }
  return null;
}

function renderPrometheusMetrics(api, state, version) {
  const world = api.getWorld();
  const audit = getApiAuditStats(world);
  const loop = api.runtimeLoop ? getRuntimeLoopSummary(api.runtimeLoop) : {};
  const status = loop.status || 'unknown';
  const lines = [
    '# HELP phyrex_build_info Release and build metadata.',
    '# TYPE phyrex_build_info gauge',
    `phyrex_build_info{version="${metricLabel(version.version)}",build_sha="${metricLabel(version.buildSha || '')}"} 1`,
    '# HELP phyrex_ready Whether the service is ready to accept traffic.',
    '# TYPE phyrex_ready gauge',
    `phyrex_ready ${state.ready && !state.shuttingDown ? 1 : 0}`,
    '# HELP phyrex_world_tick Current simulation tick.',
    '# TYPE phyrex_world_tick gauge',
    `phyrex_world_tick ${Number(world?.tick || 0)}`,
    '# HELP phyrex_world_players Current player count.',
    '# TYPE phyrex_world_players gauge',
    `phyrex_world_players ${Object.keys(world?.players?.byId || {}).length}`,
    '# HELP phyrex_world_entities Current entity count.',
    '# TYPE phyrex_world_entities gauge',
    `phyrex_world_entities ${Object.keys(world?.entities || {}).length}`,
    '# HELP phyrex_accounts Current account count.',
    '# TYPE phyrex_accounts gauge',
    `phyrex_accounts ${Object.keys(world?.accounts?.byId || {}).length}`,
    '# HELP phyrex_connections Current live connections.',
    '# TYPE phyrex_connections gauge',
    `phyrex_connections{protocol="sse"} ${api.streams?.size || 0}`,
    `phyrex_connections{protocol="websocket"} ${api.sockets?.size || 0}`,
    '# HELP phyrex_api_requests_total Audited API requests.',
    '# TYPE phyrex_api_requests_total counter',
    `phyrex_api_requests_total ${Number(audit.requests || 0)}`,
    '# HELP phyrex_api_errors_total Audited API errors.',
    '# TYPE phyrex_api_errors_total counter',
    `phyrex_api_errors_total ${Number(audit.errors || 0)}`,
    '# HELP phyrex_runtime_loop_state Current runtime-loop state.',
    '# TYPE phyrex_runtime_loop_state gauge',
    `phyrex_runtime_loop_state{state="running"} ${status === 'running' ? 1 : 0}`,
    `phyrex_runtime_loop_state{state="paused"} ${status === 'paused' ? 1 : 0}`,
    `phyrex_runtime_loop_state{state="stopped"} ${status === 'stopped' ? 1 : 0}`,
    '# HELP phyrex_runtime_loop_errors Current retained runtime-loop errors.',
    '# TYPE phyrex_runtime_loop_errors gauge',
    `phyrex_runtime_loop_errors ${Number(loop.errorCount || 0)}`,
    '',
  ];
  return lines.join('\n');
}

function normalizeOperationalOptions(input = {}) {
  return {
    serviceName: input.serviceName || 'phyrex-world-engine',
    lockOnboarding: input.lockOnboarding !== false,
    corsOrigins: Array.isArray(input.corsOrigins) ? input.corsOrigins : ['same-origin'],
    rateLimitPerMinute: Math.max(0, Number(input.rateLimitPerMinute ?? 600)),
    metricsRequireAuth: input.metricsRequireAuth !== false,
    trustProxy: Boolean(input.trustProxy),
    buildSha: input.buildSha || null,
    buildDate: input.buildDate || null,
  };
}

function createMemoryRateLimiter(options = {}) {
  const limit = Math.max(0, Number(options.limit || 0));
  const windowMs = Math.max(1000, Number(options.windowMs || 60000));
  const clock = options.clock || Date.now;
  const entries = new Map();
  return {
    limit,
    windowMs,
    consume(key) {
      if (!limit) return { allowed: true, limit: 0, remaining: 0, retryAfterMs: 0 };
      const now = Number(clock());
      const id = String(key || 'unknown');
      let entry = entries.get(id);
      if (!entry || now >= entry.resetAt) {
        entry = { count: 0, resetAt: now + windowMs };
        entries.set(id, entry);
      }
      entry.count += 1;
      return {
        allowed: entry.count <= limit,
        limit,
        remaining: Math.max(0, limit - entry.count),
        retryAfterMs: Math.max(0, entry.resetAt - now),
      };
    },
    reset() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}

function isRateLimitExempt(method, pathname) {
  if (method !== 'GET') return false;
  return pathname === '/health'
    || pathname === '/live'
    || pathname === '/ready'
    || pathname === '/version'
    || pathname === '/client'
    || pathname.startsWith('/client/');
}

function clientKey(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || 'unknown';
}

function bearerToken(req) {
  const value = String(req.headers.authorization || '');
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function metricLabel(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function normalizePath(value) {
  const text = String(value || '/').replace(/\/+$/g, '');
  return text || '/';
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function writeJson(res, statusCode, payload) {
  const text = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

function endSocket(socket, statusCode, message, headers = {}) {
  const reason = message || 'Error';
  const lines = [`HTTP/1.1 ${statusCode} ${reason}`];
  for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
  lines.push('Connection: close', '', '');
  try { socket.write(lines.join('\r\n')); } catch (_error) {}
  socket.destroy();
}

module.exports = {
  OPERATIONAL_PATHS,
  LOCKED_ONBOARDING_PATHS,
  createOperationalApiServer,
  handleOperationalRequest,
  handleOperationalUpgrade,
  applySecurityHeaders,
  resolveAllowedOrigin,
  renderPrometheusMetrics,
  normalizeOperationalOptions,
  createMemoryRateLimiter,
  isRateLimitExempt,
  clientKey,
};
