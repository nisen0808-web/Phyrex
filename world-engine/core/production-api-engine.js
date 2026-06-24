'use strict';

const fs = require('fs');
const { URL } = require('url');
const { createWorldApiServer: createTemplateWorldApiServer } = require('./world-template-api-engine');
const {
  createAccount,
  createSession,
  validateSession,
  revokeSession,
  getAccount,
  getAccountView,
  getAccountStats,
  sanitizeSession,
} = require('./account-session-engine');
const { canRunWorldControl, requirePermission, requireSession } = require('./api-permission-engine');
const {
  createCredentialRecord,
  verifyAccountSecret,
  hasAccountSecret,
  credentialSummary,
  validateAccountSecret,
} = require('./credential-engine');
const { configurePersistenceSecurity, getPersistenceSecurity } = require('./persistence-engine');
const { recordApiRequest } = require('./api-audit-engine');

const DIRECT_PATHS = new Set([
  '/ready',
  '/health/ready',
  '/accounts',
  '/sessions',
  '/admin/accounts',
  '/admin/security',
]);

function createProductionApiServer(worldInput, options = {}) {
  const config = normalizeProductionApiOptions(options);
  configurePersistenceSecurity({ allowedRoots: [config.dataDir], enforce: true });

  const result = createTemplateWorldApiServer(worldInput, {
    ...options,
    requireAuth: true,
    maxBodyBytes: config.maxBodyBytes,
  });
  const baseRequestListener = result.server.listeners('request')[0];
  if (typeof baseRequestListener !== 'function') throw new Error('production_api_missing_request_listener');
  result.server.removeListener('request', baseRequestListener);

  const limiter = createRateLimiter(config.rateLimit);
  result.server.on('request', (req, res) => {
    installProductionHeaders(req, res, config);
    const parsed = new URL(req.url || '/', 'http://localhost');
    const pathname = normalizePath(parsed.pathname);

    if (!originAllowed(req, config)) {
      auditImmediate(result.api, req, pathname, 403, 'origin_forbidden');
      return writeJson(res, 403, { ok: false, error: 'origin_forbidden' });
    }
    if (req.method === 'OPTIONS') return handlePreflight(req, res, config);
    if (parsed.searchParams.has('token') && pathname !== '/stream') {
      auditImmediate(result.api, req, pathname, 400, 'query_token_forbidden');
      return writeJson(res, 400, { ok: false, error: 'query_token_forbidden' });
    }

    const rate = limiter.consume(rateLimitBucket(pathname), requestIp(req, config), Date.now());
    applyRateHeaders(res, rate);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))));
      auditImmediate(result.api, req, pathname, 429, 'rate_limit_exceeded');
      return writeJson(res, 429, { ok: false, error: 'rate_limit_exceeded' });
    }

    if (pathname === '/stream') {
      const auth = requestAuth(result.api.getWorld(), req, parsed, true);
      if (!auth) {
        auditImmediate(result.api, req, pathname, 401, 'auth_required');
        return writeJson(res, 401, { ok: false, error: 'auth_required' });
      }
      req.apiAccountId = auth.account.id;
      parsed.searchParams.delete('token');
      req.url = parsed.pathname + (parsed.searchParams.toString() ? `?${parsed.searchParams}` : '');
      return baseRequestListener.call(result.server, req, res);
    }

    if (isDirectProductionPath(pathname)) {
      handleDirectProductionRequest(req, res, parsed, pathname, result.api, config).catch(error => {
        if (!res.headersSent) writeJson(res, error.statusCode || 500, { ok: false, error: error.message || 'production_api_error' });
        else res.destroy(error);
      });
      return;
    }

    if (pathname === '/saves' && !parsed.searchParams.get('dir')) {
      parsed.searchParams.set('dir', config.dataDir);
      req.url = `${parsed.pathname}?${parsed.searchParams.toString()}`;
    }
    return baseRequestListener.call(result.server, req, res);
  });

  const baseUpgradeListener = result.server.listeners('upgrade')[0];
  if (typeof baseUpgradeListener === 'function') {
    result.server.removeListener('upgrade', baseUpgradeListener);
    result.server.on('upgrade', (req, socket, head) => {
      const parsed = new URL(req.url || '/', 'http://localhost');
      if (!originAllowed(req, config)) return rejectUpgrade(socket, 403, 'origin_forbidden');
      if (normalizePath(parsed.pathname) === '/ws/ticks') {
        const auth = requestAuth(result.api.getWorld(), req, parsed, true);
        if (!auth) return rejectUpgrade(socket, 401, 'auth_required');
        req.apiAccountId = auth.account.id;
        parsed.searchParams.delete('token');
        req.url = parsed.pathname + (parsed.searchParams.toString() ? `?${parsed.searchParams}` : '');
      }
      return baseUpgradeListener.call(result.server, req, socket, head);
    });
  }

  result.api.production = {
    config: productionSummary(config),
    rateLimiter: limiter,
    startedAt: new Date().toISOString(),
  };
  return { ...result, production: result.api.production };
}

