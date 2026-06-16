'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createWorldApiServer } = require('../core/api-server-engine');
const { getAccountStats } = require('../core/account-session-engine');

async function main() {
  const savePath = path.join(__dirname, '..', 'output', 'account-session-api-save.json');
  const { server, api } = createWorldApiServer(null, { seedTicks: 5, defaultSavePath: savePath });
  const base = await listen(server);

  try {
    const account = await requestJson(base, 'POST', '/accounts', { id: 'api_account', name: 'API Account', roles: ['player'] });
    assert.strictEqual(account.ok, true, 'account creation should be ok');
    assert.strictEqual(account.data.id, 'api_account', 'account id should match');

    const session = await requestJson(base, 'POST', '/sessions', { accountId: 'api_account', options: { sessionTtlTicks: 100 } });
    assert.strictEqual(session.ok, true, 'session creation should be ok');
    assert.ok(session.data.token, 'session should return token');
    assert.strictEqual(session.data.account.id, 'api_account', 'session should include account view');
    assert.strictEqual(session.data.session.status, 'active', 'session should be active');
    assert.strictEqual(session.data.session.token, undefined, 'sanitized session should not expose token');

    const sessionCheck = await requestJson(base, 'GET', '/session', null, { Authorization: `Bearer ${session.data.token}` });
    assert.strictEqual(sessionCheck.ok, true, 'session validation should be ok');
    assert.strictEqual(sessionCheck.data.account.id, 'api_account', 'validated session should include account');

    const created = await requestJson(base, 'POST', '/accounts/api_account/players', {
      player: { id: 'account_player', name: 'Account Player' },
      character: {
        id: 'account_hero',
        name: 'Account Hero',
        species: 'human',
        locationId: 'qingyun_city',
        stats: { health: 90, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10, social: 50 },
        resources: { currency: 100, food: 10 },
        demographics: { age: 18, generation: 1 },
      },
    });
    assert.strictEqual(created.ok, true, 'account player creation should be ok');
    assert.strictEqual(created.data.player.id, 'account_player', 'created player id should match');
    assert.ok(created.data.account.playerIds.includes('account_player'), 'account should link player');

    const accountView = await requestJson(base, 'GET', '/accounts/api_account');
    assert.strictEqual(accountView.ok, true, 'account view should be ok');
    assert.ok(accountView.data.playerIds.includes('account_player'), 'account view should include linked player');
    assert.ok(accountView.data.players.some(player => player.id === 'account_player'), 'account view should include player summary');
    assert.ok(accountView.data.sessions.length >= 1, 'account view should include sessions');

    const command = await requestJson(base, 'POST', '/commands', { playerId: 'account_player', command: { type: 'work', resource: 'currency', amount: 5 } });
    assert.strictEqual(command.ok, true, 'command for account player should be ok');

    const offline = await requestJson(base, 'POST', '/offline', { playerId: 'account_player', command: { type: 'train', amount: 1, durationTicks: 2, runsEveryTicks: 1, repeat: 2 } });
    assert.strictEqual(offline.ok, true, 'offline command for account player should be queued');

    const tick = await requestJson(base, 'POST', '/tick', { ticks: 3 });
    assert.strictEqual(tick.ok, true, 'tick should be ok');
    assert.strictEqual(tick.data.status, 'idle', 'runtime tick should finish idle');

    const save = await requestJson(base, 'POST', '/save', { filePath: savePath, options: { createBackup: false } });
    assert.strictEqual(save.ok, true, 'save should be ok');
    assert.ok(fs.existsSync(savePath), 'save file should exist');

    const load = await requestJson(base, 'POST', '/load', { filePath: savePath });
    assert.strictEqual(load.ok, true, 'load should be ok');

    const loadedAccount = await requestJson(base, 'GET', '/accounts/api_account');
    assert.strictEqual(loadedAccount.ok, true, 'loaded account view should be ok');
    assert.ok(loadedAccount.data.playerIds.includes('account_player'), 'loaded account should preserve player link');

    const revoke = await requestJson(base, 'POST', '/sessions/revoke', { token: session.data.token, reason: 'test' });
    assert.strictEqual(revoke.ok, true, 'revoke should be ok');
    assert.strictEqual(revoke.data.session.status, 'revoked', 'session should be revoked');

    const invalidSession = await requestJsonAllowError(base, 'GET', '/session', null, { Authorization: `Bearer ${session.data.token}` });
    assert.strictEqual(invalidSession.statusCode, 401, 'revoked session should return 401');
    assert.strictEqual(invalidSession.body.ok, false, 'revoked session body should not be ok');

    const stats = getAccountStats(api.getWorld());
    assert.ok(stats.accounts >= 1, 'account stats should include account');
    assert.ok(stats.sessions >= 1, 'account stats should include session');
    assert.ok(stats.stats.playersLinked >= 1, 'account stats should count linked players');

    console.log('account session API integration test passed');
  } finally {
    await close(server);
  }
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
