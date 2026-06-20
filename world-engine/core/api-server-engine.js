'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { buildDemoWorld, runDemoWorld } = require('../demo/run-demo');
const { createPlayerWithCharacter } = require('./player-engine');
const { executePlayerCommand } = require('./command-engine');
const { queryWorld } = require('./query-engine');
const { createWorldSnapshot } = require('./snapshot-engine');
const { scheduleOfflineCommand, getPlayerOfflineCommands } = require('./offline-command-engine');
const { createWorldRuntime, runWorldRuntime, getRuntimeSummary } = require('./runtime-engine');
const {
  createRuntimeLoop,
  startRuntimeLoop,
  pauseRuntimeLoop,
  stopRuntimeLoop,
  configureRuntimeLoop,
  stepRuntimeLoop,
  getRuntimeLoopSummary,
} = require('./runtime-loop-engine');
const { saveWorld, loadWorld, listSaves } = require('./persistence-engine');
const { createAccount, createSession, validateSession, revokeSession, getAccountView, linkPlayerToAccount, getAccountStats } = require('./account-session-engine');
const { canAccessAccount, canAccessPlayer, canRunWorldControl, requirePermission, requireSession } = require('./api-permission-engine');
const { recordApiRequest, getApiAuditLog, getApiErrors, getApiAuditStats } = require('./api-audit-engine');
const { getPlayerDashboard, executeBrowserAction } = require('./browser-client-engine');

const DEFAULT_API_OPTIONS = {
  port: 8790,
  host: '127.0.0.1',
  seedTicks: 10,
  maxBodyBytes: 1024 * 1024,
  defaultSavePath: 'world-engine/output/api-world-save.json',
  requireAuth: false,
  clientPath: path.join(__dirname, '..', 'client'),
  autoStartLoop: false,
  runtimeLoop: {
    intervalMs: 1000,
    ticksPerCycle: 1,
    autosaveEveryTicks: 0,
    autosavePath: null,
    stopOnError: false,
    simulation: {
      autoNovel: false,
      autoNarrative: false,
      population: { baseBirthChance: 0, baseMortalityChance: 0 },
    },
  },
};

