'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createProductionWorldApiServer } = require('../core/production-api-engine');
const {
  createRateLimiter,
  consumeRequestRate,
  formatPrometheusMetrics,
} = require('../core/operational-api-engine');
const { resolveProductionConfig } = require('../core/production-config-engine');

async function main() {
  testRateLimiter();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-operational-api-'));
  const operatorToken = 'operator-token-' + 'x'.repeat(40);
  const productionConfig = resolveProductionConfig({
    cwd: process.cwd(),
    args: {
      production: true,
      operatorToken,
      operatorAccountId: 'release_operator',
      dataDir,
      savePath: 'world.json',
      shutdownSave: 'shutdown.json',
      corsOrigins: 'https://mud.example',
      rateLimitMax: 100,
      authRateLimitMax: 20,
      releaseVersion: '0.1.0',
      releaseSha: 'release-test-sha',
    },
    env: {},
  });
  const { server, api } = createProductionWorldApiServer(null, {
    seedTicks: 3,
    productionConfig,
  });
  const base = await listen(server);
  const operatorHeaders = bearer(operatorToken);

  try {
    const live = await request(base, 'GET', '/livez');
    assert.strictEqual(live.statusCode, 200);
    assert.strictEqual(live.json.ok, true);
    assert.strictEqual(live.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(live.headers['x-frame-options'], 'DENY');
    assert.ok(live.headers['content-security-policy'].includes("default-src 'self'"));
    assert.ok(live.headers['x-request-id']);

    const ready = await request(base, 'GET', '/readyz');
    assert.strictEqual(ready.statusCode, 200);
    assert.strictEqual(ready.json.ready, true);

    const version = await request(base, 'GET', '/version');
    assert.strictEqual(version.json.version, '0.1.0');
    assert.strictEqual(version.json.releaseSha, 'release-test-sha');
    assert.strictEqual(version.json.production, true);
    assert.strictEqual(version.json.authRequired, true);

    const disallowedOrigin = await request(base, 'GET', '/world', null, {
      Origin: 'https://evil.example',
    });
    assert.strictEqual(disallowedOrigin.statusCode, 403);
    assert.strictEqual(disallowedOrigin.json.error, 'cors_origin_forbidden');

    const allowedOrigin = await request(base, 'GET', '/world', null, {
      Origin: 'https://mud.example',
    });
    assert.strictEqual(allowedOrigin.statusCode, 200);
    assert.strictEqual(allowedOrigin.headers['access-control-allow-origin'], 'https://mud.example');

    const metricsDenied = await request(base, 'GET', '/metrics');
    assert.strictEqual(metricsDenied.statusCode, 401);
    const metrics = await request(base, 'GET', '/metrics', null, operatorHeaders);
    assert.strictEqual(metrics.statusCode, 200);
    assert.ok(metrics.text.includes('phyrex_world_tick'));
    assert.ok(metrics.text.includes('phyrex_build_info{version="0.1.0"'));

    const accountDenied = await request(base, 'POST', '/accounts', {
      id: 'public_account',
      name: 'Public Account',
    });
    assert.strictEqual(accountDenied.statusCode, 401);

    const account = await request(base, 'POST', '/accounts', {
      id: 'managed_player_account',
      name: 'Managed Player Account',
      roles: ['player'],
    }, operatorHeaders);
    assert.strictEqual(account.statusCode, 201);
    assert.strictEqual(account.json.data.id, 'managed_player_account');

    const playerSessionResponse = await request(base, 'POST', '/sessions', {
      accountId: 'managed_player_account',
    }, operatorHeaders);
    assert.strictEqual(playerSessionResponse.statusCode, 201);
    const playerToken = playerSessionResponse.json.data.token;
    const playerHeaders = bearer(playerToken);

    const rawPlayerDenied = await request(base, 'POST', '/players', {
      player: { id: 'unbound_player' },
      character: { id: 'unbound_hero', locationId: 'qingyun_city' },
    });
    assert.strictEqual(rawPlayerDenied.statusCode, 401);

    const playerCreated = await request(
      base,
      'POST',
      '/accounts/managed_player_account/players',
      playerPayload('managed_player', 'managed_hero'),
      playerHeaders,
    );
    assert.strictEqual(playerCreated.statusCode, 201);

    const streamDenied = await request(base, 'GET', '/stream');
    assert.strictEqual(streamDenied.statusCode, 401);

    const saved = await request(base, 'POST', '/save', {
      filePath: 'checkpoint.json',
      options: { createBackup: false },
    }, operatorHeaders);
    assert.strictEqual(saved.statusCode, 200);
    assert.ok(saved.json.data.file.startsWith(path.resolve(dataDir)));
    assert.ok(fs.existsSync(path.join(dataDir, 'checkpoint.json')));

    const backup = await request(base, 'POST', '/admin/backups', {
      filePath: 'manual-backup.json',
      reason: 'integration_test',
    }, operatorHeaders);
    assert.strictEqual(backup.statusCode, 201);
    assert.ok(fs.existsSync(path.join(dataDir, 'manual-backup.json')));

    const backups = await request(base, 'GET', '/admin/backups', null, operatorHeaders);
    assert.strictEqual(backups.statusCode, 200);
    assert.ok(backups.json.data.saves.some(item => item.name === 'manual-backup.json'));

    const restoreMismatch = await request(base, 'POST', '/admin/backups/restore', {
      filePath: 'manual-backup.json',
      confirmWorldId: 'wrong-world',
    }, operatorHeaders);
    assert.strictEqual(restoreMismatch.statusCode, 409);

    const maintenanceOn = await request(base, 'POST', '/admin/maintenance', {
      enabled: true,
      reason: 'integration_test',
    }, operatorHeaders);
    assert.strictEqual(maintenanceOn.statusCode, 200);
    assert.strictEqual(maintenanceOn.json.data.enabled, true);

    const notReady = await request(base, 'GET', '/readyz');
    assert.strictEqual(notReady.statusCode, 503);
    assert.ok(notReady.json.reasons.includes('maintenance'));

    const playerActionBlocked = await request(
      base,
      'POST',
      '/players/managed_player/actions',
      { type: 'explore' },
      playerHeaders,
    );
    assert.strictEqual(playerActionBlocked.statusCode, 503);
    assert.strictEqual(playerActionBlocked.json.error, 'service_in_maintenance');

    const maintenanceOff = await request(base, 'POST', '/admin/maintenance', {
      enabled: false,
    }, operatorHeaders);
    assert.strictEqual(maintenanceOff.statusCode, 200);
    assert.strictEqual(maintenanceOff.json.data.enabled, false);

    const playerAction = await request(
      base,
      'POST',
      '/players/managed_player/actions',
      { type: 'explore' },
      playerHeaders,
    );
    assert.strictEqual(playerAction.statusCode, 200);

    const config = await request(base, 'GET', '/admin/config', null, operatorHeaders);
    assert.strictEqual(config.statusCode, 200);
    assert.strictEqual(config.json.data.operatorToken, '[redacted]');
    assert.strictEqual(config.json.data.enabled, true);

    const generatedMetrics = formatPrometheusMetrics(api, api.operationalState, productionConfig);
    assert.ok(generatedMetrics.endsWith('\n'));
    assert.ok(generatedMetrics.includes('phyrex_maintenance_mode 0'));

    console.log('operational API integration test passed');
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function testRateLimiter() {
  const limiter = createRateLimiter({ windowMs: 60000, max: 2, authMax: 1 });
  const requestLike = {
    method: 'GET',
    socket: { remoteAddress: '127.0.0.9' },
  };
  const production = { enabled: true };
  assert.strictEqual(consumeRequestRate(limiter, requestLike, '/world', production, false).allowed, true);
  assert.strictEqual(consumeRequestRate(limiter, requestLike, '/world', production, false).allowed, true);
  assert.strictEqual(consumeRequestRate(limiter, requestLike, '/world', production, false).allowed, false);
  assert.strictEqual(consumeRequestRate(limiter, requestLike, '/livez', production, false).allowed, true);
}

function playerPayload(playerId, entityId) {
  return {
    player: { id: playerId, name: playerId },
    character: {
      id: entityId,
      name: entityId,
      species: 'human',
      locationId: 'qingyun_city',
      stats: { health: 100, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10 },
      resources: { currency: 100, food: 10 },
    },
  };
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function request(base, method, pathname, body = null, headers = {}) {
  const url = new URL(pathname, base);
  const payload = body === null ? null : JSON.stringify(body);
  const requestHeaders = { ...headers };
  if (payload !== null) {
    requestHeaders['Content-Type'] = 'application/json';
    requestHeaders['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: requestHeaders }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (String(res.headers['content-type'] || '').includes('application/json')) {
          json = JSON.parse(text || '{}');
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