async function handleDirectProductionRequest(req, res, parsed, pathname, api, config) {
  const started = Date.now();
  const method = req.method || 'GET';
  let auth = null;
  let errorMessage = null;
  try {
    auth = requestAuth(api.getWorld(), req, parsed, false);
    req.apiAccountId = auth?.account?.id || null;

    if (method === 'GET' && (pathname === '/ready' || pathname === '/health/ready')) {
      const readiness = productionReadiness(api, config);
      return writeJson(res, readiness.ready ? 200 : 503, readiness);
    }
    if (method === 'POST' && pathname === '/accounts') {
      const body = await readJsonBody(req, config);
      return await registerAccount(res, api, config, auth, body, false);
    }
    if (method === 'POST' && pathname === '/sessions') {
      const body = await readJsonBody(req, config);
      return await loginAccount(res, api, config, body);
    }
    if (method === 'GET' && pathname === '/admin/accounts') {
      requireWorldControl(auth);
      const accounts = Object.keys(api.getWorld().accounts?.byId || {}).sort().map(accountId => ({
        ...getAccountView(api.getWorld(), accountId),
        credential: credentialSummary(getAccount(api.getWorld(), accountId)),
      }));
      return writeJson(res, 200, ok({ accounts, stats: getAccountStats(api.getWorld()) }));
    }
    if (method === 'POST' && pathname === '/admin/accounts') {
      requireWorldControl(auth);
      const body = await readJsonBody(req, config);
      return await registerAccount(res, api, config, auth, body, true);
    }

    const secretMatch = pathname.match(/^\/admin\/accounts\/([^/]+)\/secret$/);
    if (method === 'POST' && secretMatch) {
      requireWorldControl(auth);
      const accountId = decodeURIComponent(secretMatch[1]);
      const account = getAccount(api.getWorld(), accountId);
      if (!account) throw httpError(404, 'missing_account');
      const body = await readJsonBody(req, config);
      validateAccountSecret(body.secret, config.credentialOptions);
      account.meta = { ...(account.meta || {}), auth: await createCredentialRecord(body.secret, config.credentialOptions) };
      const revoked = body.revokeSessions === false ? 0 : revokeAccountSessions(api.getWorld(), accountId, 'credential_rotated');
      return writeJson(res, 200, ok({
        account: getAccountView(api.getWorld(), accountId),
        credential: credentialSummary(account),
        revokedSessions: revoked,
      }));
    }

    if (method === 'GET' && pathname === '/admin/security') {
      requireWorldControl(auth);
      return writeJson(res, 200, ok(productionSecuritySummary(api, config)));
    }
    return writeJson(res, 405, { ok: false, error: 'method_not_allowed', path: pathname });
  } catch (error) {
    errorMessage = error.message || 'production_api_error';
    return writeJson(res, error.statusCode || 500, { ok: false, error: errorMessage });
  } finally {
    recordApiRequest(api.getWorld(), {
      method,
      path: pathname,
      statusCode: res.statusCode || 200,
      durationMs: Date.now() - started,
      accountId: req.apiAccountId || auth?.account?.id || null,
      route: pathname,
      error: errorMessage,
      userAgent: req.headers['user-agent'] || null,
    });
  }
}

