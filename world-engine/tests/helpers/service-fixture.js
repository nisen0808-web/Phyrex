'use strict';
const { createWorld, registerLocation } = require('../../core/world-engine');
const { createPlayer, createPlayerCharacter } = require('../../core/player-engine');
const { createAccount, createSession } = require('../../core/account-session-engine');
function fixture() {
  const world = createWorld({ id: 'service-world', seed: 'service' });
  registerLocation(world, { id: 'home', name: 'Home', meta: { secret: 'location-secret' } });
  createPlayer(world, { id: 'one', name: 'One', meta: { secret: 'player-secret' } });
  createPlayerCharacter(world, 'one', { id: 'character', locationId: 'home', stats: { secretStat: 987654321 } });
  createPlayer(world, { id: 'two' });
  createAccount(world, { id: 'owner', roles: ['player'], playerIds: ['one'] });
  createAccount(world, { id: 'operator', roles: ['admin'] });
  createSession(world, 'owner', { token: 'owner-secret-token' });
  createSession(world, 'operator', { token: 'admin-secret-token' });
  const state = { world, revision: 1, closes: 0, enqueues: 0, headReads: 0, dbReady: true, audits: [] };
  const store = { provider: 'postgres', async summary() { return {}; },
    async loadWorld(id) { return id === world.id ? { world: JSON.parse(JSON.stringify(world)), revision: state.revision } : null; },
    async getWorldHead(id) { state.headReads++; if (!state.dbReady) throw new Error('secret-database-url'); return id === world.id ? { worldId: id, revision: state.revision, tick: world.tick } : null; },
    async enqueueCommand(input, options) { state.enqueues++; return { ...input, sequence: state.enqueues, status: 'pending', revision: options.expectedWorldRevision }; },
    async getCommand() { return null; }, async close() { state.closes++; } };
  const auditStore = { provider: 'postgres', async append(row) { state.audits.push(row); }, async close() {} };
  return { state, store, auditStore };
}
async function request(port, route, { token = 'owner-secret-token', method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
module.exports = { fixture, request };
