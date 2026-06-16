'use strict';

const http = require('http');
const { URL } = require('url');
const { buildDemoWorld, runDemoWorld } = require('../demo/run-demo');
const { createPlayerWithCharacter } = require('./player-engine');
const { executePlayerCommand } = require('./command-engine');
const { queryWorld } = require('./query-engine');
const { createWorldSnapshot } = require('./snapshot-engine');
const { scheduleOfflineCommand, getPlayerOfflineCommands } = require('./offline-command-engine');
const { createWorldRuntime, runWorldRuntime } = require('./runtime-engine');
const { saveWorld, loadWorld, listSaves } = require('./persistence-engine');

const DEFAULT_API_OPTIONS = {
  port: 8790,
  host: '127.0.0.1',
  seedTicks: 10,
  maxBodyBytes: 1024 * 1024,
  defaultSavePath: 'world-engine/output/api-world-save.json',
};

function createWorldApiServer(worldInput = null, options = {}) {
  const opts = { ...DEFAULT_API_OPTIONS, ...(options || {}) };
  let world = worldInput || buildDefaultApiWorld(opts);
  const streams = new Set();

  const api = {
    getWorld: () => world,
    setWorld: next => { world = next; return world; },
    broadcast: event => broadcast(streams, event),
  };

  const server = http.createServer(async (req, res) => {
    try {
      await handleApiRequest(req, res, api, opts);
    } catch (error) {
      writeJson(res, 500, { ok: false, error: error.message || 'api_error' });
    }
  });

  server.on('clientError', (_err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return { server, api, options: opts, streams };
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

  if (method === 'GET' && pathname === '/health') return writeJson(res, 200, health(api.getWorld()));
  if (method === 'GET' && pathname === '/world') return writeJson(res, 200, ok(queryWorld(api.getWorld(), { type: 'world' })));
  if (method === 'GET' && pathname === '/snapshot') return writeJson(res, 200, ok(createWorldSnapshot(api.getWorld())));
  if (method === 'GET' && pathname === '/saves') return writeJson(res, 200, ok({ saves: listSaves(parsed.searchParams.get('dir') || undefined) }));
  if (method === 'GET' && pathname === '/stream') return openTickStream(req, res, api);

  const playerMatch = pathname.match(/^\/players\/([^/]+)$/);
  if (method === 'GET' && playerMatch) return writeJson(res, 200, ok(queryWorld(api.getWorld(), { type: 'player', playerId: decodeURIComponent(playerMatch[1]) })));

  const offlineMatch = pathname.match(/^\/offline\/([^/]+)$/);
  if (method === 'GET' && offlineMatch) {
    const playerId = decodeURIComponent(offlineMatch[1]);
    return writeJson(res, 200, ok({ playerId, offlineCommands: getPlayerOfflineCommands(api.getWorld(), playerId, { limit: 50 }) }));
  }

  if (method === 'POST' && pathname === '/players') {
    const body = await readJsonBody(req, options);
    const result = createPlayerWithCharacter(api.getWorld(), body || {});
    return writeJson(res, 201, ok(result));
  }

  if (method === 'POST' && pathname === '/commands') {
    const body = await readJsonBody(req, options);
    const playerId = requiredBody(body, 'playerId');
    const command = body.command || body;
    const result = executePlayerCommand(api.getWorld(), playerId, command, body.options || {});
    return writeJson(res, result.result.ok ? 200 : 400, ok(result));
  }

  if (method === 'POST' && pathname === '/offline') {
    const body = await readJsonBody(req, options);
    const playerId = requiredBody(body, 'playerId');
    const command = scheduleOfflineCommand(api.getWorld(), playerId, body.command || body, body.options || {});
    return writeJson(res, 201, ok(command));
  }

  if (method === 'POST' && pathname === '/tick') {
    const body = await readJsonBody(req, options);
    const ticks = Math.max(1, Number(body.ticks || 1));
    const runtime = createWorldRuntime(api.getWorld(), { maxTicks: ticks, tickBatch: 1, ...(body.runtime || {}) });
    const summary = runWorldRuntime(runtime, body.options || {});
    api.broadcast({ type: 'tick', worldId: api.getWorld().id, tick: api.getWorld().tick, summary });
    return writeJson(res, 200, ok(summary));
  }

  if (method === 'POST' && pathname === '/runtime/run') {
    const body = await readJsonBody(req, options);
    const runtime = createWorldRuntime(api.getWorld(), { ...(body.runtime || body || {}) });
    const summary = runWorldRuntime(runtime, body.options || {});
    api.broadcast({ type: 'runtime', worldId: api.getWorld().id, tick: api.getWorld().tick, summary });
    return writeJson(res, 200, ok(summary));
  }

  if (method === 'POST' && pathname === '/save') {
    const body = await readJsonBody(req, options);
    const filePath = body.filePath || body.path || options.defaultSavePath;
    const save = saveWorld(api.getWorld(), filePath, body.options || {});
    return writeJson(res, 200, ok(save));
  }

  if (method === 'POST' && pathname === '/load') {
    const body = await readJsonBody(req, options);
    const filePath = body.filePath || body.path || options.defaultSavePath;
    const loaded = loadWorld(filePath, body.options || {});
    api.setWorld(loaded.world);
    api.broadcast({ type: 'load', worldId: loaded.worldId, tick: loaded.tick });
    return writeJson(res, 200, ok({ file: loaded.file, worldId: loaded.worldId, tick: loaded.tick, savedAt: loaded.savedAt }));
  }

  return writeJson(res, 404, { ok: false, error: 'not_found', path: pathname });
}

function openTickStream(req, res, api) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  const stream = { res };
  api.streams?.add?.(stream);
  if (api.broadcast && !api.streams) {
    // no-op compatibility branch
  }
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, worldId: api.getWorld().id, tick: api.getWorld().tick })}\n\n`);
  const keepAlive = setInterval(() => {
    try { res.write(`event: ping\ndata: ${JSON.stringify({ tick: api.getWorld().tick })}\n\n`); } catch (_) {}
  }, 15000);
  const streams = findStreams(api);
  streams.add(stream);
  req.on('close', () => {
    clearInterval(keepAlive);
    streams.delete(stream);
  });
}

function findStreams(api) {
  if (!api.__streams) api.__streams = new Set();
  return api.__streams;
}

function broadcast(streamsOrApi, event) {
  const streams = streamsOrApi instanceof Set ? streamsOrApi : findStreams(streamsOrApi);
  const payload = `event: ${event.type || 'message'}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const stream of [...streams]) {
    try { stream.res.write(payload); } catch (_) { streams.delete(stream); }
  }
}

async function readJsonBody(req, options = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > (options.maxBodyBytes || DEFAULT_API_OPTIONS.maxBodyBytes)) throw new Error('request_body_too_large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function requiredBody(body, key) {
  if (!body || body[key] === undefined || body[key] === null || body[key] === '') throw new Error(`Request body requires ${key}`);
  return body[key];
}

function health(world) {
  return { ok: true, worldId: world.id, tick: world.tick, players: Object.keys(world.players?.byId || {}).length };
}

function ok(data) { return { ok: true, data }; }
function normalizePath(value) { return String(value || '/').replace(/\/+$/, '') || '/'; }
function setCors(res) { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); }
function writeJson(res, statusCode, payload) { res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(payload, null, 2)); }
function end(res, statusCode, text) { res.writeHead(statusCode); res.end(text); }

module.exports = {
  DEFAULT_API_OPTIONS,
  createWorldApiServer,
  buildDefaultApiWorld,
  handleApiRequest,
  readJsonBody,
};
