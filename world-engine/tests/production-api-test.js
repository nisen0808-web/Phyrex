'use strict';

const assert = require('assert');
const http = require('http');
const net = require('net');
const { createProductionApiServer } = require('../core/production-api-engine');

async function main() {
  await testPrivateProductionApi();
  await testPublicRegistrationRolePolicy();
  await testAuthenticationRateLimit();
  console.log('hardened production API integration test passed');
}

async function testPrivateProductionApi() {
  const bundle = createProductionApiServer(null, {
    seedTicks: 2,
    requireAuth: true,
    allowRegistration: false,
    requirePasswords: true,
    corsOrigins: ['https://ops.example'],
    rateLimitMax: 200,
    authRateLimitMax: 20,
    logger: false,
    autoStartLoop: false,
    admin: {
      id: 'ops_admin',
      name: 'Operations Admin',
      password: 'OperationsPassword123!',
    },
  });
  const base = await listen(bundle.server);

  try {
    const live = await request(base, 'GET', '/livez');
    assert.strictEqual(live.statusCode, 200);
    assert.strictEqual(live.json.ok, true);
    assert.strictEqual(live.json.version, '1.0.0');
    assert.strictEqual(live.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(live.headers['x-frame-options'], 'DENY');
    assert.ok(live.headers['content-security-policy'].includes("default-src 'self'"));
    assert.ok(live.headers['x-request-id']);

    const ready = await request(base, 'GET', '/readyz');
    assert.strictEqual(ready.statusCode, 200);
    assert.strictEqual(ready.json.ok, true);
    assert.strictEqual(ready.json.reasons.length, 0);

    const forbiddenOrigin = await request(base, 'GET', '/version', null, {
      Origin: 'https://attacker.example',
    });
    assert.strictEqual(forbiddenOrigin.statusCode, 403);
    assert.strictEqual(forbiddenOrigin.json.error, 'origin_forbidden');

    const allowedOrigin = await request(base, 'GET', '/version', null, {
      Origin: 'https://ops.example',
    });
    assert.strictEqual(allowedOrigin.statusCode, 200);
    assert.strictEqual(allowedOrigin.headers['access-control-allow-origin'], 'https://ops.example');
    assert.notStrictEqual(allowedOrigin.headers['access-control-allow-origin'], '*');

    const anonymousRegistration = await request(base, 'POST', '/accounts', {
      id: 'denied_account',
      name: 'Denied Account',
      password: 'DeniedPassword123!',
    });
    assert.strictEqual(anonymousRegistration.statusCode, 401);
    assert.strictEqual(anonymousRegistration.json.error, 'auth_required');

    const wrongLogin = await request(base, 'POST', '/sessions', {
      accountId: 'ops_admin',
      password: 'WrongOperationsPassword123!',
    });
    assert.strictEqual(wrongLogin.statusCode, 401);
    assert.strictEqual(wrongLogin.json.error, 'invalid_credentials');

    const login = await request(base, 'POST', '/sessions', {
      accountId: 'ops_admin',
      password: 'OperationsPassword123!',
    });
    assert.strictEqual(login.statusCode, 201);
    assert.ok(login.json.data.token);
    assert.ok(login.json.data.account.roles.includes('admin'));
    const adminHeaders = bearer(login.json.data.token);

    const metricsDenied = await request(base, 'GET', '/metrics');
    assert.strictEqual(metricsDenied.statusCode, 401);

    const metrics = await request(base, 'GET', '/metrics', null, adminHeaders);
    assert.strictEqual(metrics.statusCode, 200);
    assert.ok(metrics.headers['content-type'].includes('text/plain'));
    assert.ok(metrics.text.includes('world_engine_up 1'));
    assert.ok(metrics.text.includes('world_engine_accounts'));

    const streamDenied = await request(base, 'GET', '/stream');
    assert.strictEqual(streamDenied.statusCode, 401);
    assert.strictEqual(streamDenied.json.error, 'auth_required');

    const websocketResponse = await websocketUpgrade(base, '/ws/ticks');
    assert.ok(websocketResponse.startsWith('HTTP/1.1 401 Unauthorized'));

    const created = await request(base, 'POST', '/accounts', {
      id: 'operator_account',
      name: 'Operator Account',
      roles: ['gm'],
      password: 'OperatorPassword123!',
    }, adminHeaders);
    assert.strictEqual(created.statusCode, 201);
    assert.deepStrictEqual(created.json.data.roles, ['gm']);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(created.json.data, 'credentials'), false);

    const operatorLogin = await request(base, 'POST', '/sessions', {
      accountId: 'operator_account',
      password: 'OperatorPassword123!',
    });
    assert.strictEqual(operatorLogin.statusCode, 201);
    const operatorAccount = await request(
      base,
      'GET',
      '/accounts/operator_account',
      null,
      bearer(operatorLogin.json.data.token),
    );
    assert.strictEqual(operatorAccount.statusCode, 200);
    assert.strictEqual(JSON.stringify(operatorAccount.json).includes('credentials'), false);
    assert.strictEqual(JSON.stringify(operatorAccount.json).includes('OperatorPassword123!'), false);

    const world = await request(base, 'GET', '/world');
    assert.strictEqual(world.statusCode, 200);
    assert.strictEqual(world.headers['access-control-allow-origin'], undefined);
    assert.strictEqual(world.headers['cache-control'], 'no-store');
  } finally {
    await close(bundle.server);
  }
}

