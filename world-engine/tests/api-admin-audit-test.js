'use strict';

const assert = require('assert');
const http = require('http');
const { createWorldApiServer } = require('../core/api-server-engine');
const { getApiAuditStats } = require('../core/api-audit-engine');

async function main() {
  const { server, api } = createWorldApiServer(null, { seedTicks: 5, requireAuth: true });
  const base = await listen(server);

  try {
    const playerAccount = await requestJson(base, 'POST', '/accounts', { id: 'audit_player_account', name: 'Audit Player', roles: ['player'] });
    assert.strictEqual(playerAccount.ok, true, 'player account should be created');

    const gmAccount = await requestJson(base, 'POST', '/accounts', { id: 'audit_gm_account', name: 'Audit GM', roles: ['gm'] });
    assert.strictEqual(gmAccount.ok, true, 'gm account should be created');

    const playerSession = await requestJson(base, 'POST', '/sessions', { accountId: 'audit_player_account' });
    const gmSession = await requestJson(base, 'POST', '/sessions', { accountId: 'audit_gm_account' });
    const playerToken = playerSession.data.token;
    const gmToken = gmSession.data.token;

    const unauthAdmin = await requestJsonAllowError(base, 'GET', '/admin/status');
    assert.strictEqual(unauthAdmin.statusCode, 401, 'admin status should require auth');

    const playerAdmin = await requestJsonAllowError(base, 'GET', '/admin/status', null, bearer(playerToken));
    assert.strictEqual(playerAdmin.statusCode, 403, 'normal player should not access admin status');

    const gmStatus = await requestJson(base, 'GET', '/admin/status', null, bearer(gmToken));
    assert.strictEqual(gmStatus.ok, true, 'gm should access admin status');
    assert.ok(gmStatus.data.health.worldId, 'admin status should include health');
    assert.ok(gmStatus.data.audit.requests >= 1, 'admin status should include audit stats');
    assert.ok(gmStatus.data.accounts.accounts >= 2, 'admin status should include account stats');
    assert.ok(gmStatus.data.runtime.worldId, 'admin status should include runtime summary');

    const gmConnections = await requestJson(base, 'GET', '/admin/connections', null, bearer(gmToken));
    assert.strictEqual(gmConnections.ok, true, 'gm should access connections');
    assert.strictEqual(typeof gmConnections.data.streams, 'number', 'connections should include streams');
    assert.strictEqual(typeof gmConnections.data.sockets, 'number', 'connections should include sockets');

    const notFound = await requestJsonAllowError(base, 'GET', '/missing-route');
    assert.strictEqual(notFound.statusCode, 404, 'missing route should be 404');

    const gmAudit = await requestJson(base, 'GET', '/admin/audit?limit=50', null, bearer(gmToken));
    assert.strictEqual(gmAudit.ok, true, 'gm should access audit');
    assert.ok(gmAudit.data.stats.requests >= 4, 'audit stats should count requests');
    assert.ok(gmAudit.data.log.length >= 1, 'audit should return log entries');
    assert.ok(gmAudit.data.log.some(entry => entry.statusCode === 401), 'audit should include 401 entry');
    assert.ok(gmAudit.data.log.some(entry => entry.statusCode === 403), 'audit should include 403 entry');
    assert.ok(gmAudit.data.log.some(entry => entry.statusCode === 404), 'audit should include 404 entry');
    assert.ok(gmAudit.data.log.some(entry => entry.accountId === 'audit_gm_account'), 'audit should include gm account id');

    const gmErrors = await requestJson(base, 'GET', '/admin/errors?limit=20', null, bearer(gmToken));
    assert.strictEqual(gmErrors.ok, true, 'gm should access errors');
    assert.ok(gmErrors.data.errors.some(entry => entry.statusCode === 401), 'errors should include 401');
    assert.ok(gmErrors.data.errors.some(entry => entry.statusCode === 403), 'errors should include 403');
    assert.ok(gmErrors.data.errors.some(entry => entry.statusCode === 404), 'errors should include 404');

    const stats = getApiAuditStats(api.getWorld());
    assert.ok(stats.requests >= 1, 'direct audit stats should count requests');
    assert.ok(stats.errors >= 1, 'direct audit stats should count errors');
    assert.ok(stats.byMethod.GET >= 1, 'audit should count GET requests');
    assert.ok(stats.byStatus['401'] >= 1, 'audit should count 401');
    assert.ok(stats.byStatus['403'] >= 1, 'audit should count 403');
    assert.ok(stats.byStatus['404'] >= 1, 'audit should count 404');

    console.log('api admin audit integration test passed');
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
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function requestJson(base, method, pathName, body = null, extraHeaders = {}) {
  return requestJsonAllowError(base, method, pathName, body, extraHeaders).then(result => {
    if (result.statusCode >= 400) throw new Error(`HTTP ${result.statusCode}: ${JSON.stringify(result.body)}`);
    return result.body;
  });
}

function requestJsonAllowError(base, method, pathName, body = null, extraHeaders = {}) {
  const url = new URL(pathName, base);
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
          const json = JSON.parse(text || '{}');
          resolve({ statusCode: res.statusCode, body: json });
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