async function registerAccount(res, api, config, auth, body, adminRoute) {
  const policy = adminRoute ? 'admin' : config.registrationPolicy;
  if (policy === 'disabled') throw httpError(403, 'registration_disabled');
  if (policy === 'admin') requireWorldControl(auth);

  const accountInput = body.account || body || {};
  const id = validateAccountId(accountInput.id);
  if (getAccount(api.getWorld(), id)) throw httpError(409, 'account_exists');
  const secret = body.secret || accountInput.secret;
  validateAccountSecret(secret, config.credentialOptions);
  const authRecord = await createCredentialRecord(secret, config.credentialOptions);
  const roles = policy === 'open' ? ['player'] : normalizeRoles(accountInput.roles || body.roles);
  const account = createAccount(api.getWorld(), {
    id,
    name: validateAccountName(accountInput.name || id),
    roles,
    meta: { auth: authRecord },
  });
  return writeJson(res, 201, ok({
    account: getAccountView(api.getWorld(), account.id),
    credential: credentialSummary(account),
  }));
}

async function loginAccount(res, api, config, body) {
  const accountId = String(body.accountId || '').trim();
  const account = getAccount(api.getWorld(), accountId);
  const valid = account && hasAccountSecret(account)
    && await verifyAccountSecret(account, body.secret, config.credentialOptions);
  if (!valid) throw httpError(401, 'invalid_credentials');
  const session = createSession(api.getWorld(), accountId, {
    sessionTtlTicks: config.sessionTtlTicks,
    maxSessionsPerAccount: config.maxSessionsPerAccount,
    meta: { source: 'production_login' },
  });
  res.setHeader('Cache-Control', 'no-store');
  return writeJson(res, 201, ok({
    token: session.token,
    session: sanitizeSession(session),
    account: getAccountView(api.getWorld(), accountId),
  }));
}

