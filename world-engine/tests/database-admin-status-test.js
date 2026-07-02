'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createWorld } = require('../core/world-engine');
const { createWorldTemplateApiServer } = require('../core/world-template-api-engine');
const { endpoints } = require('../demo/api-server');

async function main() {
  await testDatabaseAdminStatusRoute();
  testEndpointList();
  console.log('database admin status test passed');
}

async function testDatabaseAdminStatusRoute() {
  const dir = tempDir('phyrex-db-admin-');
  const database = { provider: 'jsonl', directory: dir, name: 'admin-status' };
  const world = createWorld({ id: 'db_admin_world', seed: 'db_admin_seed' });
  world.tick = 17;
  const app = createWorldTemplateApiServer(world, { seedTicks: 0, requireAuth: false });
  const server = app.server;
  try {
    const port = await listen(server);
    const saved = await requestJson(port, 'POST', '/save', { persistence: 'database', database });
    assert.strictEqual(saved.ok, true);

    const route = `/admin/database?dbProvider=jsonl&dbDir=${encodeURIComponent(dir)}&dbName=admin-status`;
    const status = await requestJson(port, 'GET', route);
    assert.strictEqual(status.ok, true);
    assert.strictEqual(status.data.database.provider, 'jsonl');
    assert.strictEqual(status.data.database.records, 1);
    assert.strictEqual(status.data.database.events, 0);
    assert.strictEqual(status.data.database.name, 'admin-status');
    assert.strictEqual(status.data.loop.worldId, 'db_admin_world');
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testEndpointList() {
  assert.ok(endpoints().includes('GET /admin/database'));
}

function requestJson(port, method, route, body = null) {
  return new Promise((resolve, reject) => {
    const text = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: route,
      method,
      headers: text ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } : {},
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (text) req.write(text);
    req.end();
  });
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
