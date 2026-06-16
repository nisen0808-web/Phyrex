'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createWorldApiServer } = require('../core/api-server-engine');

async function main() {
  const savePath = path.join(__dirname, '..', 'output', 'api-permission-save.json');
  const { server } = createWorldApiServer(null, { seedTicks: 5, defaultSavePath: savePath, requireAuth: true });
  const base = await listen(server);

  try {
    const playerAccount = await requestJson(base, 'POST', '/accounts', { id: 'player_account', name: 'Player Account', roles: ['player'] });
    assert.strictEqual(playerAccount.ok, true, 'player account should be created');

    const gmAccount = await requestJson(base, 'POST', '/accounts', { id: 'gm_account', name: 'GM Account', roles: ['gm'] });
    assert.strictEqual(gmAccount.ok, true, 'gm account should be created');

    const otherAccount = await requestJson(base, 'POST', '/accounts', { id: 'other_account', name: 'Other Account', roles: ['player'] });
    assert.strictEqual(otherAccount.ok, true, 'other account should be created');

    const playerSession = await requestJson(base, 'POST', '/sessions', { accountId: 'player_account' });
    const gmSession = await requestJson(base, 'POST', '/sessions', { accountId: 'gm_account' });
    const otherSession = await requestJson(base, 'POST', '/sessions', { accountId: 'other_account' });

    const playerToken = playerSession.data.token;
    const gmToken = gmSession.data.token;
    const otherToken = otherSession.data.token;

    const unauthCreate = await requestJsonAllowError(base, 'POST', '/accounts/player_account/players', playerPayload('denied_player', 'denied_hero'));
    assert.strictEqual(unauthCreate.statusCode, 401, 'unauthenticated account player creation should require auth');

    const created = await requestJson(base, 'POST', '/accounts/player_account/players', playerPayload('owned_player', 'owned_hero'), bearer(playerToken));
    assert.strictEqual(created.ok, true, 'player should create own account player');
    assert.strictEqual(created.data.player.id, 'owned_player', 'created owned player should match');

    const otherAccess = await requestJsonAllowError(base, 'GET', '/players/owned_player', null, bearer(otherToken));
    assert.strictEqual(otherAccess.statusCode, 403, 'other player account should not access owned player');

    const ownAccess = await requestJson(base, 'GET', '/players/owned_player', null, bearer(playerToken));
    assert.strictEqual(ownAccess.ok, true, 'owner should access own player');

    const gmAccess = await requestJson(base, 'GET', '/players/owned_player', null, bearer(gmToken));
    assert.strictEqual(gmAccess.ok, true, 'gm should access any player');

    const ownCommand = await requestJson(base, 'POST', '/commands', { playerId: 'owned_player', command: { type: 'work', resource: 'currency', amount: 5 } }, bearer(playerToken));
    assert.strictEqual(ownCommand.ok, true, 'owner should submit command for own player');

    const otherCommand = await requestJsonAllowError(base, 'POST', '/commands', { playerId: 'owned_player', command: { type: 'work', resource: 'currency', amount: 5 } }, bearer(otherToken));
    assert.strictEqual(otherCommand.statusCode, 403, 'other account should not submit command for owned player');

    const ownOffline = await requestJson(base, 'POST', '/offline', { playerId: 'owned_player', command: { type: 'train', amount: 1, durationTicks: 2, runsEveryTicks: 1, repeat: 2 } }, bearer(playerToken));
    assert.strictEqual(ownOffline.ok, true, 'owner should schedule offline command');

    const playerTick = await requestJsonAllowError(base, 'POST', '/tick', { ticks: 1 }, bearer(playerToken));
    assert.strictEqual(playerTick.statusCode, 403, 'normal player should not run world tick when auth enforced');

    const unauthTick = await requestJsonAllowError(base, 'POST', '/tick', { ticks: 1 });
    assert.strictEqual(unauthTick.statusCode, 401, 'unauthenticated tick should require auth');

    const gmTick = await requestJson(base, 'POST', '/tick', { ticks: 2 }, bearer(gmToken));
    assert.strictEqual(gmTick.ok, true, 'gm should run tick');
    assert.strictEqual(gmTick.data.status, 'idle', 'gm tick should finish idle');

    const playerSave = await requestJsonAllowError(base, 'POST', '/save', { filePath: savePath, options: { createBackup: false } }, bearer(playerToken));
    assert.strictEqual(playerSave.statusCode, 403, 'normal player should not save world when auth enforced');

    const gmSave = await requestJson(base, 'POST', '/save', { filePath: savePath, options: { createBackup: false } }, bearer(gmToken));
    assert.strictEqual(gmSave.ok, true, 'gm should save world');
    assert.ok(fs.existsSync(savePath), 'gm save should write file');

    const unauthSaves = await requestJsonAllowError(base, 'GET', `/saves?dir=${encodeURIComponent(path.dirname(savePath))}`);
    assert.strictEqual(unauthSaves.statusCode, 401, 'saves list should require auth when enforced');

    const gmSaves = await requestJson(base, 'GET', `/saves?dir=${encodeURIComponent(path.dirname(savePath))}`, null, bearer(gmToken));
    assert.strictEqual(gmSaves.ok, true, 'gm should list saves');
    assert.ok(gmSaves.data.saves.length >= 1, 'gm saves should include save file');

    const gmLoad = await requestJson(base, 'POST', '/load', { filePath: savePath }, bearer(gmToken));
    assert.strictEqual(gmLoad.ok, true, 'gm should load world');

    const loadedAccount = await requestJson(base, 'GET', '/accounts/player_account', null, bearer(playerToken));
    assert.strictEqual(loadedAccount.ok, true, 'owner should access account after load');
    assert.ok(loadedAccount.data.playerIds.includes('owned_player'), 'account player link should survive save/load');

    console.log('api permission integration test passed');
  } finally {
    await close(server);
  }
}

function playerPayload(playerId, entityId) {
  return {
    player: { id: playerId, name: playerId },
    character: {
      id: entityId,
      name: entityId,
      species: 'human',
      locationId: 'qingyun_city',
      stats: { health: 90, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10, social: 50 },
      resources: { currency: 100, food: 10 },
      demographics: { age: 18, generation: 1 },
    },
  };
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function requestJson(base, method, pathName, body = null, extraHeaders = {}) {
  return requestJsonAllowError(base, method, pathName, body, extraHeaders).then(result => {
    if (result.statusCode >= 400) throw new Error(`HTTP ${result.statusCode}: ${JSON.stringify(result.body)}`);
    return result.body;
  });
}

function requestJsonAllowError(base, method, pathName, body = null, extraHeaders = {}) {
  const url = new URL(pathName, base);
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const headers = { ...extraHeaders };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(url, { method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          const json = JSON.parse(text || '{}');
          resolve({ statusCode: res.statusCode, body: json });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
