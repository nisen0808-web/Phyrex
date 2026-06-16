'use strict';

const assert = require('assert');
const http = require('http');
const { createWorldApiServer } = require('../core/api-server-engine');
const { getApiAuditStats, getApiAuditLog, getApiErrors } = require('../core/api-audit-engine');

async function main() {
  const { server, api } = createWorldApiServer(null, { seedTicks: 5, requireAuth: true });
  const base = await listen(server);

  try {
    await requestJson(base, 'POST', '/accounts', { id: 'audit_gm', name: 'Audit GM', roles: ['gm'] });
    await requestJson(base, 'POST', '/accounts', { id: 'audit_user', name: 'Audit User', roles: ['player'] });
    const gmSession = await requestJson(base, 'POST', '/sessions', { accountId: 'audit_gm' });
    const userSession = await requestJson(base, 'POST', '/sessions', { accountId: 'audit_user' });
    const gmHeaders = auth(gmSession.data.token);
    const userHeaders = auth(userSession.data.token);

    const blocked = await requestJsonAllowError(base, 'GET', '/admin/status', null, userHeaders);
    assert.strictEqual(blocked.statusCode, 403, 'player role should not read admin status');

    const status = await requestJson(base, 'GET', '/admin/status', null, gmHeaders);
    assert.strictEqual(status.ok, true, 'gm should read admin status');
    assert.ok(status.data.health.worldId, 'admin status should include world id');
    assert.ok(status.data.audit.requests >= 1, 'admin status should include audit stats');
    assert.ok(status.data.accounts.accounts >= 2, 'admin status should include account stats');

    const bad = await requestJsonAllowError(base, 'GET', '/missing-route', null, gmHeaders);
    assert.strictEqual(bad.statusCode, 404, 'missing route should return 404');

    const audit = await requestJson(base, 'GET', '/admin/audit?limit=50', null, gmHeaders);
    assert.strictEqual(audit.ok, true, 'gm should read audit log');
    assert.ok(audit.data.stats.requests >= 1, 'audit should count requests');
    assert.ok(audit.data.log.length >= 1, 'audit should include entries');
    assert.ok(audit.data.log.some(entry => entry.statusCode >= 400), 'audit should include failed entry');

    const errors = await requestJson(base, 'GET', '/admin/errors?limit=20', null, gmHeaders);
    assert.strictEqual(errors.ok, true, 'gm should read errors');
    assert.ok(errors.data.errors.length >= 1, 'errors should include failed entry');

    const directStats = getApiAuditStats(api.getWorld());
    assert.ok(directStats.requests >= 1, 'direct stats should count requests');
    assert.ok(directStats.errors >= 1, 'direct stats should count errors');
    assert.ok(getApiAuditLog(api.getWorld(), { limit: 10 }).length >= 1, 'direct log should return entries');
    assert.ok(getApiErrors(api.getWorld(), { limit: 10 }).length >= 1, 'direct errors should return entries');

    console.log('api audit admin integration test passed');
  } finally {
    await close(server);
  }
}

function auth(token) { return { Authorization: `Bearer ${token}` }; }
function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))); }
function close(server) { return new Promise(resolve => server.close(resolve)); }
function requestJson(base, method, route, body = null, headers = {}) { return requestJsonAllowError(base, method, route, body, headers).then(result => { if (result.statusCode >= 400) throw new Error(`HTTP ${result.statusCode}: ${JSON.stringify(result.body)}`); return result.body; }); }
function requestJsonAllowError(base, method, route, body = null, headers = {}) {
  const url = new URL(route, base);
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (payload) {
      requestHeaders['Content-Type'] = 'application/json';
      requestHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(url, { method, headers: requestHeaders }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

main().catch(error => { console.error(error); process.exit(1); });
