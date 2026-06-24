'use strict';

const crypto = require('crypto');
const { URL } = require('url');
const {
  createOperationalWorldApiServer,
  applyOperationalHeaders,
  applyCors,
} = require('./operational-api-engine');
const { validateSession } = require('./account-session-engine');
const { canRunWorldControl } = require('./api-permission-engine');
const { recordApiRequest } = require('./api-audit-engine');
const { handleProductionTemplateReset } = require('./production-template-reset-engine');

const PROTECTED_HEADERS = new Set([
  'access-control-allow-origin',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'vary',
]);

function createProductionWorldApiServer(worldInput = null, options = {}) {
  const result = createOperationalWorldApiServer(worldInput, options);
  const production = result.productionConfig;
  if (!production.enabled) return result;

  const listener = result.server.listeners('request')[0];
  if (typeof listener !== 'function') throw new Error('production_request_listener_missing');
  result.server.removeListener('request', listener);
  result.server.on('request', async (req, res) => {
    protectHeaders(res);
    const parsed = new URL(req.url || '/', 'http://localhost');
    const pathname = normalizePath(parsed.pathname);
    const method = req.method || 'GET';
    const auth = requestAuth(result.api.getWorld(), req, parsed);

    if (pathname === '/admin/templates/reset' && method === 'POST') {
      applyOperationalHeaders(req, res, pathname, production);
      if (!applyCors(req, res, production.corsOrigins)) {
        return writeGuardResponse(req, res, result.api, pathname, 403, 'cors_origin_forbidden');
      }
      return handleProductionTemplateReset(req, res, result.api, result.options, production);
    }

    if (pathname === '/stream' && !auth) {
      applyOperationalHeaders(req, res, pathname, production);
      applyCors(req, res, production.corsOrigins);
      return writeGuardResponse(req, res, result.api, pathname, 401, 'auth_required');
    }

    if (pathname === '/players' && method === 'POST' && !isOperator(auth)) {
      applyOperationalHeaders(req, res, pathname, production);
      applyCors(req, res, production.corsOrigins);
      return writeGuardResponse(
        req,
        res,
        result.api,
        pathname,
        auth ? 403 : 401,
        auth ? 'world_control_forbidden' : 'auth_required',
      );
    }

    return listener.call(result.server, req, res);
  });

  wrapProductionUpgrades(result.server, result.api);
  return result;
}

function wrapProductionUpgrades(server, api) {
  const listeners = server.listeners('upgrade');
  if (!listeners.length) return;
  server.removeAllListeners('upgrade');
  server.on('upgrade', (req, socket, head) => {
    const parsed = new URL(req.url || '/', 'http://localhost');
    const auth = requestAuth(api.getWorld(), req, parsed);
    if (!auth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    for (const listener of listeners) listener.call(server, req, socket, head);
  });
}

function protectHeaders(res) {
  if (res.__phyrexProductionHeaderGuard) return;
  const original = res.setHeader.bind(res);
  res.setHeader = (name, value) => {
    const normalized = String(name).toLowerCase();
    if (PROTECTED_HEADERS.has(normalized) && res.hasHeader(name)) return res;
    return original(name, value);
  };
  res.__phyrexProductionHeaderGuard = true;
}

function requestAuth(world, req, parsed) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  const token = (match ? match[1].trim() : null) || parsed.searchParams.get('token') || null;
  return token ? validateSession(world, token) : null;
}

function isOperator(auth) {
  return Boolean(auth?.account && canRunWorldControl(auth.account));
}

function writeGuardResponse(req, res, api, pathname, statusCode, error) {
  const requestId = String(req.headers['x-request-id'] || crypto.randomUUID());
  req.apiRequestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  recordApiRequest(api.getWorld(), {
    id: requestId,
    method: req.method,
    path: pathname,
    statusCode,
    durationMs: 0,
    accountId: req.apiAccountId || null,
    error,
    userAgent: req.headers['user-agent'] || null,
  });
  const text = JSON.stringify({ ok: false, error, requestId });
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

function normalizePath(value) {
  const text = String(value || '/').replace(/\/+/g, '/');
  return text.length > 1 && text.endsWith('/') ? text.slice(0, -1) : text || '/';
}

module.exports = {
  createProductionWorldApiServer,
  createWorldApiServer: createProductionWorldApiServer,
  wrapProductionUpgrades,
  protectHeaders,
};
