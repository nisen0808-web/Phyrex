'use strict';

const assert = require('assert');
const http = require('http');
const { createWorldApiServer } = require('../core/api-server-engine');

async function main() {
  const { server } = createWorldApiServer(null, { seedTicks: 5 });
  const base = await listen(server);
  try {
    const root = await request(base, 'GET', '/');
    assert.strictEqual(root.statusCode, 200, 'root should serve client index');
    assert.ok(root.text.includes('MUD 世界模拟器'), 'index should include title');

    const index = await request(base, 'GET', '/client');
    assert.strictEqual(index.statusCode, 200, '/client should serve index');
    assert.ok(index.text.includes('/client/app.js'), 'index should reference app.js');
    assert.ok(index.text.includes('/client/style.css'), 'index should reference style.css');
    assert.ok(index.text.includes('characterPanel'), 'index should include character panel');
    assert.ok(index.text.includes('inventoryPanel'), 'index should include inventory panel');
    assert.ok(index.text.includes('shopPanel'), 'index should include shop panel');
    assert.ok(index.text.includes('journalPanel'), 'index should include journal panel');

    const app = await request(base, 'GET', '/client/app.js');
    assert.strictEqual(app.statusCode, 200, 'app.js should be served');
    assert.ok(app.headers['content-type'].includes('application/javascript'), 'app.js content type should be js');
    assert.ok(app.text.includes('createAccount'), 'app.js should include createAccount');
    assert.ok(app.text.includes('loadPanels'), 'app.js should include loadPanels');
    assert.ok(app.text.includes('renderInventory'), 'app.js should render inventory');
    assert.ok(app.text.includes('connectWs'), 'app.js should include websocket client');

    const css = await request(base, 'GET', '/client/style.css');
    assert.strictEqual(css.statusCode, 200, 'style.css should be served');
    assert.ok(css.headers['content-type'].includes('text/css'), 'style.css content type should be css');
    assert.ok(css.text.includes('.mini-card'), 'css should include mini-card style');
    assert.ok(css.text.includes('.timeline'), 'css should include timeline style');

    const missing = await request(base, 'GET', '/client/not-found.js');
    assert.strictEqual(missing.statusCode, 404, 'missing client asset should be 404');

    const traversal = await request(base, 'GET', '/client/../package.json');
    assert.ok([403, 404].includes(traversal.statusCode), 'path traversal should not expose package.json');

    const health = await requestJson(base, 'GET', '/health');
    assert.strictEqual(health.ok, true, 'health should still work');
    const world = await requestJson(base, 'GET', '/world');
    assert.strictEqual(world.ok, true, 'world endpoint should still work');

    await requestJson(base, 'POST', '/accounts', { id: 'client_test_account', name: 'Client Test', roles: ['player'] });
    await requestJson(base, 'POST', '/sessions', { accountId: 'client_test_account' });
    const created = await requestJson(base, 'POST', '/accounts/client_test_account/players', {
      player: { id: 'client_test_player', name: 'Client Test Player' },
      character: {
        id: 'client_test_hero',
        name: 'Client Test Hero',
        species: 'human',
        locationId: 'qingyun_city',
        stats: { health: 90, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10, social: 50 },
        resources: { currency: 100, food: 10 },
        demographics: { age: 18, generation: 1 },
      },
    });
    assert.strictEqual(created.ok, true, 'player creation should work');

    const player = await requestJson(base, 'GET', '/players/client_test_player');
    assert.strictEqual(player.ok, true, 'player view should work');
    assert.ok(player.data.inventory, 'player view should include inventory');
    assert.ok(player.data.shop, 'player view should include shop');

    const endpoints = ['inventory', 'quests', 'journal', 'map', 'shop', 'board', 'encounters', 'offline'];
    for (const endpoint of endpoints) {
      const detail = await requestJson(base, 'GET', `/players/client_test_player/${endpoint}`);
      assert.strictEqual(detail.ok, true, `detail endpoint ${endpoint} should work`);
      assert.ok(detail.data !== undefined, `detail endpoint ${endpoint} should return data`);
    }

    console.log('local browser client test passed');
  } finally {
    await close(server);
  }
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function request(base, method, path, body = null) {
  const url = new URL(path, base);
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function requestJson(base, method, path, body = null) {
  const result = await request(base, method, path, body);
  if (result.statusCode >= 400) throw new Error(`HTTP ${result.statusCode}: ${result.text}`);
  return JSON.parse(result.text || '{}');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
