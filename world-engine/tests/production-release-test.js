'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  createCredentialRecord,
  verifyCredentialRecord,
  setAccountSecret,
  hasAccountSecret,
} = require('../core/credential-engine');
const {
  loadProductionConfig,
} = require('../core/production-config-engine');
const {
  configurePersistenceSecurity,
  resetPersistenceSecurity,
  saveWorld,
  loadWorld,
} = require('../core/persistence-engine');
const {
  createWorldTemplateRegistry,
  createWorldFromTemplate,
} = require('../core/world-template-engine');
const {
  createAccount,
  getAccount,
} = require('../core/account-session-engine');
const {
  createProductionApiServer,
  createRateLimiter,
} = require('../core/production-api-engine');
const {
  initializeProductionRuntime,
  gracefulShutdown,
} = require('../demo/production-server');

async function main() {
  const originalCwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-production-release-'));
  try {
    await testCredentials();
    testConfiguration(root);
    testPersistenceSandbox(root);
    await testProductionApi(root);
    await testProductionRestart(root, originalCwd);
    console.log('production v1 release integration test passed');
  } finally {
    if (process.cwd() !== originalCwd) process.chdir(originalCwd);
    resetPersistenceSecurity();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testCredentials() {
  const record = await createCredentialRecord('Correct Horse Battery 123', { cost: 1024 });
  assert.strictEqual(record.scheme, 'scrypt-v1');
  assert.ok(record.salt.length >= 32);
  assert.ok(record.hash.length >= 64);
  assert.strictEqual(await verifyCredentialRecord(record, 'Correct Horse Battery 123', { cost: 1024 }), true);
  assert.strictEqual(await verifyCredentialRecord(record, 'wrong secret', { cost: 1024 }), false);
  await assert.rejects(
    () => createCredentialRecord('short', { cost: 1024 }),
    /secret_too_short/,
  );
}

function testConfiguration(root) {
  const dataDir = path.join(root, 'config-data');
  const config = loadProductionConfig({
    NODE_ENV: 'production',
    MUD_DATA_DIR: dataDir,
    MUD_ADMIN_SECRET: 'Administrator Secret 123',
    MUD_AUTO_LOOP: 'false',
    MUD_REGISTRATION_POLICY: 'open',
    MUD_CORS_ORIGINS: 'https://game.example, https://ops.example',
  }, root);
  assert.strictEqual(config.requireAuth, true);
  assert.strictEqual(config.requireCredentials, true);
  assert.strictEqual(config.registrationPolicy, 'open');
  assert.strictEqual(config.autoStartLoop, false);
  assert.strictEqual(config.worldFile, path.join(dataDir, 'world.json'));
  assert.deepStrictEqual(config.corsOrigins, ['https://game.example', 'https://ops.example']);
  assert.throws(() => loadProductionConfig({
    MUD_DATA_DIR: dataDir,
    MUD_WORLD_FILE: '../escape.json',
  }, root), /path_outside_data_dir/);
  assert.throws(() => loadProductionConfig({
    MUD_DATA_DIR: dataDir,
    MUD_REQUIRE_AUTH: 'false',
  }, root), /production_auth_required/);
}

function testPersistenceSandbox(root) {
  const dataDir = path.join(root, 'sandbox-data');
  fs.mkdirSync(dataDir, { recursive: true });
  configurePersistenceSecurity({ allowedRoots: [dataDir], enforce: true });
  const registry = createWorldTemplateRegistry();
  const world = createWorldFromTemplate(registry, 'empty_sandbox', { initialize: false });
  const file = path.join(dataDir, 'world.json');
  const saved = saveWorld(world, file, { createBackup: false });
  assert.strictEqual(saved.file, file);
  assert.ok(fs.existsSync(file));
  assert.strictEqual(loadWorld(file).world.id, world.id);
  assert.strictEqual(fs.readdirSync(dataDir).some(name => name.includes('.tmp-')), false, 'atomic save should not leave temp files');
  assert.throws(
    () => saveWorld(world, path.join(root, 'outside.json'), { createBackup: false }),
    /persistence_path_forbidden/,
  );
  resetPersistenceSecurity();
}

async function testProductionApi(root) {
  const dataDir = path.join(root, 'api-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const registry = createWorldTemplateRegistry();
  const world = createWorldFromTemplate(registry, 'cultivation_frontier', { seedTicks: 1 });
  const admin = createAccount(world, {
    id: 'release_admin',
    name: 'Release Admin',
    roles: ['admin', 'gm'],
  });
  await setAccountSecret(admin, 'Release Administrator 123', { cost: 1024 });
  assert.strictEqual(hasAccountSecret(admin), true);

  const { server } = createProductionApiServer(world, {
    dataDir,
    defaultSavePath: path.join(dataDir, 'world.json'),
    registrationPolicy: 'open',
    sessionTtlTicks: 1000,
    autoStartLoop: false,
    credentialOptions: { cost: 1024 },
    rateLimit: { windowMs: 60000, generalMax: 200, authMax: 20, registrationMax: 20 },
    runtimeLoop: { intervalMs: 1000, ticksPerCycle: 1, autosaveEveryTicks: 0 },
  });
  const base = await listen(server);

  try {
    const ready = await requestJson(base, 'GET', '/ready');
    assert.strictEqual(ready.statusCode, 200);
    assert.strictEqual(ready.body.ready, true);
    assert.strictEqual(ready.body.registrationPolicy, 'open');
    assert.strictEqual(ready.headers['x-frame-options'], 'DENY');
    assert.ok(ready.headers['content-security-policy'].includes("default-src 'self'"));
    assert.notStrictEqual(ready.headers['access-control-allow-origin'], '*');

    const sameOrigin = await requestJson(base, 'GET', '/ready', null, {
      Origin: base,
    });
    assert.strictEqual(sameOrigin.statusCode, 200);
    assert.strictEqual(sameOrigin.headers['access-control-allow-origin'], base);

    const badOrigin = await requestJson(base, 'GET', '/ready', null, {
      Origin: 'https://evil.example',
    });
    assert.strictEqual(badOrigin.statusCode, 403);
    assert.strictEqual(badOrigin.body.error, 'origin_forbidden');

    const weak = await requestJson(base, 'POST', '/accounts', {
      id: 'weak_player',
      name: 'Weak Player',
      secret: 'short',
    });
    assert.strictEqual(weak.statusCode, 400);
    assert.strictEqual(weak.body.error, 'secret_too_short');

    const registered = await requestJson(base, 'POST', '/accounts', {
      id: 'release_player',
      name: 'Release Player',
      roles: ['admin'],
      secret: 'Release Player Secret 123',
    });
    assert.strictEqual(registered.statusCode, 201);
    assert.deepStrictEqual(registered.body.data.account.roles, ['player'], 'open registration must not grant admin roles');
    assert.ok(!JSON.stringify(registered.body).includes('Release Player Secret 123'));

    const wrongLogin = await requestJson(base, 'POST', '/sessions', {
      accountId: 'release_player',
      secret: 'wrong secret value',
    });
    assert.strictEqual(wrongLogin.statusCode, 401);
    assert.strictEqual(wrongLogin.body.error, 'invalid_credentials');

    const playerLogin = await requestJson(base, 'POST', '/sessions', {
      accountId: 'release_player',
      secret: 'Release Player Secret 123',
    });
    assert.strictEqual(playerLogin.statusCode, 201);
    const playerToken = playerLogin.body.data.token;
    assert.ok(playerToken.startsWith('sess_'));

    const playerSecurity = await requestJson(base, 'GET', '/admin/security', null, bearer(playerToken));
    assert.strictEqual(playerSecurity.statusCode, 403);

    const adminLogin = await requestJson(base, 'POST', '/sessions', {
      accountId: 'release_admin',
      secret: 'Release Administrator 123',
    });
    assert.strictEqual(adminLogin.statusCode, 201);
    const adminToken = adminLogin.body.data.token;

    const security = await requestJson(base, 'GET', '/admin/security', null, bearer(adminToken));
    assert.strictEqual(security.statusCode, 200);
    assert.strictEqual(security.body.data.requireCredentials, true);
    assert.strictEqual(security.body.data.persistence.enforce, true);

    const accounts = await requestJson(base, 'GET', '/admin/accounts', null, bearer(adminToken));
    assert.strictEqual(accounts.statusCode, 200);
    assert.ok(accounts.body.data.accounts.length >= 2);
    assert.ok(!JSON.stringify(accounts.body).includes('hash'));

    const outsideSave = await requestJson(base, 'POST', '/save', {
      filePath: path.join(root, 'forbidden-world.json'),
      options: { createBackup: false },
    }, bearer(adminToken));
    assert.strictEqual(outsideSave.statusCode, 403);
    assert.strictEqual(outsideSave.body.error, 'persistence_path_forbidden');

    const savePath = path.join(dataDir, 'manual.json');
    const insideSave = await requestJson(base, 'POST', '/save', {
      filePath: savePath,
      options: { createBackup: false },
    }, bearer(adminToken));
    assert.strictEqual(insideSave.statusCode, 200);
    assert.ok(fs.existsSync(savePath));

    const saves = await requestJson(base, 'GET', '/saves', null, bearer(adminToken));
    assert.strictEqual(saves.statusCode, 200);
    assert.ok(saves.body.data.saves.some(save => save.name === 'manual.json'));

    const queryToken = await requestJson(base, 'GET', `/session?token=${encodeURIComponent(adminToken)}`);
    assert.strictEqual(queryToken.statusCode, 400);
    assert.strictEqual(queryToken.body.error, 'query_token_forbidden');

    const unauthStream = await requestJson(base, 'GET', '/stream');
    assert.strictEqual(unauthStream.statusCode, 401);

    const unauthUpgrade = await rawWebSocketUpgrade(base, null);
    assert.ok(unauthUpgrade.startsWith('HTTP/1.1 401'));
    const authUpgrade = await rawWebSocketUpgrade(base, adminToken);
    assert.ok(authUpgrade.startsWith('HTTP/1.1 101'));

    const clientScript = await requestText(base, '/client/production-client.js');
    assert.strictEqual(clientScript.statusCode, 200);
    assert.ok(clientScript.text.includes('installProductionFetchBridge'));
    assert.ok(clientScript.text.includes('installProductionWebSocketBridge'));
  } finally {
    await close(server);
    resetPersistenceSecurity();
  }

  const limiter = createRateLimiter({ windowMs: 1000, generalMax: 2, authMax: 1, registrationMax: 1 });
  assert.strictEqual(limiter.consume('auth', 'ip', 0).allowed, true);
  assert.strictEqual(limiter.consume('auth', 'ip', 1).allowed, false);
  assert.strictEqual(limiter.consume('auth', 'ip', 1000).allowed, true);
}

async function testProductionRestart(root, originalCwd) {
  const dataDir = path.join(root, 'restart-data');
  const firstConfig = loadProductionConfig({
    NODE_ENV: 'production',
    MUD_DATA_DIR: dataDir,
    MUD_ADMIN_ID: 'bootstrap_admin',
    MUD_ADMIN_SECRET: 'Bootstrap Administrator 123',
    MUD_AUTO_LOOP: 'false',
    MUD_AUTOSAVE_EVERY_TICKS: '0',
  }, originalCwd);
  const first = await initializeProductionRuntime(firstConfig);
  const base = await listen(first.server);
  const login = await requestJson(base, 'POST', '/sessions', {
    accountId: 'bootstrap_admin',
    secret: 'Bootstrap Administrator 123',
  });
  assert.strictEqual(login.statusCode, 201);
  const worldId = first.api.getWorld().id;
  await gracefulShutdown(first, 'test_first_shutdown');
  assert.strictEqual(process.cwd(), originalCwd);
  assert.ok(fs.existsSync(firstConfig.worldFile));

  const secondConfig = loadProductionConfig({
    NODE_ENV: 'production',
    MUD_DATA_DIR: dataDir,
    MUD_ADMIN_ID: 'bootstrap_admin',
    MUD_AUTO_LOOP: 'false',
    MUD_AUTOSAVE_EVERY_TICKS: '0',
  }, originalCwd);
  const second = await initializeProductionRuntime(secondConfig);
  assert.strictEqual(second.initialized.source, 'save');
  assert.strictEqual(second.api.getWorld().id, worldId);
  assert.strictEqual(second.bootstrap.credentialConfigured, true);
  await gracefulShutdown(second, 'test_second_shutdown');
  assert.strictEqual(process.cwd(), originalCwd);
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
  if (!server.listening) return Promise.resolve();
  return new Promise(resolve => server.close(resolve));
}

function requestJson(base, method, pathname, body = null, headers = {}) {
  return requestText(base, pathname, method, body, headers).then(result => {
    let parsed = {};
    try { parsed = JSON.parse(result.text || '{}'); } catch (_error) {}
    return { ...result, body: parsed };
  });
}

function requestText(base, pathname, method = 'GET', body = null, headers = {}) {
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
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function rawWebSocketUpgrade(base, token) {
  const url = new URL(base);
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(Number(url.port), url.hostname);
    const chunks = [];
    socket.setTimeout(3000);
    socket.on('connect', () => {
      socket.write([
        `GET /ws/ticks${query} HTTP/1.1`,
        `Host: ${url.host}`,
        `Origin: ${base}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', chunk => {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(text);
      }
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('websocket upgrade timeout'));
    });
    socket.on('error', reject);
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
