'use strict';

const path = require('path');
const { URL } = require('url');
const {
  createWorldApiServer: createBaseWorldApiServer,
  DEFAULT_API_OPTIONS,
} = require('./api-server-engine');
const {
  createWorldTemplateRegistry,
  getWorldTemplate,
  listWorldTemplates,
  summarizeWorldTemplate,
  resetWorldFromTemplate,
} = require('./world-template-engine');
const { saveWorld } = require('./persistence-engine');
const {
  saveWorldForApi,
  loadWorldForApi,
  listWorldSavesForApi,
} = require('./api-database-persistence-engine');
const { getDatabaseStatus, listDatabaseEvents } = require('./database-engine');
const {
  validateSession,
} = require('./account-session-engine');
const {
  canRunWorldControl,
  requirePermission,
  requireSession,
} = require('./api-permission-engine');
const { recordApiRequest } = require('./api-audit-engine');
const {
  RUNTIME_LOOP_STATUS,
  pauseRuntimeLoop,
  getRuntimeLoopSummary,
} = require('./runtime-loop-engine');

const TEMPLATE_API_PATHS = new Set([
  '/admin/templates',
  '/admin/templates/reset',
]);

const PERSISTENCE_API_PATHS = new Set([
  '/saves',
  '/save',
  '/load',
]);

const DATABASE_ADMIN_API_PATHS = new Set([
  '/admin/database',
  '/admin/database/events',
]);

function createWorldTemplateApiServer(worldInput = null, options = {}) {
  const result = createBaseWorldApiServer(worldInput, options);
  const registry = options.templateRegistry || createWorldTemplateRegistry({
    templates: options.worldTemplates || [],
  });
  result.api.templateRegistry = registry;

  const listeners = result.server.listeners('request');
  const baseRequestListener = listeners[0];
  if (typeof baseRequestListener !== 'function') {
    throw new Error('World template API requires the base request listener');
  }

  result.server.removeListener('request', baseRequestListener);
  result.server.on('request', (req, res) => {
    const parsed = new URL(req.url || '/', 'http://localhost');
    const pathname = normalizePath(parsed.pathname);
    if (!TEMPLATE_API_PATHS.has(pathname) && !PERSISTENCE_API_PATHS.has(pathname) && !DATABASE_ADMIN_API_PATHS.has(pathname)) {
      return baseRequestListener.call(result.server, req, res);
    }
    return handleTemplateApiRequest(req, res, parsed, pathname, result.api, result.options, registry);
  });

  return {
    ...result,
    templateRegistry: registry,
  };
}

