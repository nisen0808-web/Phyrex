'use strict';

const http = require('http');
const { URL } = require('url');
const { createPostgresDatabaseStore } = require('../storage/postgres/store');
const { validateSession } = require('./account-session-engine');
const { canAccessPlayer, requirePermission, requireSession } = require('./api-permission-engine');
const { createFixedWindowRateLimiter } = require('./request-rate-limit-engine');

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
  const maxBodyBytes = boundedInteger(
    options.maxBodyBytes ?? DEFAULT_DURABLE_COMMAND_API_OPTIONS.maxBodyBytes,
    1024,
    1024 * 1024,
    'maxBodyBytes',
  );
  const authorizationAttempts = boundedInteger(
    options.authorizationAttempts ?? DEFAULT_DURABLE_COMMAND_API_OPTIONS.authorizationAttempts,
    1,
    10,
    'authorizationAttempts',
  );
  const sourceRateLimit = boundedInteger(
    options.sourceRateLimit ?? DEFAULT_DURABLE_COMMAND_API_OPTIONS.sourceRateLimit,
    1,
    1000000,
    'sourceRateLimit',
  );
  const accountSubmitRateLimit = boundedInteger(
    options.accountSubmitRateLimit ?? DEFAULT_DURABLE_COMMAND_API_OPTIONS.accountSubmitRateLimit,
    1,
    1000000,
    'accountSubmitRateLimit',
  );
  const accountReadRateLimit = boundedInteger(
    options.accountReadRateLimit ?? DEFAULT_DURABLE_COMMAND_API_OPTIONS.accountReadRateLimit,
    1,
    1000000,
    'accountReadRateLimit',
  );
  const rateLimitWindowMs = boundedInteger(
    options.rateLimitWindowMs ?? DEFAULT_DURABLE_COMMAND_API_OPTIONS.rateLimitWindowMs,
    10,
    24 * 60 * 60 * 1000,
    'rateLimitWindowMs',
  );
  const maxTrackedSources = boundedInteger(
    options.maxTrackedSources ?? DEFAULT_DURABLE_COMMAND_API_OPTIONS.maxTrackedSources,
    10,
    1000000,
    'maxTrackedSources',
  );
  const maxTrackedAccounts = boundedInteger(
    options.maxTrackedAccounts ?? DEFAULT_DURABLE_COMMAND_API_OPTIONS.maxTrackedAccounts,
    10,
    1000000,
    'maxTrackedAccounts',
  );
  if (typeof options.rateLimitNow !== 'function') throw apiError(500, 'rate_limit_clock_required');
  const limiterCommon = { windowMs: rateLimitWindowMs, now: options.rateLimitNow };
  const rateLimiters = Object.freeze({
    source: createFixedWindowRateLimiter({ ...limiterCommon, limit: sourceRateLimit, maxKeys: maxTrackedSources }),
    submit: createFixedWindowRateLimiter({ ...limiterCommon, limit: accountSubmitRateLimit, maxKeys: maxTrackedAccounts }),
    read: createFixedWindowRateLimiter({ ...limiterCommon, limit: accountReadRateLimit, maxKeys: maxTrackedAccounts }),
  });

  const ownsStore = !options.store || options.closeStore === true;
  const store = options.store || createPostgresDatabaseStore({ ...(options.database || {}), env: options.env });
  if (store.provider !== 'postgres' || !['loadWorld', 'enqueueCommand', 'getCommand', 'summary', 'close'].every(key => typeof store[key] === 'function')) {
    if (ownsStore && typeof store.close === 'function') await store.close().catch(() => {});
    throw apiError(500, 'transactional_store_required');
  }
  try {
    await store.summary();
  } catch (error) {
    if (ownsStore) await store.close().catch(() => {});
    throw error;
  }

  let closePromise = null;
  const requestOptions = Object.freeze({ maxBodyBytes, authorizationAttempts, rateLimiters });
  const server = http.createServer((req, res) => {
    handleRequest(req, res, store, requestOptions).catch(error => writeMappedError(res, error));
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (server.listening) await new Promise(resolve => server.close(() => resolve()));
      if (ownsStore) await store.close();
    })();
    return closePromise;
  }

  function rateLimitStats() {
    return {
      trackedSources: rateLimiters.source.size(),
      trackedSubmitAccounts: rateLimiters.submit.size(),
      trackedReadAccounts: rateLimiters.read.size(),
    };
  }

  return Object.freeze({
    server,
    store,
    close,
    rateLimitStats,
    options: Object.freeze({
      maxBodyBytes,
      authorizationAttempts,
      sourceRateLimit,
      accountSubmitRateLimit,
      accountReadRateLimit,
      rateLimitWindowMs,
      maxTrackedSources,
      maxTrackedAccounts,
    }),
  });
}

