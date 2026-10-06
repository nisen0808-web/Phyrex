'use strict';
// Browser/API fixture only. No SQL connection, live world or production token.
const { inventoryFixture, grantItem } = require('./inventory-fixture');
const { createAccount, createSession } = require('../../core/account-session-engine');
const { executePlayerCommand } = require('../../core/command-engine');
const { advanceWorld } = require('../../core/world-engine');
const { createDurableCommandApiServer } = require('../../core/durable-command-api-engine');
const clone = value => JSON.parse(JSON.stringify(value));
async function consoleFixture() {
  const world = inventoryFixture(); world.id = 'console-test'; world.locations.home.name = '临溪村';
  world.entities['hero-one'].name = '岚'; world.players.byId.one.name = '测试玩家';
  world.shops.byId.market.name = '临溪杂货铺';
  world.entities['hero-one'].stats.health = 72;
  grantItem(world, 'entity', 'hero-one', 'healing_pill', 2);
  createAccount(world, { id: 'owner', roles: ['player'], playerIds: ['one'] });
  createAccount(world, { id: 'operator', roles: ['admin'] });
  createSession(world, 'owner', { token: 'console-player-fixture' });
  createSession(world, 'operator', { token: 'console-admin-fixture' });
  const rows = [], audits = []; let revision = 1;
  const error = code => Object.assign(new Error(code), { code });
  const store = { provider: 'postgres', async summary() { return {}; }, async close() {},
    async loadWorld(id) { return id === world.id ? { world: clone(world), revision } : null; },
    async getWorldHead() { return { revision, tick: world.tick }; },
    async enqueueCommand(input) {
      const existing = rows.find(row => row.id === input.id);
      if (existing) { if (JSON.stringify(existing.input) !== JSON.stringify(input.input)) throw error('WORLD_DB_IDEMPOTENCY_CONFLICT'); return { ...clone(existing), idempotent: true }; }
      const row = { ...clone(input), sequence: rows.length + 1, status: 'pending', submittedAt: new Date().toISOString() }; rows.push(row); return clone(row);
    },
    async getCommand(_world, id) { const row = rows.find(row => row.id === id); return row ? clone(row) : null; },
    async listCommandReceipts(query) { return { revision, records: clone(rows.filter(row => row.playerId === query.playerId && (!query.beforeSequence || row.sequence < query.beforeSequence)).reverse().slice(0, query.limit)) }; },
    async getCommandQueue() { return { worldId: world.id, revision, pending: rows.filter(row => row.status === 'pending').length, pendingIsLowerBound: false, worldCapacityAvailable: true, limits: { maxPendingCommands: 100, maxPendingPerPlayer: 20 } }; },
  };
  const auditStore = { provider: 'postgres', async close() {},
    async append(row) { audits.push({ ...row, sequence: audits.length + 1, createdAt: new Date().toISOString() }); },
    async list(query) { return audits.filter(row => (!query.beforeSequence || row.sequence < query.beforeSequence) && ['statusCode', 'route', 'playerId'].every(key => query[key] === undefined || row[key] === query[key])).reverse().slice(0, query.limit); },
  };
  function step() {
    for (const row of rows.filter(row => row.status === 'pending')) {
      const command = executePlayerCommand(world, row.playerId, { ...row.input, id: row.id }, { publicPlayer: true }).command;
      advanceWorld(world); revision++;
      row.status = 'applied'; row.result = { id: command.id, type: command.type, status: command.status, outcome: clone(command.result), updatedAt: command.updatedAt }; row.appliedAt = new Date().toISOString();
    }
  }
  const api = await createDurableCommandApiServer({ store, auditStore, rateLimitNow: () => Date.now(), worldId: world.id, webConsole: true, health: async () => true,
    serviceStatus: () => ({ stopping: false, intervalMs: 1000, runtime: { status: 'running', ready: true,
      revision, tick: world.tick, heartbeatAgeMs: 0, heartbeatTimeoutMs: 30000, failures: 0, failureKind: null } }) });
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
  return { api, world, rows, audits, step, port: api.server.address().port };
}
if (require.main === module) consoleFixture().then(f => {
  if (process.argv.includes('--lose-first-response')) {
    let lost = false;
    f.api.server.on('request', (req, res) => {
      if (!lost && req.method === 'POST') { lost = true; res.end = () => { res.destroy(); return res; }; }
    });
  }
  console.log(`Isolated browser fixture: http://127.0.0.1:${f.port}`);
  const timer = setInterval(f.step, 1000);
  const close = async () => { clearInterval(timer); await f.api.close(); process.exit(); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { consoleFixture };