function productionReadiness(api, config) {
  let storageReady = true;
  let storageError = null;
  try {
    fs.accessSync(config.dataDir, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    storageReady = false;
    storageError = error.code || error.message;
  }
  const accounts = Object.values(api.getWorld().accounts?.byId || {});
  const privilegedCredential = accounts.some(account => canRunWorldControl(account) && hasAccountSecret(account));
  const ready = Boolean(api.getWorld()?.id && storageReady && privilegedCredential);
  return {
    ok: ready,
    ready,
    service: config.serviceName,
    version: config.version,
    registrationPolicy: config.registrationPolicy,
    credentialsRequired: true,
    worldId: api.getWorld()?.id || null,
    tick: api.getWorld()?.tick ?? null,
    storage: { ready: storageReady, error: storageError },
    auth: { privilegedCredential },
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

function productionSecuritySummary(api, config) {
  const accounts = Object.values(api.getWorld().accounts?.byId || {});
  return {
    service: config.serviceName,
    version: config.version,
    registrationPolicy: config.registrationPolicy,
    requireAuth: true,
    requireCredentials: true,
    corsOrigins: [...config.corsOrigins],
    rateLimit: { ...config.rateLimit },
    persistence: getPersistenceSecurity(),
    credentials: {
      configured: accounts.filter(hasAccountSecret).length,
      privilegedConfigured: accounts.filter(account => canRunWorldControl(account) && hasAccountSecret(account)).length,
      accounts: accounts.length,
    },
  };
}

function normalizeProductionApiOptions(options = {}) {
  return {
    serviceName: String(options.serviceName || 'phyrex-world-engine'),
    version: String(options.version || '1.0.0'),
    dataDir: String(options.dataDir || process.cwd()),
    maxBodyBytes: Math.max(1024, Number(options.maxBodyBytes || 256 * 1024)),
    registrationPolicy: ['disabled', 'admin', 'open'].includes(options.registrationPolicy) ? options.registrationPolicy : 'admin',
    sessionTtlTicks: Math.max(1, Number(options.sessionTtlTicks || 100000)),
    maxSessionsPerAccount: Math.max(1, Number(options.maxSessionsPerAccount || 10)),
    corsOrigins: Array.isArray(options.corsOrigins) ? options.corsOrigins.filter(origin => origin && origin !== '*') : [],
    trustProxy: Boolean(options.trustProxy),
    rateLimit: {
      windowMs: Math.max(1000, Number(options.rateLimit?.windowMs || 60000)),
      generalMax: Math.max(1, Number(options.rateLimit?.generalMax || 600)),
      authMax: Math.max(1, Number(options.rateLimit?.authMax || 20)),
      registrationMax: Math.max(1, Number(options.rateLimit?.registrationMax || 5)),
    },
    credentialOptions: { ...(options.credentialOptions || {}) },
  };
}

function productionSummary(config) {
  return {
    serviceName: config.serviceName,
    version: config.version,
    dataDir: config.dataDir,
    registrationPolicy: config.registrationPolicy,
    corsOrigins: [...config.corsOrigins],
    rateLimit: { ...config.rateLimit },
  };
}

function installProductionHeaders(req, res, config) {
  const allowedOrigin = requestAllowedOrigin(req, config);
  const nativeSetHeader = res.setHeader.bind(res);
  const nativeWriteHead = res.writeHead.bind(res);
  res.setHeader = (name, value) => {
    const lower = String(name).toLowerCase();
    if (lower === 'access-control-allow-origin') {
      if (allowedOrigin) nativeSetHeader(name, allowedOrigin);
      return res;
    }
    if (lower === 'access-control-allow-credentials') {
      if (allowedOrigin) nativeSetHeader(name, 'true');
      return res;
    }
    return nativeSetHeader(name, value);
  };
  res.writeHead = (statusCode, reasonOrHeaders, possibleHeaders) => {
    if (typeof reasonOrHeaders === 'string') {
      return nativeWriteHead(statusCode, reasonOrHeaders, sanitizeCorsHeaders(possibleHeaders, allowedOrigin));
    }
    return nativeWriteHead(statusCode, sanitizeCorsHeaders(reasonOrHeaders, allowedOrigin));
  };
  nativeSetHeader('X-Content-Type-Options', 'nosniff');
  nativeSetHeader('X-Frame-Options', 'DENY');
  nativeSetHeader('Referrer-Policy', 'no-referrer');
  nativeSetHeader('Cross-Origin-Opener-Policy', 'same-origin');
  nativeSetHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  nativeSetHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (allowedOrigin) {
    nativeSetHeader('Access-Control-Allow-Origin', allowedOrigin);
    nativeSetHeader('Access-Control-Allow-Credentials', 'true');
    nativeSetHeader('Vary', 'Origin');
  }
}

function sanitizeCorsHeaders(headers, allowedOrigin) {
  const output = { ...(headers || {}) };
  for (const key of Object.keys(output)) {
    const lower = key.toLowerCase();
    if (lower === 'access-control-allow-origin' || lower === 'access-control-allow-credentials') delete output[key];
  }
  if (allowedOrigin) {
    output['Access-Control-Allow-Origin'] = allowedOrigin;
    output['Access-Control-Allow-Credentials'] = 'true';
  }
  return output;
}

function handlePreflight(req, res, config) {
  const origin = requestAllowedOrigin(req, config);
  if (req.headers.origin && !origin) return writeJson(res, 403, { ok: false, error: 'origin_forbidden' });
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  res.statusCode = 204;
  res.end('');
}

function originAllowed(req, config) {
  return !req.headers.origin || Boolean(requestAllowedOrigin(req, config));
}

function requestAllowedOrigin(req, config) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return null;
  const protocol = config.trustProxy
    ? String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
    : (req.socket?.encrypted ? 'https' : 'http');
  const host = config.trustProxy
    ? String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
    : String(req.headers.host || '').trim();
  const sameOrigin = host ? `${protocol}://${host}` : null;
  return origin === sameOrigin || config.corsOrigins.includes(origin) ? origin : null;
}

function requestAuth(world, req, parsed, allowQuery) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() || (allowQuery ? parsed.searchParams.get('token') : null);
  return token ? validateSession(world, token) : null;
}

function requireWorldControl(auth) {
  const sessionAuth = requireSession(auth);
  requirePermission(canRunWorldControl(sessionAuth.account), 'world_control_forbidden');
  return sessionAuth;
}

function revokeAccountSessions(world, accountId, reason) {
  const sessions = Object.values(world.accounts?.sessions || {}).filter(session => session.accountId === accountId && session.status === 'active');
  for (const session of sessions) revokeSession(world, session.id, reason);
  return sessions.length;
}

function normalizeRoles(value) {
  const allowed = new Set(['player', 'gm', 'admin']);
  const roles = [...new Set((Array.isArray(value) ? value : ['player'])
    .map(role => String(role || '').toLowerCase())
    .filter(role => allowed.has(role)))];
  return roles.length ? roles : ['player'];
}

function validateAccountId(value) {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(id)) throw httpError(400, 'invalid_account_id');
  return id;
}

