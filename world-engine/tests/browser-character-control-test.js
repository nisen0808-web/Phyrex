'use strict';

const assert = require('assert');
const http = require('http');
const { createWorldApiServer } = require('../core/api-server-engine');

async function main() {
  const { server } = createWorldApiServer(null, { seedTicks: 5, requireAuth: true });
  const base = await listen(server);

  try {
    await requestJson(base, 'POST', '/accounts', {
      id: 'character_owner',
      name: 'Character Owner',
      roles: ['player'],
    });
    await requestJson(base, 'POST', '/accounts', {
      id: 'character_other',
      name: 'Character Other',
      roles: ['player'],
    });
    await requestJson(base, 'POST', '/accounts', {
      id: 'character_gm',
      name: 'Character GM',
      roles: ['gm'],
    });

    const ownerSession = await requestJson(base, 'POST', '/sessions', { accountId: 'character_owner' });
    const otherSession = await requestJson(base, 'POST', '/sessions', { accountId: 'character_other' });
    const gmSession = await requestJson(base, 'POST', '/sessions', { accountId: 'character_gm' });
    const ownerHeaders = bearer(ownerSession.data.token);
    const otherHeaders = bearer(otherSession.data.token);
    const gmHeaders = bearer(gmSession.data.token);

    await requestJson(base, 'POST', '/accounts/character_owner/players', {
      player: { id: 'character_player', name: 'Character Player' },
      character: {
        id: 'character_hero',
        name: 'Character Hero',
        species: 'human',
        locationId: 'qingyun_city',
        stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 12 },
        resources: { currency: 100, food: 10 },
        demographics: { age: 18, generation: 1 },
      },
    }, ownerHeaders);

    let dashboardResponse = await requestJson(
      base,
      'GET',
      '/players/character_player/dashboard',
      null,
      ownerHeaders,
    );
    let dashboard = dashboardResponse.data;
    assert.strictEqual(dashboard.account.id, 'character_owner', 'dashboard should include linked account');
    assert.ok(
      dashboard.account.playerIds.includes('character_player'),
      'dashboard account should include linked player',
    );
    assert.strictEqual(
      dashboard.player.controlledEntities.length,
      1,
      'new player should initially control one character',
    );
    assert.strictEqual(
      dashboard.player.player.activeEntityId,
      'character_hero',
      'initial character should be active',
    );

    let action = await browserAction(base, 'character_player', {
      type: 'create_character',
      character: {
        id: 'character_companion',
        name: 'Character Companion',
        species: 'human',
        locationId: 'mist_forest',
        active: false,
        stats: { power: 8 },
      },
    }, ownerHeaders);
    dashboard = action.data.dashboard;
    assert.strictEqual(
      dashboard.player.controlledEntities.length,
      2,
      'create_character should add a second controlled entity',
    );
    assert.strictEqual(
      dashboard.player.player.activeEntityId,
      'character_hero',
      'inactive character creation should preserve current character',
    );
    assert.strictEqual(action.data.result.active, false, 'created companion should not be active');

    const forbiddenSwitch = await requestJsonAllowError(
      base,
      'POST',
      '/players/character_player/actions',
      { type: 'switch_character', entityId: 'character_companion' },
      otherHeaders,
    );
    assert.strictEqual(forbiddenSwitch.statusCode, 403, 'other account should not switch characters');

    action = await browserAction(base, 'character_player', {
      type: 'switch_character',
      entityId: 'character_companion',
    }, ownerHeaders);
    dashboard = action.data.dashboard;
    assert.strictEqual(
      dashboard.player.player.activeEntityId,
      'character_companion',
      'switch_character should update active entity',
    );
    assert.strictEqual(
      dashboard.player.activeEntity.id,
      'character_companion',
      'dashboard should expose switched character',
    );
    assert.strictEqual(
      dashboard.map.currentLocationId,
      'mist_forest',
      'map should follow switched character',
    );

    action = await browserAction(base, 'character_player', {
      type: 'observer_mode',
      locationId: 'qingyun_city',
    }, ownerHeaders);
    dashboard = action.data.dashboard;
    assert.strictEqual(
      dashboard.player.player.controlMode,
      'observer',
      'observer action should change control mode',
    );
    assert.strictEqual(
      dashboard.player.player.observerLocationId,
      'qingyun_city',
      'observer action should store observation location',
    );
    assert.strictEqual(
      dashboard.map.currentLocationId,
      'qingyun_city',
      'map should use observer location while observing',
    );
    assert.strictEqual(dashboard.map.controlMode, 'observer', 'map should report observer mode');

    action = await browserAction(base, 'character_player', {
      type: 'switch_character',
      entityId: 'character_hero',
    }, gmHeaders);
    dashboard = action.data.dashboard;
    assert.strictEqual(
      dashboard.player.player.controlMode,
      'character',
      'switching a character should leave observer mode',
    );
    assert.strictEqual(
      dashboard.player.player.activeEntityId,
      'character_hero',
      'gm should be able to switch controlled character',
    );
    assert.strictEqual(
      dashboard.map.currentLocationId,
      'qingyun_city',
      'map should follow active character after leaving observer mode',
    );

    console.log('browser multi-character control integration test passed');
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

function requestJson(base, method, pathname, body = null, extraHeaders = {}) {
  return requestJsonAllowError(base, method, pathname, body, extraHeaders).then(result => {
    if (result.statusCode >= 400) {
      throw new Error(`HTTP ${result.statusCode}: ${JSON.stringify(result.body)}`);
    }
    return result.body;
  });
}

function requestJsonAllowError(base, method, pathname, body = null, extraHeaders = {}) {
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
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(text || '{}'),
          });
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