function createWorldApiServer(worldInput = null, options = {}) {
  const opts = {
    ...DEFAULT_API_OPTIONS,
    ...(options || {}),
    runtimeLoop: {
      ...DEFAULT_API_OPTIONS.runtimeLoop,
      ...(options.runtimeLoop || {}),
      simulation: {
        ...DEFAULT_API_OPTIONS.runtimeLoop.simulation,
        ...(options.runtimeLoop?.simulation || {}),
      },
    },
  };
  let world = worldInput || buildDefaultApiWorld(opts);
  const streams = new Set();
  const sockets = new Set();
  const api = {
    streams,
    sockets,
    runtimeLoop: null,
    getWorld: () => world,
    setWorld: next => { world = next; return world; },
    broadcast: event => broadcastAll(streams, sockets, event),
  };

  const loopOptions = { ...(opts.runtimeLoop || {}) };
  if (loopOptions.autosaveEveryTicks && !loopOptions.autosavePath) loopOptions.autosavePath = opts.defaultSavePath;
  api.runtimeLoop = createRuntimeLoop(() => api.getWorld(), {
    ...loopOptions,
    onCycle: report => {
      api.broadcast({
        type: 'runtime.loop.tick',
        worldId: api.getWorld().id,
        tick: api.getWorld().tick,
        report: summarizeLoopCycle(report),
      });
    },
  });

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    req.apiRequestId = `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    let errorMessage = null;
    try {
      await handleApiRequest(req, res, api, opts);
    } catch (error) {
      errorMessage = error.message || 'api_error';
      writeJson(res, error.statusCode || 500, { ok: false, error: errorMessage });
    } finally {
      recordApiRequest(api.getWorld(), {
        id: req.apiRequestId,
        method: req.method,
        path: normalizePath((req.url || '/').split('?')[0]),
        statusCode: res.statusCode || 200,
        durationMs: Date.now() - started,
        accountId: req.apiAccountId || null,
        playerId: req.apiPlayerId || null,
        error: errorMessage,
        userAgent: req.headers['user-agent'] || null,
      });
    }
  });
  server.on('listening', () => {
    if (opts.autoStartLoop) startRuntimeLoop(api.runtimeLoop);
  });
  server.on('close', () => stopRuntimeLoop(api.runtimeLoop, 'server_close'));
  server.on('upgrade', (req, socket) => handleWebSocketUpgrade(req, socket, api));
  server.on('clientError', (_err, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  return { server, api, options: opts, streams, sockets, runtimeLoop: api.runtimeLoop };
}

function buildDefaultApiWorld(options = {}) {
  const world = buildDemoWorld();
  runDemoWorld(world, Number(options.seedTicks || 10), {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0, baseMortalityChance: 0 },
  });
  return world;
}

async function handleApiRequest(req, res, api, options) {
  setCors(res);
  if (req.method === 'OPTIONS') return end(res, 204, '');
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = normalizePath(parsed.pathname);
  const method = req.method || 'GET';
  const auth = getRequestAuth(api.getWorld(), req, parsed);
  req.apiAccountId = auth?.account?.id || null;

  if (method === 'GET' && (pathname === '/' || pathname === '/client' || pathname.startsWith('/client/'))) return serveClientFile(req, res, pathname, options);
  if (method === 'GET' && pathname === '/health') return writeJson(res, 200, health(api.getWorld(), api));
  if (method === 'GET' && pathname === '/world') return writeJson(res, 200, ok(queryWorld(api.getWorld(), { type: 'world' })));
  if (method === 'GET' && pathname === '/snapshot') return writeJson(res, 200, ok(createWorldSnapshot(api.getWorld())));
  if (method === 'GET' && pathname === '/saves') { requireWorldControlIfNeeded(options, auth); return writeJson(res, 200, ok({ saves: listSaves(parsed.searchParams.get('dir') || undefined) })); }
  if (method === 'GET' && pathname === '/stream') return openTickStream(req, res, api);

  if (method === 'GET' && pathname === '/admin/status') { requireWorldControlIfNeeded(options, auth); return writeJson(res, 200, ok(adminStatus(api))); }
  if (method === 'GET' && pathname === '/admin/runtime') {
    requireWorldControlIfNeeded(options, auth);
    const runtime = getRuntimeSummary(createWorldRuntime(api.getWorld(), { maxTicks: 0 }));
    return writeJson(res, 200, ok({ ...runtime, loop: getRuntimeLoopSummary(api.runtimeLoop) }));
  }
  if (method === 'GET' && pathname === '/admin/loop') { requireWorldControlIfNeeded(options, auth); return writeJson(res, 200, ok(getRuntimeLoopSummary(api.runtimeLoop))); }
  if (method === 'POST' && pathname === '/admin/loop/start') {
    requireWorldControlIfNeeded(options, auth);
    const body = await readJsonBody(req, options);
    if (Object.keys(body || {}).length) configureRuntimeLoop(api.runtimeLoop, body.options || body, { reschedule: false });
    const summary = startRuntimeLoop(api.runtimeLoop);
    api.broadcast({ type: 'runtime.loop.state', action: 'start', worldId: api.getWorld().id, tick: api.getWorld().tick, summary });
    return writeJson(res, 200, ok(summary));
  }
  if (method === 'POST' && pathname === '/admin/loop/pause') {
    requireWorldControlIfNeeded(options, auth);
    const body = await readJsonBody(req, options);
    const summary = pauseRuntimeLoop(api.runtimeLoop, body.reason || 'api_pause');
    api.broadcast({ type: 'runtime.loop.state', action: 'pause', worldId: api.getWorld().id, tick: api.getWorld().tick, summary });
    return writeJson(res, 200, ok(summary));
  }
  if (method === 'POST' && pathname === '/admin/loop/stop') {
    requireWorldControlIfNeeded(options, auth);
    const body = await readJsonBody(req, options);
    const summary = stopRuntimeLoop(api.runtimeLoop, body.reason || 'api_stop');
    api.broadcast({ type: 'runtime.loop.state', action: 'stop', worldId: api.getWorld().id, tick: api.getWorld().tick, summary });
    return writeJson(res, 200, ok(summary));
  }
  if (method === 'POST' && pathname === '/admin/loop/config') {
    requireWorldControlIfNeeded(options, auth);
    const body = await readJsonBody(req, options);
    const summary = configureRuntimeLoop(api.runtimeLoop, body.options || body);
    api.broadcast({ type: 'runtime.loop.state', action: 'config', worldId: api.getWorld().id, tick: api.getWorld().tick, summary });
    return writeJson(res, 200, ok(summary));
  }
  if (method === 'POST' && pathname === '/admin/loop/step') {
    requireWorldControlIfNeeded(options, auth);
    const body = await readJsonBody(req, options);
    const report = stepRuntimeLoop(api.runtimeLoop, Math.max(1, Number(body.ticks || 1)), { source: 'api_step' });
    return writeJson(res, report.ok ? 200 : 409, report.ok ? ok({ report, summary: getRuntimeLoopSummary(api.runtimeLoop) }) : { ok: false, error: report.reason || report.error?.message || 'runtime_loop_step_failed', data: report });
  }
  if (method === 'GET' && pathname === '/admin/connections') { requireWorldControlIfNeeded(options, auth); return writeJson(res, 200, ok({ streams: api.streams.size, sockets: api.sockets.size })); }
  if (method === 'GET' && pathname === '/admin/audit') { requireWorldControlIfNeeded(options, auth); return writeJson(res, 200, ok({ stats: getApiAuditStats(api.getWorld()), log: getApiAuditLog(api.getWorld(), { limit: Number(parsed.searchParams.get('limit') || 100) }) })); }
  if (method === 'GET' && pathname === '/admin/errors') { requireWorldControlIfNeeded(options, auth); return writeJson(res, 200, ok({ errors: getApiErrors(api.getWorld(), { limit: Number(parsed.searchParams.get('limit') || 50) }) })); }

  if (method === 'POST' && pathname === '/accounts') { const body = await readJsonBody(req, options); const account = createAccount(api.getWorld(), body.account || body || {}); api.broadcast({ type: 'account.created', worldId: api.getWorld().id, tick: api.getWorld().tick, accountId: account.id }); return writeJson(res, 201, ok(account)); }

  const accountMatch = pathname.match(/^\/accounts\/([^/]+)$/);
  if (method === 'GET' && accountMatch) { const accountId = decodeURIComponent(accountMatch[1]); requireAccountAccessIfNeeded(options, auth, accountId); return writeJson(res, 200, ok(getAccountView(api.getWorld(), accountId))); }

  const accountPlayerMatch = pathname.match(/^\/accounts\/([^/]+)\/players$/);
  if (method === 'POST' && accountPlayerMatch) {
    const accountId = decodeURIComponent(accountPlayerMatch[1]);
    requireAccountAccessIfNeeded(options, auth, accountId);
    const body = await readJsonBody(req, options);
    const result = createPlayerWithCharacter(api.getWorld(), body || {});
    linkPlayerToAccount(api.getWorld(), accountId, result.player.id);
    req.apiPlayerId = result.player.id;
    api.broadcast({ type: 'account.player.created', worldId: api.getWorld().id, tick: api.getWorld().tick, accountId, playerId: result.player.id, entityId: result.entity.id });
    return writeJson(res, 201, ok({ account: getAccountView(api.getWorld(), accountId), player: result.player, entity: result.entity }));
  }

  if (method === 'POST' && pathname === '/sessions') { const body = await readJsonBody(req, options); const accountId = requiredBody(body, 'accountId'); const session = createSession(api.getWorld(), accountId, body.options || {}); req.apiAccountId = accountId; api.broadcast({ type: 'session.created', worldId: api.getWorld().id, tick: api.getWorld().tick, accountId, sessionId: session.id }); return writeJson(res, 201, ok({ token: session.token, session: sanitizeSessionForApi(session), account: getAccountView(api.getWorld(), accountId) })); }
  if (method === 'GET' && pathname === '/session') { return writeJson(res, auth ? 200 : 401, auth ? ok({ session: sanitizeSessionForApi(auth.session), account: getAccountView(api.getWorld(), auth.account.id) }) : { ok: false, error: 'invalid_session' }); }
  if (method === 'POST' && pathname === '/sessions/revoke') { const body = await readJsonBody(req, options); const token = body.token || bearerToken(req); const session = revokeSession(api.getWorld(), token, body.reason || 'api_revoke'); return writeJson(res, session ? 200 : 404, session ? ok({ session: sanitizeSessionForApi(session) }) : { ok: false, error: 'missing_session' }); }

  const playerMatch = pathname.match(/^\/players\/([^/]+)$/);
  if (method === 'GET' && playerMatch) { const playerId = decodeURIComponent(playerMatch[1]); req.apiPlayerId = playerId; requirePlayerAccessIfNeeded(options, auth, playerId); return writeJson(res, 200, ok(queryWorld(api.getWorld(), { type: 'player', playerId }))); }

  const dashboardMatch = pathname.match(/^\/players\/([^/]+)\/dashboard$/);
  if (method === 'GET' && dashboardMatch) {
    const playerId = decodeURIComponent(dashboardMatch[1]);
    req.apiPlayerId = playerId;
    requirePlayerAccessIfNeeded(options, auth, playerId);
    return writeJson(res, 200, ok(getPlayerDashboard(api