function validateAccountName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 120) throw httpError(400, 'invalid_account_name');
  return name;
}

function isDirectProductionPath(pathname) {
  return DIRECT_PATHS.has(pathname) || /^\/admin\/accounts\/[^/]+\/secret$/.test(pathname);
}

function rateLimitBucket(pathname) {
  if (pathname === '/sessions') return 'auth';
  if (pathname === '/accounts') return 'registration';
  return 'general';
}

function createRateLimiter(options) {
  const entries = new Map();
  return {
    consume(bucket, key, now) {
      const limit = bucket === 'auth' ? options.authMax : bucket === 'registration' ? options.registrationMax : options.generalMax;
      const id = `${bucket}:${key}`;
      let entry = entries.get(id);
      if (!entry || now >= entry.resetAt) entry = { count: 0, resetAt: now + options.windowMs };
      entry.count += 1;
      entries.set(id, entry);
      if (entries.size > 10000) for (const [entryId, current] of entries) if (now >= current.resetAt) entries.delete(entryId);
      return {
        allowed: entry.count <= limit,
        limit,
        remaining: Math.max(0, limit - entry.count),
        resetAt: entry.resetAt,
        retryAfterMs: Math.max(0, entry.resetAt - now),
      };
    },
    size: () => entries.size,
    clear: () => entries.clear(),
  };
}

function applyRateHeaders(res, rate) {
  res.setHeader('RateLimit-Limit', String(rate.limit));
  res.setHeader('RateLimit-Remaining', String(rate.remaining));
  res.setHeader('RateLimit-Reset', String(Math.ceil(rate.resetAt / 1000)));
}

function requestIp(req, config) {
  if (config.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || 'unknown';
}

async function readJsonBody(req, config) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.maxBodyBytes) throw httpError(413, 'request_body_too_large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); }
  catch (_error) { throw httpError(400, 'invalid_json'); }
}

function auditImmediate(api, req, pathname, statusCode, error) {
  recordApiRequest(api.getWorld(), {
    method: req.method || 'GET',
    path: pathname,
    statusCode,
    durationMs: 0,
    accountId: req.apiAccountId || null,
    error,
    userAgent: req.headers['user-agent'] || null,
  });
}

function rejectUpgrade(socket, statusCode, message) {
  const status = statusCode === 401 ? 'Unauthorized' : 'Forbidden';
  const text = JSON.stringify({ ok: false, error: message });
  socket.write(`HTTP/1.1 ${statusCode} ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
  socket.destroy();
}

function normalizePath(value) {
  return String(value || '/').replace(/\/+$/g, '') || '/';
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function ok(data) {
  return { ok: true, data };
}

function writeJson(res, statusCode, payload) {
  if (res.writableEnded) return;
  const text = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

module.exports = {
  DIRECT_PATHS,
  createProductionApiServer,
  normalizeProductionApiOptions,
  productionReadiness,
  productionSecuritySummary,
  createRateLimiter,
  requestAllowedOrigin,
  normalizeRoles,
  validateAccountId,
};