async function handleRequest(req, res, store, options) {
  setSafeHeaders(res);
  enforceRateLimit(options.rateLimiters.source.consume(requestSourceKey(req)));
  const method = String(req.method || 'GET').toUpperCase();
  const parsed = new URL(req.url || '/', 'http://localhost');
  const route = parseCommandRoute(parsed.pathname);
  if (!route) throw apiError(404, 'not_found');

  if (route.kind === 'submit') {
    if (method !== 'POST') throw apiError(405, 'method_not_allowed');
    const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      req.resume();
      throw apiError(415, 'json_required');
    }
    const body = await readJsonBody(req, options.maxBodyBytes);
    if (!isObject(body)) throw apiError(400, 'invalid_command');
    if (typeof body.id !== 'string' || !body.id) throw apiError(400, 'command_id_required');
    if (typeof body.type !== 'string' || !body.type) throw apiError(400, 'command_type_required');
    const token = bearerToken(req);
    const row = await withFreshPlayerAuthorization(
      store,
      route.worldId,
      route.playerId,
      token,
      options.authorizationAttempts,
      options.rateLimiters.submit,
      context => store.enqueueCommand({
        worldId: route.worldId,
        id: body.id,
        playerId: route.playerId,
        input: body,
      }, { expectedWorldRevision: context.revision }),
    );
    return writeJson(res, row.status === 'applied' ? 200 : 202, { ok: true, data: commandView(row) });
  }

  if (route.kind === 'status') {
    if (method !== 'GET') throw apiError(405, 'method_not_allowed');
    const token = bearerToken(req);
    const row = await withFreshCommandAuthorization(
      store,
      route.worldId,
      route.commandId,
      token,
      options.authorizationAttempts,
      options.rateLimiters.read,
    );
    return writeJson(res, 200, { ok: true, data: commandView(row) });
  }

  throw apiError(404, 'not_found');
}

async function withFreshPlayerAuthorization(store, worldId, playerId, token, attempts, accountLimiter, action) {
  let lastConflict = null;
  let accountRateChecked = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const context = await authenticateWorld(store, worldId, token);
    if (!accountRateChecked) {
      enforceRateLimit(accountLimiter.consume(accountRateKey(worldId, context.auth.account.id)));
      accountRateChecked = true;
    }
    if (!context.world.players?.byId?.[playerId]) throw apiError(404, 'player_not_found');
    requirePermission(canAccessPlayer(context.auth.account, playerId), 'player_forbidden');
    try {
      return await action(context);
    } catch (error) {
      if (error?.code === 'WORLD_DB_REVISION_CONFLICT' && attempt + 1 < attempts) {
        lastConflict = error;
        continue;
      }
      throw error;
    }
  }
  throw lastConflict || apiError(409, 'world_revision_changed');
}

async function withFreshCommandAuthorization(store, worldId, commandId, token, attempts, accountLimiter) {
  let lastConflict = null;
  let accountRateChecked = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const context = await authenticateWorld(store, worldId, token);
    if (!accountRateChecked) {
      enforceRateLimit(accountLimiter.consume(accountRateKey(worldId, context.auth.account.id)));
      accountRateChecked = true;
    }
    try {
      const row = await store.getCommand(worldId, commandId, { expectedWorldRevision: context.revision });
      if (!row) throw apiError(404, 'command_not_found');
      requirePermission(canAccessPlayer(context.auth.account, row.playerId), 'command_forbidden');
      return row;
    } catch (error) {
      if (error?.code === 'WORLD_DB_REVISION_CONFLICT' && attempt + 1 < attempts) {
        lastConflict = error;
        continue;
      }
      throw error;
    }
  }
  throw lastConflict || apiError(409, 'world_revision_changed');
}

async function authenticateWorld(store, worldId, token) {
  if (!token) throw apiError(401, 'auth_required');
  const loaded = await store.loadWorld(worldId);
  if (!loaded) throw apiError(404, 'world_not_found');
  const auth = requireSession(validateSession(loaded.world, token));
  return { world: loaded.world, revision: loaded.revision, auth };
}

