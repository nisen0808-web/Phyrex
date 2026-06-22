'use strict';

const assert = require('assert');
const http = require('http');
const { createWorldApiServer } = require('../core/api-server-engine');

async function main() {
  const { server } = createWorldApiServer(null, { seedTicks: 5, requireAuth: true });
  const base = await listen(server);

  try {
    await requestJson(base, 'POST', '/accounts', {
      id: 'admin_console_player',
      name: 'Admin Console Player',
      roles: ['player'],
    });
    await requestJson(base, 'POST', '/accounts', {
      id: 'admin_console_gm',
      name: 'Admin Console GM',
      roles: ['gm'],
    });

    const playerSession = await requestJson(base, 'POST', '/sessions', {
      accountId: 'admin_console_player',
    });
    const gmSession = await requestJson(base, 'POST', '/sessions', {
      accountId: 'admin_console_gm',
    });
    const playerHeaders = bearer(playerSession.data.token);
    const gmHeaders = bearer(gmSession.data.token);

    const forbidden = await requestJsonAllowError(
      base,
      'GET',
      '/admin/status',
      null,
      playerHeaders,
    );
    assert.strictEqual(forbidden.statusCode, 403, 'player should not access admin status');

    const missing = await requestJsonAllowError(
      base,
      'GET',
      '/missing-admin-console-route',
      null,
      gmHeaders,
    );
    assert.strictEqual(missing.statusCode, 404, 'missing route should generate an auditable error');

    const status = await requestJson(base, 'GET', '/admin/status', null, gmHeaders);
    assert.strictEqual(status.ok, true, 'gm should access admin status');
    assert.ok(status.data.health, 'admin status should include health');
    assert.ok(status.data.accounts, 'admin status should include account metrics');
    assert.ok(status.data.audit, 'admin status should include audit metrics');
    assert.ok(status.data.runtime, 'admin status should include runtime metrics');
    assert.ok(status.data.loop, 'admin status should include runtime loop metrics');

    const connections = await requestJson(base, 'GET', '/admin/connections', null, gmHeaders);
    assert.strictEqual(typeof connections.data.streams, 'number', 'connections should expose SSE count');
    assert.strictEqual(typeof connections.data.sockets, 'number', 'connections should expose websocket count');

    const audit = await requestJson(base, 'GET', '/admin/audit?limit=200', null, gmHeaders);
    assert.ok(audit.data.stats.requests >= 1, 'audit should count requests');
    assert.ok(Array.isArray(audit.data.log), 'audit should return a request log');
    assert.ok(
      audit.data.log.some(entry => entry.path === '/admin/status'),
      'audit should include admin status requests',
    );
    assert.ok(
      audit.data.log.some(entry => entry.path === '/missing-admin-console-route' && entry.statusCode === 404),
      'audit should include generated 404 errors',
    );

    const errors = await requestJson(base, 'GET', '/admin/errors?limit=50', null, gmHeaders);
    assert.ok(Array.isArray(errors.data.errors), 'errors should return an error list');
    assert.ok(
      errors.data.errors.some(entry => entry.path === '/missing-admin-console-route'),
      'error list should include generated route error',
    );

    const index = await requestText(base, '/client');
    assert.strictEqual(index.statusCode, 200, 'browser client should load');
    assert.ok(index.text.includes('/client/admin-console.js'), 'client should load admin console JavaScript');
    assert.ok(index.text.includes('/client/admin-console.css'), 'client should load admin console CSS');

    const script = await requestText(base, '/client/admin-console.js');
    assert.strictEqual(script.statusCode, 200, 'admin console JavaScript should be served');
    assert.ok(script.headers['content-type'].includes('application/javascript'), 'admin console script should use JavaScript content type');
    assert.ok(script.text.includes('refreshAdminConsole'), 'admin console should expose refresh behavior');
    assert.ok(script.text.includes("adminRequest('/admin/status')"), 'admin console should request admin status');
    assert.ok(script.text.includes('renderAdminAudit'), 'admin console should render audit records');
    assert.ok(script.text.includes('renderAdminErrors'), 'admin console should render error records');

    const stylesheet = await requestText(base, '/client/admin-console.css');
    assert.strictEqual(stylesheet.statusCode, 200, 'admin console CSS should be served');
    assert.ok(stylesheet.headers['content-type'].includes('text/css'), 'admin console stylesheet should use CSS content type');
    assert.ok(stylesheet.text.includes('.admin-console-panel'), 'admin CSS should style the console panel');
    assert.ok(stylesheet.text.includes('.admin-table'), 'admin CSS should style the audit table');

    console.log('browser GM admin console integration test passed');
  } finally {
    await close(server);
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

function requestText(base, pathname) {
  const url = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