async function testPublicRegistrationRolePolicy() {
  const bundle = createProductionApiServer(null, {
    seedTicks: 1,
    requireAuth: true,
    allowRegistration: true,
    requirePasswords: true,
    logger: false,
    autoStartLoop: false,
    admin: {
      id: 'registration_admin',
      password: 'RegistrationAdmin123!',
    },
  });
  const base = await listen(bundle.server);

  try {
    const missingPassword = await request(base, 'POST', '/accounts', {
      id: 'missing_password',
      name: 'Missing Password',
    });
    assert.strictEqual(missingPassword.statusCode, 400);
    assert.strictEqual(missingPassword.json.error, 'password_required');

    const registration = await request(base, 'POST', '/accounts', {
      id: 'public_player',
      name: 'Public Player',
      roles: ['admin', 'gm'],
      password: 'PublicPlayerPassword123!',
    });
    assert.strictEqual(registration.statusCode, 201);
    assert.deepStrictEqual(registration.json.data.roles, ['player'], 'public registration must not grant privileged roles');

    const duplicate = await request(base, 'POST', '/accounts', {
      id: 'public_player',
      password: 'PublicPlayerPassword123!',
    });
    assert.strictEqual(duplicate.statusCode, 409);

    const login = await request(base, 'POST', '/sessions', {
      accountId: 'public_player',
      password: 'PublicPlayerPassword123!',
    });
    assert.strictEqual(login.statusCode, 201);
    assert.deepStrictEqual(login.json.data.account.roles, ['player']);

    const adminEndpoint = await request(
      base,
      'GET',
      '/admin/status',
      null,
      bearer(login.json.data.token),
    );
    assert.strictEqual(adminEndpoint.statusCode, 403);
  } finally {
    await close(bundle.server);
  }
}

async function testAuthenticationRateLimit() {
  const bundle = createProductionApiServer(null, {
    seedTicks: 1,
    requireAuth: true,
    allowRegistration: false,
    requirePasswords: true,
    rateLimitWindowMs: 60000,
    rateLimitMax: 100,
    authRateLimitMax: 2,
    logger: false,
    autoStartLoop: false,
    admin: {
      id: 'limited_admin',
      password: 'LimitedAdminPassword123!',
    },
  });
  const base = await listen(bundle.server);

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failure = await request(base, 'POST', '/sessions', {
        accountId: 'limited_admin',
        password: 'WrongLimitedPassword123!',
      });
      assert.strictEqual(failure.statusCode, 401);
      assert.strictEqual(failure.headers['x-ratelimit-limit'], '2');
    }
    const limited = await request(base, 'POST', '/sessions', {
      accountId: 'limited_admin',
      password: 'LimitedAdminPassword123!',
    });
    assert.strictEqual(limited.statusCode, 429);
    assert.strictEqual(limited.json.error, 'rate_limit_exceeded');
    assert.ok(Number(limited.headers['retry-after']) >= 1);
  } finally {
    await close(bundle.server);
  }
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function request(base, method, pathname, body = null, extraHeaders = {}) {
  const url = new URL(pathname, base);
  const payload = body === null ? null : JSON.stringify(body);
  const headers = { ...extraHeaders };
  if (payload !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text || '{}'); } catch (_error) { /* non-JSON response */ }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          text,
          json,
        });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function websocketUpgrade(base, pathname) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname);
    const chunks = [];
    socket.on('connect', () => {
      socket.write([
        `GET ${pathname} HTTP/1.1`,
        `Host: ${url.host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
    setTimeout(() => {
      socket.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    }, 2000).unref();
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