function parseCommandRoute(pathname) {
  const segments = String(pathname || '/').split('/').filter(Boolean).map(decodeSegment);
  if (segments.length === 6 && segments[0] === 'durable' && segments[1] === 'worlds'
      && segments[3] === 'players' && segments[5] === 'commands') {
    return { kind: 'submit', worldId: segments[2], playerId: segments[4] };
  }
  if (segments.length === 5 && segments[0] === 'durable' && segments[1] === 'worlds'
      && segments[3] === 'commands') {
    return { kind: 'status', worldId: segments[2], commandId: segments[4] };
  }
  return null;
}

function decodeSegment(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.includes('\u0000')) throw new Error('bad segment');
    return decoded;
  } catch (_) {
    throw apiError(400, 'invalid_path');
  }
}

function bearerToken(req) {
  const value = String(req.headers.authorization || '');
  const match = value.match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : null;
}

function requestSourceKey(req) {
  let address = String(req?.socket?.remoteAddress || 'unknown').trim().toLowerCase();
  if (address.startsWith('::ffff:')) address = address.slice(7);
  return `socket:${address || 'unknown'}`;
}

function accountRateKey(worldId, accountId) {
  return `world:${String(worldId)}\u0001account:${String(accountId)}`;
}

function enforceRateLimit(result) {
  if (!result?.allowed) throw apiError(429, 'rate_limited', { retryAfterMs: result?.retryAfterMs || 1000 });
  return result;
}

function readJsonBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        settled = true;
        req.resume();
        reject(apiError(413, 'request_body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) return reject(apiError(400, 'json_body_required'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(apiError(400, 'invalid_json'));
      }
    });
    req.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function commandView(row) {
  return {
    id: row.id,
    worldId: row.worldId,
    playerId: row.playerId,
    sequence: row.sequence,
    status: row.status,
    result: row.status === 'applied' ? row.result : null,
    submittedAt: row.submittedAt || null,
    appliedAt: row.appliedAt || null,
    idempotent: row.idempotent === true,
  };
}

function writeMappedError(res, error) {
  if (res.writableEnded) return;
  const mapped = mapError(error);
  if (mapped.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
  if (mapped.status === 429) {
    const retrySeconds = Math.max(1, Math.ceil(Number(mapped.retryAfterMs || 1000) / 1000));
    res.setHeader('Retry-After', String(retrySeconds));
  }
  writeJson(res, mapped.status, { ok: false, error: mapped.code });
}

function mapError(error) {
  if (Number.isInteger(error?.statusCode)) {
    return {
      status: error.statusCode,
      code: safeApiCode(error.apiCode || error.message),
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  }
  const code = String(error?.code || '');
  if (['WORLD_DB_INVALID_INPUT', 'WORLD_DB_INVALID_CONFIG'].includes(code)) return { status: 400, code: 'invalid_command' };
  if (code === 'WORLD_DB_PAYLOAD_TOO_LARGE') return { status: 413, code: 'command_too_large' };
  if (code === 'WORLD_DB_MISSING_WORLD') return { status: 404, code: 'world_not_found' };
  if (['WORLD_DB_IDEMPOTENCY_CONFLICT', 'WORLD_DB_REVISION_CONFLICT', 'WORLD_DB_COMMAND_CONFLICT'].includes(code)) {
    return { status: 409, code: code === 'WORLD_DB_IDEMPOTENCY_CONFLICT' ? 'command_id_conflict' : 'world_revision_changed' };
  }
  if (['WORLD_DB_UNAVAILABLE', 'WORLD_DB_TIMEOUT', 'WORLD_DB_MIGRATION_REQUIRED', 'WORLD_DB_CLOSED'].includes(code)) {
    return { status: 503, code: 'service_unavailable' };
  }
  return { status: 500, code: 'internal_error' };
}

function safeApiCode(value) {
  const allowed = new Set([
    'auth_required', 'player_forbidden', 'command_forbidden', 'player_not_found', 'world_not_found',
    'command_not_found', 'not_found', 'method_not_allowed', 'json_required', 'invalid_command',
    'command_id_required', 'command_type_required', 'request_body_too_large', 'json_body_required',
    'invalid_json', 'invalid_path', 'world_revision_changed', 'transactional_store_required', 'rate_limited',
  ]);
  return allowed.has(value) ? value : 'internal_error';
}

function setSafeHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function writeJson(res, statusCode, payload) {
  if (res.writableEnded) return;
  const text = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

function boundedInteger(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw apiError(500, `invalid_${name}`);
  return number;
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

module.exports = {
  DEFAULT_DURABLE_COMMAND_API_OPTIONS,
  createDurableCommandApiServer,
  parseCommandRoute,
  commandView,
  mapError,
  requestSourceKey,
  enforceRateLimit,
};
