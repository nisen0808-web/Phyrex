'use strict';

const crypto = require('crypto');
const {
  getWorldTemplate,
  resetWorldFromTemplate,
  summarizeWorldTemplate,
} = require('./world-template-engine');
const { saveWorld } = require('./persistence-engine');
const { recordApiRequest } = require('./api-audit-engine');
const { canRunWorldControl } = require('./api-permission-engine');
const { validateSession } = require('./account-session-engine');
const {
  RUNTIME_LOOP_STATUS,
  pauseRuntimeLoop,
  getRuntimeLoopSummary,
} = require('./runtime-loop-engine');
const { synchronizeLoopAfterWorldReset } = require('./world-template-api-engine');
const { ensureOperatorAccess } = require('./operational-api-engine');
const { resolveManagedPath } = require('./production-config-engine');

async function handleProductionTemplateReset(req, res, api, options, production) {
  const started = Date.now();
  const auth = requestAuth(api.getWorld(), req);
  const operator = requireOperator(auth);
  req.apiAccountId = operator.account.id;
  req.apiRequestId = String(req.headers['x-request-id'] || crypto.randomUUID());
  res.setHeader('X-Request-Id', req.apiRequestId);

  try {
    const body = await readJsonBody(req, options);
    const templateId = required(body, 'templateId');
    const template = getWorldTemplate(api.templateRegistry, templateId);
    if (!template) throw httpError(404, `missing_world_template:${templateId}`);

    const loopBefore = getRuntimeLoopSummary(api.runtimeLoop);
    if (loopBefore.busy) throw httpError(409, 'runtime_loop_busy');
    if (loopBefore.status === RUNTIME_LOOP_STATUS.RUNNING) {
      if (body.pauseLoop !== true) throw httpError(409, 'runtime_loop_running');
      pauseRuntimeLoop(api.runtimeLoop, 'world_template_reset');
    }

    const currentWorld = api.getWorld();
    const backup = body.backup === true
      ? createTemplateBackup(currentWorld, production, templateId, body.backupPath, operator.account.id)
      : null;
    const preserveAccounts = body.preserveAccounts !== false;
    const preserveAudit = body.preserveAudit !== false;
    const nextWorld = resetWorldFromTemplate(currentWorld, api.templateRegistry, templateId, {
      worldId: body.worldId || undefined,
      seed: body.seed,
      seedTicks: body.seedTicks,
      initialize: body.initialize !== false,
      simulation: body.simulation || {},
      preserveAccounts,
      preserveAudit,
    });

    api.setWorld(nextWorld);
    ensureOperatorAccess(nextWorld, production);
    synchronizeLoopAfterWorldReset(api.runtimeLoop, nextWorld);
    const data = {
      template: summarizeWorldTemplate(template),
      world: summarizeWorld(nextWorld),
      backup,
      preserved: { accounts: preserveAccounts, audit: preserveAudit },
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
    return writeResponse(req, res, api, 200, { ok: true, data }, Date.now() - started);
  } catch (error) {
    return writeResponse(req, res, api, error.statusCode || 500, {
      ok: false,
      error: error.message || 'template_reset_failed',
    }, Date.now() - started);
  }
}

function createTemplateBackup(world, production, templateId, requestedPath, operatorAccountId) {
  const fallback = [
    'template-reset',
    safePart(world?.id),
    `tick-${Number(world?.tick || 0)}`,
    `to-${safePart(templateId)}`,
    `${Date.now()}.json`,
  ].join('-');
  const filePath = resolveManagedPath(production.dataDir, requestedPath || fallback, { extension: '.json' });
  return saveWorld(world, filePath, {
    createBackup: false,
    reason: 'template_reset_backup',
    metadata: {
      source: 'production_api',
      operatorAccountId,
      targetTemplateId: templateId,
    },
  });
}

function requestAuth(world, req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? validateSession(world, match[1].trim()) : null;
}

function requireOperator(auth) {
  if (!auth?.account) throw httpError(401, 'auth_required');
  if (!canRunWorldControl(auth.account)) throw httpError(403, 'world_control_forbidden');
  return auth;
}

function readJsonBody(req, options = {}) {
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

function writeResponse(req, res, api, statusCode, payload, durationMs) {
  recordApiRequest(api.getWorld(), {
    id: req.apiRequestId || crypto.randomUUID(),
    method: req.method,
    path: '/admin/templates/reset',
    statusCode,
    durationMs,
    accountId: req.apiAccountId || null,
    error: statusCode >= 400 ? payload.error : null,
    userAgent: req.headers['user-agent'] || null,
  });
  const text = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

function summarizeWorld(world) {
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
  };
}

function required(body, key) {
  const value = body?.[key];
  if (value === undefined || value === null || value === '') throw httpError(400, `missing_body_field:${key}`);
  return value;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function safePart(value) {
  return String(value || 'world').replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

module.exports = {
  handleProductionTemplateReset,
  createTemplateBackup,
  summarizeWorld,
};
