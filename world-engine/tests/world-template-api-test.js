'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createWorldApiServer } = require('../core/world-template-api-engine');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-template-api-'));
  const backupPath = path.join(directory, 'before-template-reset.json');
  const { server } = createWorldApiServer(null, {
    seedTicks: 3,
    requireAuth: true,
    runtimeLoop: { intervalMs: 10000, ticksPerCycle: 1 },
  });
  const base = await listen(server);

  try {
    await requestJson(base, 'POST', '/accounts', {
      id: 'template_player_account',
      name: 'Template Player',
      roles: ['player'],
    });
    await requestJson(base, 'POST', '/accounts', {
      id: 'template_gm_account',
      name: 'Template GM',
      roles: ['gm'],
    });

    const playerSession = await requestJson(base, 'POST', '/sessions', {
      accountId: 'template_player_account',
    });
    const gmSession = await requestJson(base, 'POST', '/sessions', {
      accountId: 'template_gm_account',
    });
    const playerHeaders = bearer(playerSession.data.token);
    const gmHeaders = bearer(gmSession.data.token);

    await requestJson(base, 'POST', '/accounts/template_player_account/players', {
      player: { id: 'template_player', name: 'Template Player' },
      character: {
        id: 'template_hero',
        name: 'Template Hero',
        species: 'human',
        locationId: 'qingyun_city',
      },
    }, playerHeaders);

    const forbidden = await requestJsonAllowError(
      base,
      'GET',
      '/admin/templates',
      null,
      playerHeaders,
    );
    assert.strictEqual(forbidden.statusCode, 403, 'player should not list world templates');

    const listed = await requestJson(base, 'GET', '/admin/templates', null, gmHeaders);
    assert.ok(listed.data.templates.length >= 3, 'template API should list built-in templates');
    const merchant = listed.data.templates.find(template => template.id === 'merchant_crossroads');
    assert.ok(merchant, 'merchant crossroads should be listed');
    assert.strictEqual(merchant.defaultLocationId, 'jade_harbor');
    assert.ok(Array.isArray(merchant.locations) && merchant.locations.length >= 4);
    assert.strictEqual(listed.data.current.id, 'demo-world');

    await requestJson(base, 'POST', '/admin/loop/start', {}, gmHeaders);
    const runningReset = await requestJsonAllowError(
      base,
      'POST',
      '/admin/templates/reset',
      {
        templateId: 'merchant_crossroads',
        worldId: 'merchant_api_world',
        seedTicks: 1,
      },
      gmHeaders,
    );
    assert.strictEqual(runningReset.statusCode, 409, 'running loop should require explicit pause');
    assert.strictEqual(runningReset.body.error, 'runtime_loop_running');

    const reset = await requestJson(base, 'POST', '/admin/templates/reset', {
      templateId: 'merchant_crossroads',
      worldId: 'merchant_api_world',
      seedTicks: 1,
      pauseLoop: true,
      backup: true,
      backupPath,
      preserveAccounts: true,
      preserveAudit: true,
    }, gmHeaders);
    assert.strictEqual(reset.data.world.id, 'merchant_api_world');
    assert.strictEqual(reset.data.world.template.id, 'merchant_crossroads');
    assert.ok(reset.data.world.tick >= 1);
    assert.strictEqual(reset.data.loop.status, 'paused');
    assert.strictEqual(reset.data.preserved.accounts, true);
    assert.strictEqual(reset.data.preserved.audit, true);
    assert.ok(fs.existsSync(backupPath), 'template reset should create backup');
    assert.strictEqual(reset.data.backup.file, path.resolve(backupPath));

    const gmSessionAfterReset = await requestJson(base, 'GET', '/session', null, gmHeaders);
    assert.strictEqual(gmSessionAfterReset.data.account.id, 'template_gm_account', 'GM session should survive reset');
    const playerSessionAfterReset = await requestJson(base, 'GET', '/session', null, playerHeaders);
    assert.deepStrictEqual(
      playerSessionAfterReset.data.account.playerIds,
      [],
      'preserved account should clear old player links',
    );

    const world = await requestJson(base, 'GET', '/world');
    assert.strictEqual(world.data.world.id, 'merchant_api_world');
    assert.strictEqual(world.data.world.tick, reset.data.world.tick);

    const recreated = await requestJson(
      base,
      'POST',
      '/accounts/template_player_account/players',
      {
        player: { id: 'template_player', name: 'Template Player' },
        character: {
          id: 'template_hero_reborn',
          name: 'Template Hero Reborn',
          species: 'human',
          locationId: merchant.defaultLocationId,
        },
      },
      playerHeaders,
    );
    assert.strictEqual(recreated.data.entity.locationId, 'jade_harbor');

    const dashboard = await requestJson(
      base,
      'GET',
      '/players/template_player/dashboard',
      null,
      playerHeaders,
    );
    assert.strictEqual(dashboard.data.player.activeEntity.locationId, 'jade_harbor');

    const refreshedTemplates = await requestJson(base, 'GET', '/admin/templates', null, gmHeaders);
    assert.strictEqual(refreshedTemplates.data.current.template.id, 'merchant_crossroads');
    assert.strictEqual(refreshedTemplates.data.current.template.resetFromWorldId, 'demo-world');

    const audit = await requestJson(base, 'GET', '/admin/audit?limit=200', null, gmHeaders);
    assert.ok(
      audit.data.log.some(entry => entry.path === '/admin/templates/reset' && entry.statusCode === 200),
      'template reset should be audited',
    );
    assert.ok(
      audit.data.log.some(entry => entry.path === '/admin/templates/reset' && entry.statusCode === 409),
      'rejected template reset should be audited',
    );

    const missing = await requestJsonAllowError(
      base,
      'POST',
      '/admin/templates/reset',
      { templateId: 'missing_template', pauseLoop: true },
      gmHeaders,
    );
    assert.strictEqual(missing.statusCode, 404);
    assert.strictEqual(missing.body.error, 'missing_world_template:missing_template');

    console.log('world template administration API integration test passed');
  } finally {
    await close(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

function requestJson(base, method, pathname, body = null, headers = {}) {
  return requestJsonAllowError(base, method, pathname, body, headers).then(result => {
    if (result.statusCode >= 400) {
      throw new Error(`HTTP ${result.statusCode}: ${JSON.stringify(result.body)}`);
    }
    return result.body;
  });
}

function requestJsonAllowError(base, method, pathname, body = null, headers = {}) {
  const url = new URL(pathname, base);
  const payload = body ? JSON.stringify(body) : null;
  const requestHeaders = { ...headers };
  if (payload) {
    requestHeaders['Content-Type'] = 'application/json';
    requestHeaders['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: requestHeaders }, res => {
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
