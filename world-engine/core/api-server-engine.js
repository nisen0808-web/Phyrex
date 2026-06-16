'use strict';

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { buildDemoWorld, runDemoWorld } = require('../demo/run-demo');
const { createPlayerWithCharacter } = require('./player-engine');
const { executePlayerCommand } = require('./command-engine');
const { queryWorld } = require('./query-engine');
const { createWorldSnapshot } = require('./snapshot-engine');
const { scheduleOfflineCommand, getPlayerOfflineCommands } = require('./offline-command-engine');
const { createWorldRuntime, runWorldRuntime } = require('./runtime-engine');
const { saveWorld, loadWorld, listSaves } = require('./persistence-engine');
const { createAccount, createSession, validateSession, revokeSession, getAccountView, linkPlayerToAccount } = require('./account-session-engine');
const { canAccessAccount, canAccessPlayer, canRunWorldControl, requirePermission, requireSession } = require('./api-permission-engine');

const DEFAULT_API_OPTIONS = { port: 8790, host: '127.0.0.1', seedTicks: 10, maxBodyBytes: 1024 * 1024, defaultSavePath: 'world-engine/output/api-world-save.json', requireAuth: false };

function createWorldApiServer(worldInput = null, options = {}) {
  const opts = { ...DEFAULT_API_OPTIONS, ...(options || {}) };
  let world = worldInput || buildDefaultApiWorld(opts);
  const streams = new Set();
  const sockets = new Set();
  const api = { streams, sockets, getWorld: () => world, setWorld: next => { world = next; return world; }, broadcast: event => broadcastAll(streams, sockets, event) };
  const server = http.createServer(async (req, res) => { try { await handleApiRequest(req, res, api, opts); } catch (error) { writeJson(res, error.statusCode || 500, { ok: false, error: error.message || 'api_error' }); } });
  server.on('upgrade', (req, socket) => handleWebSocketUpgrade(req, socket, api));
  server.on('clientError', (_err, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  return { server, api, options: opts, streams, sockets };
}

function buildDefaultApiWorld(options = {}) { const world = buildDemoWorld(); runDemoWorld(world, Number(options.seedTicks || 10), { autoNovel: false, autoNarrative: false, population: { baseBirthChance: 0, baseMortalityChance: 0 } }); return world; }

async function handleApiRequest(req, res, api, options) {
  setCors(res);
  if (req.method === 'OPTIONS') return end(res, 204, '');
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = normalizePath(parsed.pathname);
  const method = req.method || 'GET';
  const auth = getRequestAuth(api.getWorld(), req, parsed);

  if (method === 'GET' && pathname === '/health') return writeJson(res, 200, health(api.getWorld(), api));
  if (method === 'GET' && pathname === '/world') return writeJson(res, 200, ok(queryWorld(api.getWorld(), { type: 'world' })));
  if (method === 'GET' && pathname === '/snapshot') return writeJson(res, 200, ok(createWorldSnapshot(api.getWorld())));
  if (method === 'GET' && pathname === '/saves') { requireWorldControlIfNeeded(options, auth); return writeJson(res, 200, ok({ saves: listSaves(parsed.searchParams.get('dir') || undefined) })); }
  if (method === 'GET' && pathname === '/stream') return openTickStream(req, res, api);

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
    api.broadcast({ type: 'account.player.created', worldId: api.getWorld().id, tick: api.getWorld().tick, accountId, playerId: result.player.id, entityId: result.entity.id });
    return writeJson(res, 201, ok({ account: getAccountView(api.getWorld(), accountId), player: result.player, entity: result.entity }));
  }

  if (method === 'POST' && pathname === '/sessions') { const body = await readJsonBody(req, options); const accountId = requiredBody(body, 'accountId'); const session = createSession(api.getWorld(), accountId, body.options || {}); api.broadcast({ type: 'session.created', worldId: api.getWorld().id, tick: api.getWorld().tick, accountId, sessionId: session.id }); return writeJson(res, 201, ok({ token: session.token, session: sanitizeSessionForApi(session), account: getAccountView(api.getWorld(), accountId) })); }
  if (method === 'GET' && pathname === '/session') { return writeJson(res, auth ? 200 : 401, auth ? ok({ session: sanitizeSessionForApi(auth.session), account: getAccountView(api.getWorld(), auth.account.id) }) : { ok: false, error: 'invalid_session' }); }
  if (method === 'POST' && pathname === '/sessions/revoke') { const body = await readJsonBody(req, options); const token = body.token || bearerToken(req); const session = revokeSession(api.getWorld(), token, body.reason || 'api_revoke'); return writeJson(res, session ? 200 : 404, session ? ok({ session: sanitizeSessionForApi(session) }) : { ok: false, error: 'missing_session' }); }

  const playerMatch = pathname.match(/^\/players\/([^/]+)$/);
  if (method === 'GET' && playerMatch) { const playerId = decodeURIComponent(playerMatch[1]); requirePlayerAccessIfNeeded(options, auth, playerId); return writeJson(res, 200, ok(queryWorld(api.getWorld(), { type: 'player', playerId }))); }

  const offlineMatch = pathname.match(/^\/offline\/([^/]+)$/);
  if (method === 'GET' && offlineMatch) { const playerId = decodeURIComponent(offlineMatch[1]); requirePlayerAccessIfNeeded(options, auth, playerId); return writeJson(res, 200, ok({ playerId, offlineCommands: getPlayerOfflineCommands(api.getWorld(), playerId, { limit: 50 }) })); }

  if (method === 'POST' && pathname === '/players') { const body = await readJsonBody(req, options); if (body.accountId) requireAccountAccessIfNeeded(options, auth, body.accountId); const result = createPlayerWithCharacter(api.getWorld(), body || {}); if (body.accountId) linkPlayerToAccount(api.getWorld(), body.accountId, result.player.id); api.broadcast({ type: 'player.created', worldId: api.getWorld().id, tick: api.getWorld().tick, playerId: result.player.id, entityId: result.entity.id }); return writeJson(res, 201, ok(result)); }
  if (method === 'POST' && pathname === '/commands') { const body = await readJsonBody(req, options); const playerId = requiredBody(body, 'playerId'); requirePlayerAccessIfNeeded(options, auth, playerId); const command = body.command || body; const result = executePlayerCommand(api.getWorld(), playerId, command, body.options || {}); api.broadcast({ type: 'command', worldId: api.getWorld().id, tick: api.getWorld().tick, playerId, commandId: result.command.id, status: result.command.status }); return writeJson(res, result.result.ok ? 200 : 400, ok(result)); }
  if (method === 'POST' && pathname === '/offline') { const body = await readJsonBody(req, options); const playerId = requiredBody(body, 'playerId'); requirePlayerAccessIfNeeded(options, auth, playerId); const command = scheduleOfflineCommand(api.getWorld(), playerId, body.command || body, body.options || {}); api.broadcast({ type: 'offline.queued', worldId: api.getWorld().id, tick: api.getWorld().tick, playerId, offlineCommandId: command.id }); return writeJson(res, 201, ok(command)); }
  if (method === 'POST' && pathname === '/tick') { requireWorldControlIfNeeded(options, auth); const body = await readJsonBody(req, options); const ticks = Math.max(1, Number(body.ticks || 1)); const runtime = createWorldRuntime(api.getWorld(), { maxTicks: ticks, tickBatch: 1, ...(body.runtime || {}) }); const summary = runWorldRuntime(runtime, body.options || {}); api.broadcast({ type: 'tick', worldId: api.getWorld().id, tick: api.getWorld().tick, summary }); return writeJson(res, 200, ok(summary)); }
  if (method === 'POST' && pathname === '/runtime/run') { requireWorldControlIfNeeded(options, auth); const body = await readJsonBody(req, options); const runtime = createWorldRuntime(api.getWorld(), { ...(body.runtime || body || {}) }); const summary = runWorldRuntime(runtime, body.options || {}); api.broadcast({ type: 'runtime', worldId: api.getWorld().id, tick: api.getWorld().tick, summary }); return writeJson(res, 200, ok(summary)); }
  if (method === 'POST' && pathname === '/save') { requireWorldControlIfNeeded(options, auth); const body = await readJsonBody(req, options); const filePath = body.filePath || body.path || options.defaultSavePath; const save = saveWorld(api.getWorld(), filePath, body.options || {}); api.broadcast({ type: 'save', worldId: api.getWorld().id, tick: api.getWorld().tick, file: save.file }); return writeJson(res, 200, ok(save)); }
  if (method === 'POST' && pathname === '/load') { requireWorldControlIfNeeded(options, auth); const body = await readJsonBody(req, options); const filePath = body.filePath || body.path || options.defaultSavePath; const loaded = loadWorld(filePath, body.options || {}); api.setWorld(loaded.world); api.broadcast({ type: 'load', worldId: loaded.worldId, tick: loaded.tick }); return writeJson(res, 200, ok({ file: loaded.file, worldId: loaded.worldId, tick: loaded.tick, savedAt: loaded.savedAt })); }
  return writeJson(res, 404, { ok: false, error: 'not_found', path: pathname });
}

function getRequestAuth(world, req, parsed = null) { const token = bearerToken(req) || parsed?.searchParams?.get('token') || null; return token ? validateSession(world, token) : null; }
function requireAccountAccessIfNeeded(options, auth, accountId) { if (!options.requireAuth) return; const sessionAuth = requireSession(auth); requirePermission(canAccessAccount(sessionAuth.account, accountId), 'account_forbidden'); }
function requirePlayerAccessIfNeeded(options, auth, playerId) { if (!options.requireAuth) return; const sessionAuth = requireSession(auth); requirePermission(canAccessPlayer(sessionAuth.account, playerId), 'player_forbidden'); }
function requireWorldControlIfNeeded(options, auth) { if (!options.requireAuth) return; const sessionAuth = requireSession(auth); requirePermission(canRunWorldControl(sessionAuth.account), 'world_control_forbidden'); }

function openTickStream(req, res, api) { res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' }); const stream = { res }; api.streams.add(stream); res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, protocol: 'sse', worldId: api.getWorld().id, tick: api.getWorld().tick })}\n\n`); const keepAlive = setInterval(() => { try { res.write(`event: ping\ndata: ${JSON.stringify({ tick: api.getWorld().tick })}\n\n`); } catch (_) {} }, 15000); req.on('close', () => { clearInterval(keepAlive); api.streams.delete(stream); }); }
function handleWebSocketUpgrade(req, socket, api) { const parsed = new URL(req.url, 'http://localhost'); if (parsed.pathname !== '/ws/ticks') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; } const key = req.headers['sec-websocket-key']; if (!key) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; } const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64'); socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '\r\n'].join('\r\n')); api.sockets.add(socket); socket.on('close', () => api.sockets.delete(socket)); socket.on('error', () => api.sockets.delete(socket)); sendWebSocketJson(socket, { type: 'hello', protocol: 'websocket', worldId: api.getWorld().id, tick: api.getWorld().tick }); }
function broadcastAll(streams, sockets, event) { broadcastSse(streams, event); broadcastWebSockets(sockets, event); }
function broadcastSse(streams, event) { const payload = `event: ${event.type || 'message'}\ndata: ${JSON.stringify(event)}\n\n`; for (const stream of [...streams]) { try { stream.res.write(payload); } catch (_) { streams.delete(stream); } } }
function broadcastWebSockets(sockets, event) { for (const socket of [...sockets]) { try { sendWebSocketJson(socket, event); } catch (_) { sockets.delete(socket); socket.destroy(); } } }
function sendWebSocketJson(socket, value) { socket.write(encodeWebSocketTextFrame(JSON.stringify(value))); }
function encodeWebSocketTextFrame(text) { const payload = Buffer.from(String(text), 'utf8'); if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]); if (payload.length < 65536) { const header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); return Buffer.concat([header, payload]); } const header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); return Buffer.concat([header, payload]); }
async function readJsonBody(req, options = {}) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > (options.maxBodyBytes || DEFAULT_API_OPTIONS.maxBodyBytes)) throw new Error('request_body_too_large'); chunks.push(chunk); } if (!chunks.length) return {}; const text = Buffer.concat(chunks).toString('utf8'); if (!text.trim()) return {}; return JSON.parse(text); }
function requiredBody(body, key) { if (!body || body[key] === undefined || body[key] === null || body[key] === '') throw apiError(400, `Request body requires ${key}`); return body[key]; }
function bearerToken(req) { const value = req.headers.authorization || ''; const match = String(value).match(/^Bearer\s+(.+)$/i); return match ? match[1].trim() : null; }
function sanitizeSessionForApi(session) { return { id: session.id, accountId: session.accountId, status: session.status, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt, revokedAt: session.revokedAt || null }; }
function health(world, api = null) { return { ok: true, worldId: world.id, tick: world.tick, players: Object.keys(world.players?.byId || {}).length, accounts: Object.keys(world.accounts?.byId || {}).length, streams: api?.streams?.size || 0, sockets: api?.sockets?.size || 0 }; }
function apiError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
function ok(data) { return { ok: true, data }; }
function normalizePath(value) { return String(value || '/').replace(/\/+$/, '') || '/'; }
function setCors(res) { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization'); }
function writeJson(res, statusCode, payload) { res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(payload, null, 2)); }
function end(res, statusCode, text) { res.writeHead(statusCode); res.end(text); }

module.exports = { DEFAULT_API_OPTIONS, createWorldApiServer, buildDefaultApiWorld, handleApiRequest, readJsonBody, encodeWebSocketTextFrame };
