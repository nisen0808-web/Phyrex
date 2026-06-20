'use strict';

const assert = require('assert');
const http = require('http');
const { createWorldApiServer } = require('../core/api-server-engine');

async function main() {
  const { server } = createWorldApiServer(null, { seedTicks: 5, requireAuth: true });
  const base = await listen(server);

  try {
    const index = await requestText(base, 'GET', '/client');
    assert.strictEqual(index.statusCode, 200, 'client should load');
    assert.ok(index.text.includes('quickStartBtn'), 'client should include quick start');
    assert.ok(index.text.includes('autoTickToggle'), 'client should include auto tick control');
    assert.ok(index.text.includes('id="toast"'), 'client should include toast feedback');

    const app = await requestText(base, 'GET', '/client/app.js');
    assert.strictEqual(app.statusCode, 200, 'client app should load');
    assert.ok(app.text.includes("type: 'start_adventure'"), 'client should start adventure during onboarding');
    assert.ok(app.text.includes('actionNeedsTick'), 'client should support action auto tick');
    assert.ok(app.text.includes('cancel_offline'), 'client should support offline cancellation');

    const css = await requestText(base, 'GET', '/client/style.css');
    assert.strictEqual(css.statusCode, 200, 'client css should load');
    assert.ok(css.text.includes('.tutorial-hint'), 'client css should style tutorial hints');
    assert.ok(css.text.includes('.toast'), 'client css should style toast feedback');

    await requestJson(base, 'POST', '/accounts', {
      id: 'onboarding_account',
      name: 'Onboarding Account',
      roles: ['player'],
    });
    const session = await requestJson(base, 'POST', '/sessions', {
      accountId: 'onboarding_account',
    });
    const headers = bearer(session.data.token);

    await requestJson(base, 'POST', '/accounts/onboarding_account/players', {
      player: { id: 'onboarding_player', name: 'Onboarding Player' },
      character: {
        id: 'onboarding_hero',
        name: 'Onboarding Hero',
        species: 'human',
        locationId: 'qingyun_city',
        stats: {
          health: 80,
          maxHealth: 100,
          energy: 100,
          maxEnergy: 100,
          power: 10,
          defense: 5,
          social: 50,
        },
        resources: { currency: 100, food: 10 },
        demographics: { age: 18, generation: 1 },
      },
    }, headers);

    let action = await browserAction(base, 'onboarding_player', {
      type: 'start_adventure',
    }, headers);

    let dashboard = action.data.dashboard;
    assert.strictEqual(action.data.type, 'start_adventure', 'start adventure action should be returned');
    assert.strictEqual(dashboard.player.tutorial.tutorial.status, 'active', 'tutorial should become active');
    assert.ok(
      dashboard.inventory.items.some(item => item.definitionId === 'wooden_sword'),
      'starter wooden sword should be granted',
    );
    assert.ok(
      dashboard.inventory.items.some(item => item.definitionId === 'healing_pill' && item.quantity >= 2),
      'starter healing pills should be granted',
    );
    assert.ok(dashboard.quests.quests.some(quest => quest.tags.includes('tutorial')), 'tutorial quests should be seeded');

    const itemCount = dashboard.inventory.items.length;
    action = await browserAction(base, 'onboarding_player', {
      type: 'start_adventure',
    }, headers);
    dashboard = action.data.dashboard;
    assert.strictEqual(dashboard.inventory.items.length, itemCount, 'start adventure should not duplicate starter items');

    const queued = await requestJson(base, 'POST', '/offline', {
      playerId: 'onboarding_player',
      command: {
        type: 'train',
        amount: 1,
        durationTicks: 10,
        runsEveryTicks: 2,
        repeat: 5,
      },
    }, headers);
    assert.strictEqual(queued.data.status, 'queued', 'offline command should be queued');

    action = await browserAction(base, 'onboarding_player', {
      type: 'cancel_offline',
      offlineCommandId: queued.data.id,
    }, headers);
    assert.strictEqual(action.data.result.status, 'cancelled', 'offline command should be cancelled');
    assert.ok(
      action.data.dashboard.offline.offlineCommands.some(command => command.id === queued.data.id && command.status === 'cancelled'),
      'dashboard should show cancelled offline command',
    );

    action = await browserAction(base, 'onboarding_player', {
      type: 'command',
      command: { type: 'work', resource: 'currency', amount: 5 },
    }, headers);
    assert.strictEqual(action.data.result.command.status, 'accepted', 'browser command should be accepted');
    assert.ok(action.data.dashboard.player.tutorial.nextHint, 'dashboard should include tutorial next hint');

    console.log('browser onboarding integration test passed');
  } finally {
    await close(server);
  }
}

function browserAction(base, playerId, action, headers) {
  return requestJson(
    base,
    'POST',
    `/players/${encodeURIComponent(playerId)}/actions`,
    action,
    headers,
  );
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function requestText(base, method, pathname, body = null, extraHeaders = {}) {
  const url = new URL(pathname, base);
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
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function requestJson(base, method, pathname, body = null, extraHeaders = {}) {
  const result = await requestText(base, method, pathname, body, extraHeaders);
  let json;
  try {
    json = JSON.parse(result.text || '{}');
  } catch (error) {
    throw new Error(`Invalid JSON from ${method} ${pathname}: ${result.text}`);
  }
  if (result.statusCode >= 400) {
    throw new Error(`HTTP ${result.statusCode}: ${JSON.stringify(json)}`);
  }
  return json;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
