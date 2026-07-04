'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createWorld } = require('../core/world-engine');
const { appendDatabaseEvent, listDatabaseEvents } = require('../core/database-engine');
const { createWorldTemplateApiServer } = require('../core/world-template-api-engine');
const { endpoints } = require('../demo/api-server');

async function main() {
  testDatabaseEventListing();
  await testDatabaseEventRoute();
  console.log('database event admin test passed');
}

function testDatabaseEventListing() {
  const dir = tempDir('phyrex-db-events-');
  try {
    const database = { provider: 'jsonl', directory: dir, name: 'events' };
    appendDatabaseEvent({ worldId: 'world_a', tick: 1, type: 'alpha', payload: { value: 1 } }, { database });
    appendDatabaseEvent({ worldId: 'world_a', tick: 2, type: 'beta', payload: { value: 2 } }, { database });
    appendDatabaseEvent({ worldId: 'world_b', tick: 3, type: 'alpha', payload: { value: 3 } }, { database });

    const latest = listDatabaseEvents({ database, limit: 2 });
    assert.strictEqual(latest.length, 2);
    assert.strictEqual(latest[0].worldId, 'world_b');

    const alpha = listDatabaseEvents({ database, type: 'alpha', order: 'asc' });
    assert.strictEqual(alpha.length, 2);
    assert.strictEqual(alpha[0].worldId, 'world_a');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testDatabaseEventRoute() {
  const dir = tempDir('phyrex-db-event-route-');
  const database = { provider: 'jsonl', directory: dir, name: 'event-route' };
  appendDatabaseEvent({ worldId: 'route_world', tick: 4, type: 'route.test', payload: { ok: true } }, { database });
  const world = createWorld({ id: 'route_world', seed: 'route_seed' });
  const app = createWorldTemplateApiServer(world, { seedTicks: 0, requireAuth: false });
  const server = app.server;
  try {
    const port = await listen(server);
    const route = `/admin/database/events?dbProvider=jsonl&dbDir=${encodeURIComponent(dir)}&dbName=event-route&type=route.test&limit=5`;
    const response = await requestJson(port, 'GET', route);
    assert.strictEqual(response.ok, true);
    assert.strictEqual(response.data.database.provider, 'jsonl');
    assert.strictEqual(response.data.events.length, 1);
    assert.strictEqual(response.data.events[0].type, 'route.test');
    assert.ok(endpoints().includes('GET /admin/database/events'));
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function requestJson(port, method, route) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method }, res => {
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
