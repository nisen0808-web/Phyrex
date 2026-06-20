'use strict';

const assert = require('assert');
const http = require('http');
const { createWorldApiServer } = require('../core/api-server-engine');

async function main() {
  const { server, api } = createWorldApiServer(null, { seedTicks: 5, requireAuth: true });
  const base = await listen(server);

  try {
    await requestJson(base, 'POST', '/accounts', {
      id: 'gameplay_account',
      name: 'Gameplay Account',
      roles: ['player'],
    });
    await requestJson(base, 'POST', '/accounts', {
      id: 'gameplay_other',
      name: 'Gameplay Other',
      roles: ['player'],
    });
    await requestJson(base, 'POST', '/accounts', {
      id: 'gameplay_gm',
      name: 'Gameplay GM',
      roles: ['gm'],
    });

    const session = await requestJson(base, 'POST', '/sessions', {
      accountId: 'gameplay_account',
    });
    const otherSession = await requestJson(base, 'POST', '/sessions', {
      accountId: 'gameplay_other',
    });
    const gmSession = await requestJson(base, 'POST', '/sessions', {
      accountId: 'gameplay_gm',
    });

    const headers = bearer(session.data.token);
    const otherHeaders = bearer(otherSession.data.token);
    const gmHeaders = bearer(gmSession.data.token);

    const created = await requestJson(base, 'POST', '/accounts/gameplay_account/players', {
      player: { id: 'gameplay_player', name: 'Gameplay Player' },
      character: {
        id: 'gameplay_hero',
        name: 'Gameplay Hero',
        species: 'human',
        locationId: 'qingyun_city',
        stats: {
          health: 50,
          maxHealth: 100,
          energy: 100,
          maxEnergy: 100,
          power: 10,
          defense: 5,
          social: 50,
        },
        resources: { currency: 500, food: 10 },
        demographics: { age: 18, generation: 1 },
      },
    }, headers);
    assert.strictEqual(created.ok, true, 'player should be created');

    const forbiddenDashboard = await requestJsonAllowError(
      base,
      'GET',
      '/players/gameplay_player/dashboard',
      null,
      otherHeaders,
    );
    assert.strictEqual(forbiddenDashboard.statusCode, 403, 'other account should not access dashboard');

    const forbiddenAction = await requestJsonAllowError(
      base,
      'POST',
      '/players/gameplay_player/actions',
      { type: 'explore' },
      otherHeaders,
    );
    assert.strictEqual(forbiddenAction.statusCode, 403, 'other account should not execute gameplay action');

    let dashboardResponse = await requestJson(
      base,
      'GET',
      '/players/gameplay_player/dashboard',
      null,
      headers,
    );
    let dashboard = dashboardResponse.data;
    assert.strictEqual(dashboard.player.player.id, 'gameplay_player', 'dashboard should include player');
    assert.ok(dashboard.map.current.neighbors.length >= 1, 'dashboard should include map exits');
    assert.ok(dashboard.board.items.length >= 1, 'dashboard should include board items');
    assert.ok(dashboard.shop.shops.length >= 1, 'dashboard should include shops');

    const gmDashboard = await requestJson(
      base,
      'GET',
      '/players/gameplay_player/dashboard',
      null,
      gmHeaders,
    );
    assert.strictEqual(gmDashboard.ok, true, 'gm should access player dashboard');

    const shop = dashboard.shop.shops.find(entry => {
      const ids = entry.stock.map(item => item.definitionId);
      return ids.includes('healing_pill') && ids.includes('wooden_sword');
    });
    assert.ok(shop, 'a shop should sell healing pills and wooden swords');

    let action = await browserAction(base, 'gameplay_player', {
      type: 'buy_item',
      shopId: shop.id,
      itemDefinitionId: 'healing_pill',
      quantity: 2,
    }, headers);
    dashboard = action.data.dashboard;
    const pill = dashboard.inventory.items.find(item => item.definitionId === 'healing_pill');
    assert.ok(pill && pill.quantity >= 2, 'buy action should add healing pills');

    action = await browserAction(base, 'gameplay_player', {
      type: 'use_item',
      itemId: pill.id,
    }, headers);
    dashboard = action.data.dashboard;
    assert.ok(dashboard.player.activeEntity.stats.health > 50, 'use action should restore health');

    action = await browserAction(base, 'gameplay_player', {
      type: 'buy_item',
      shopId: shop.id,
      itemDefinitionId: 'wooden_sword',
      quantity: 1,
    }, headers);
    dashboard = action.data.dashboard;
    const sword = dashboard.inventory.items.find(item => item.definitionId === 'wooden_sword');
    assert.ok(sword, 'buy action should add sword');

    action = await browserAction(base, 'gameplay_player', {
      type: 'equip_item',
      itemId: sword.id,
    }, headers);
    dashboard = action.data.dashboard;
    assert.ok(dashboard.inventory.equipment.weapon, 'equip action should equip weapon');

    action = await browserAction(base, 'gameplay_player', {
      type: 'unequip_item',
      slotOrItemId: 'weapon',
    }, headers);
    dashboard = action.data.dashboard;
    assert.strictEqual(dashboard.inventory.equipment.weapon, null, 'unequip action should clear weapon slot');

    const currencyBeforeSell = dashboard.player.activeEntity.resources.currency;
    action = await browserAction(base, 'gameplay_player', {
      type: 'sell_item',
      itemId: sword.id,
      quantity: 1,
    }, headers);
    dashboard = action.data.dashboard;
    assert.ok(
      dashboard.player.activeEntity.resources.currency > currencyBeforeSell,
      'sell action should increase currency',
    );

    const boardItem = dashboard.board.items[0];
    action = await browserAction(base, 'gameplay_player', {
      type: 'accept_board_quest',
      boardItemId: boardItem.id,
    }, headers);
    dashboard = action.data.dashboard;
    const questId = action.data.result.quest.id;
    assert.ok(
      dashboard.quests.quests.some(quest => quest.id === questId),
      'accepted board quest should enter quest log',
    );

    action = await browserAction(base, 'gameplay_player', {
      type: 'explore',
    }, headers);
    dashboard = action.data.dashboard;
    assert.ok(dashboard.encounters.encounters.length >= 1, 'explore action should create encounter');
    assert.ok(dashboard.journal.entries.length >= 1, 'explore action should write journal');

    const destination = dashboard.map.current.neighbors[0].id;
    action = await browserAction(base, 'gameplay_player', {
      type: 'move',
      locationId: destination,
    }, headers);
    assert.ok(
      ['accepted', 'completed'].includes(action.data.result.command.status),
      'move action should submit command',
    );

    const playerTick = await requestJsonAllowError(
      base,
      'POST',
      '/tick',
      { ticks: 1 },
      headers,
    );
    assert.strictEqual(playerTick.statusCode, 403, 'normal player should not control world tick');

    const tick = await requestJson(base, 'POST', '/tick', { ticks: 3 }, gmHeaders);
    assert.strictEqual(tick.data.status, 'idle', 'gm tick should finish idle');

    dashboardResponse = await requestJson(
      base,
      'GET',
      '/players/gameplay_player/dashboard',
      null,
      headers,
    );
    dashboard = dashboardResponse.data;
    assert.strictEqual(
      dashboard.map.currentLocationId,
      destination,
      'move action should change location after tick',
    );

    const quest = api.getWorld().quests.byId[questId];
    quest.status = 'completed';
    quest.completedAt = api.getWorld().tick;

    action = await browserAction(base, 'gameplay_player', {
      type: 'claim_quest',
      questId,
    }, headers);
    assert.strictEqual(action.data.result.status, 'claimed', 'claim action should claim completed quest');

    action = await browserAction(base, 'gameplay_player', {
      type: 'claim_all_quests',
    }, headers);
    assert.ok(Array.isArray(action.data.result.claimed), 'claim all action should return claimed list');

    console.log('browser gameplay loop integration test passed');
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