async function handleTemplateApiRequest(req, res, parsed, pathname, api, options, registry) {
  const started = Date.now();
  const method = req.method || 'GET';
  let errorMessage = null;
  let auth = null;

  setCors(res);
  try {
    if (method === 'OPTIONS') return end(res, 204, '');

    auth = getRequestAuth(api.getWorld(), req, parsed);
    req.apiAccountId = auth?.account?.id || null;
    requireWorldControlIfNeeded(options, auth);

    if (method === 'GET' && pathname === '/admin/database') {
      const request = persistenceRequestFromSearch(parsed);
      return writeJson(res, 200, ok({
        database: getDatabaseStatus(request.database),
        loop: getRuntimeLoopSummary(api.runtimeLoop),
      }));
    }

    if (method === 'GET' && pathname === '/admin/database/events') {
      const request = persistenceRequestFromSearch(parsed);
      return writeJson(res, 200, ok({
        database: getDatabaseStatus(request.database),
        events: listDatabaseEvents({
          database: request.database,
          worldId: request.worldId,
          type: parsed.searchParams.get('type') || undefined,
          limit: Number(parsed.searchParams.get('limit') || 100),
          order: parsed.searchParams.get('order') || 'desc',
        }),
      }));
    }

    if (method === 'GET' && pathname === '/saves') {
      const result = listWorldSavesForApi(persistenceRequestFromSearch(parsed), options);
      return writeJson(res, 200, ok(result));
    }

    if (method === 'POST' && pathname === '/save') {
      const body = await readJsonBody(req, options);
      const result = saveWorldForApi(api.getWorld(), body || {}, options);
      const save = result.save || {};
      api.broadcast({
        type: 'save',
        worldId: api.getWorld().id,
        tick: api.getWorld().tick,
        mode: result.mode,
        file: save.file || null,
        provider: save.provider || null,
      });
      return writeJson(res, 200, ok({ mode: result.mode, ...save }));
    }

    if (method === 'POST' && pathname === '/load') {
      const body = await readJsonBody(req, options);
      const result = loadWorldForApi(body || {}, options);
      if (!result.loaded) throw httpError(404, 'missing_save');
      const loaded = result.loaded;
      api.setWorld(loaded.world);
      synchronizeLoopAfterWorldReset(api.runtimeLoop, loaded.world);
      api.broadcast({
        type: 'load',
        worldId: loaded.worldId,
        tick: loaded.tick,
        mode: result.mode,
      });
      return writeJson(res, 200, ok({
        mode: result.mode,
        file: loaded.file || null,
        provider: loaded.provider || null,
        worldId: loaded.worldId,
        tick: loaded.tick,
        savedAt: loaded.savedAt,
      }));
    }

    if (method === 'GET' && pathname === '/admin/templates') {
      return writeJson(res, 200, ok({
        templates: listTemplateViews(registry),
        current: summarizeCurrentWorld(api.getWorld()),
        loop: getRuntimeLoopSummary(api.runtimeLoop),
      }));
    }

    if (method === 'POST' && pathname === '/admin/templates/reset') {
      const body = await readJsonBody(req, options);
      const templateId = requiredBody(body, 'templateId');
      const template = getWorldTemplate(registry, templateId);
      if (!template) throw httpError(404, `missing_world_template:${templateId}`);

      const loopBefore = getRuntimeLoopSummary(api.runtimeLoop);
      if (loopBefore.busy) throw httpError(409, 'runtime_loop_busy');
      if (loopBefore.status === RUNTIME_LOOP_STATUS.RUNNING) {
        if (body.pauseLoop !== true) throw httpError(409, 'runtime_loop_running');
        pauseRuntimeLoop(api.runtimeLoop, 'world_template_reset');
      }

      const currentWorld = api.getWorld();
      const backup = body.backup === true
        ? saveWorld(
          currentWorld,
          body.backupPath || defaultTemplateBackupPath(currentWorld, templateId),
          {
            createBackup: false,
            reason: 'template_reset_backup',
            metadata: {
              source: 'world_template_api',
              targetTemplateId: templateId,
            },
          },
        )
        : null;

      const preserveAccounts = body.preserveAccounts !== false;
      const preserveAudit = body.preserveAudit !== false;
      const nextWorld = resetWorldFromTemplate(currentWorld, registry, templateId, {
        worldId: body.worldId || undefined,
        seed: body.seed,
        seedTicks: body.seedTicks,
        initialize: body.initialize !== false,
        simulation: body.simulation || {},
        preserveAccounts,
        preserveAudit,
      });

      api.setWorld(nextWorld);
      synchronizeLoopAfterWorldReset(api.runtimeLoop, nextWorld);
      const response = {
        template: templateView(template),
        world: summarizeCurrentWorld(nextWorld),
        backup,
        preserved: {
          accounts: preserveAccounts,
          audit: preserveAudit,
        },
        loopBefore,
        loop: getRuntimeLoopSummary(api.runtimeLoop),
      };

      api.broadcast({
        type: 'world.template.reset',
        worldId: nextWorld.id,
        tick: nextWorld.tick,
        templateId,
        resetFromWorldId: currentWorld.id,
        backupFile: backup?.file || null,
      });
      return writeJson(res, 200, ok(response));
    }

    return writeJson(res, 405, {
      ok: false,
      error: 'method_not_allowed',
      path: pathname,
    });
  } catch (error) {
    errorMessage = error.message || 'template_api_error';
    return writeJson(res, error.statusCode || 500, {
      ok: false,
      error: errorMessage,
    });
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

function persistenceRequestFromSearch(parsed) {
  const params = parsed.searchParams;
  const database = {
    provider: params.get('dbProvider') || params.get('provider') || undefined,
    directory: params.get('dbDir') || params.get('databaseDir') || undefined,
    name: params.get('dbName') || params.get('databaseName') || undefined,
    autoCreate: params.get('dbAutoCreate') || params.get('autoCreate') || undefined,
  };
  return {
    persistence: params.get('persistence') || params.get('mode') || params.get('storage') || undefined,
    useDatabase: params.get('useDatabase') || undefined,
    dir: params.get('dir') || undefined,
    worldId: params.get('worldId') || undefined,
    database,
  };
}

function listTemplateViews(registry) {
  return listWorldTemplates(registry).map(summary => {
    const template = getWorldTemplate(registry, summary.id);
    return templateView(template);
  });
}

function templateView(template) {
  const summary = summarizeWorldTemplate(template);
  return {
    ...summary,
    locations: (template.definition?.locations || []).map(location => ({
      id: location.id,
      name: location.name || location.id,
      type: location.type || null,
      danger: Number(location.danger || 0),
    })),
    organizationNames: (template.definition?.organizations || []).map(organization => (
      organization.name || organization.id || organization.key
    )).filter(Boolean),
    defaultLocationId: template.definition?.locations?.[0]?.id || null,
    defaultWorldId: template.definition?.world?.id || template.id,
    defaultSeed: template.definition?.world?.seed ?? 1,
  };
}

function summarizeCurrentWorld(world) {
  return {
    id: world?.id || null,
    tick: world?.tick ?? null,
    template: world?.template ? { ...world.template } : null,
    totals: {
      locations: Object.keys(world?.locations || {}).length,
      entities: Object.keys(world?.entities || {}).length,
      organizations: Object.keys(world?.organizations?.byId || {}).length,
      players: Object.keys(world?.players?.byId || {}).length,
      accounts: Object.keys(world?.accounts?.byId || {}).length,
    },
    locations: Object.values(world?.locations || {}).map(location => ({
      id: location.id,
      name: location.name || location.id,
      type: location.type || null,
      danger: Number(location.danger || 0),
    })),
  };
}

function synchronizeLoopAfterWorldReset(loop, world) {
  if (!loop) return;
  loop.lastTickBefore = Number(world.tick || 0);
  loop.lastTickAfter = Number(world.tick || 0);
  loop.lastAutosaveTick = Number(world.tick || 0);
  loop.lastAutosave = null;
  loop.nextCycleAt = null;
}

function defaultTemplateBackupPath(world, templateId) {
  const fileName = [
    'template-reset',
    sanitizeFilePart(world?.id || 'world'),
    `tick-${Number(world?.tick || 0)}`,
    `to-${sanitizeFilePart(templateId)}`,
  ].join('-') + '.json';
  return path.join('world-engine', 'output', fileName);
}

function getRequestAuth(world, req, parsed) {
  const token = bearerToken(req) || parsed.searchParams.get('token') || null;
  return token ? validateSession(world, token) : null;
}

function requireWorldControlIfNeeded(options, auth) {
  if (!options.requireAuth) return;
  const sessionAuth = requireSession(auth);
  requirePermission(canRunWorldControl(sessionAuth.account), 'world_control_forbidden');
}

function bearerToken(req) {
  const value = String(req.headers.authorization || '');
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function requiredBody(body, key) {
  const value = body?.[key];
  if (value === undefined || value === null || value === '') {
    throw httpError(400, `missing_body_field:${key}`);
  }
  return value;
}

function readJsonBody(req, options = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const maxBodyBytes = Number(options.maxBodyBytes || DEFAULT_API_OPTIONS.maxBodyBytes);
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) {
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

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function ok(data) {
  return { ok: true, data };
}

function writeJson(res, statusCode, payload) {
  const text = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

function end(res, statusCode, text) {
  res.statusCode = statusCode;
  res.end(text || '');
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function normalizePath(value) {
  const text = String(value || '/').replace(/\/+/g, '/');
  if (text.length > 1 && text.endsWith('/')) return text.slice(0, -1);
  return text || '/';
}

function sanitizeFilePart(value) {
  return String(value || 'world').replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

module.exports = {
  TEMPLATE_API_PATHS,
  PERSISTENCE_API_PATHS,
  DATABASE_ADMIN_API_PATHS,
  createWorldTemplateApiServer,
  createWorldApiServer: createWorldTemplateApiServer,
  persistenceRequestFromSearch,
  listTemplateViews,
  templateView,
  summarizeCurrentWorld,
  synchronizeLoopAfterWorldReset,
  defaultTemplateBackupPath,
};
