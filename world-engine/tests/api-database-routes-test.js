'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createWorld } = require('../core/world-engine');
const { createWorldTemplateApiServer } = require('../core/world-template-api-engine');

async function main() {
  await testDatabaseRoutes();
  await testDefaultFileRoutes();
  console.log('api database routes test passed');
}

async function testDatabaseRoutes() {
  const dir = tempDir('phyrex-api-route-db-');
  const world = createWorld({ id: 'api_route_world', seed: 'api_route_seed' });
  world.tick = 19;
  const app = createWorldTemplateApiServer(world, { seedTicks: 0, requireAuth: false });
  const server = app.server;
  try {
    const port = await listen(server);
    const database = { provider: 'jsonl', directory: dir, name: 'api-routes' };
    const save = await requestJson(port, 'POST', '/save', { persistence: 'database', database });
    assert.strictEqual(save.ok, true);
    assert.strictEqual(save.data.mode, 'database');
    assert.strictEqual(save.data.worldId, 'api_route_world');

    const listPath = `/saves?persistence=database&dbProvider=jsonl&dbDir=${encodeURIComponent(dir)}&dbName=api-routes`;
    const listed = await requestJson(port, 'GET', listPath);
    assert.strictEqual(listed.ok, true);
    assert.strictEqual(listed.data.mode, 'database');
    assert.strictEqual(listed.data.saves.length, 1);

    app.api.setWorld(createWorld({ id: 'replacement_world', seed: 'replacement_seed' }));
    const loaded = await requestJson(port, 'POST', '/load', { persistence: 'database', database, worldId: 'api_route_world' });
    assert.strictEqual(loaded.ok, true);
    assert.strictEqual(loaded.data.mode, 'database');
    assert.strictEqual(loaded.data.worldId, 'api_route_world');
    assert.strictEqual(app.api.getWorld().id, 'api_route_world');
    assert.strictEqual(app.api.getWorld().tick, 19);
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testDefaultFileRoutes() {
  const dir = tempDir('phyrex-api-route-file-');
  const filePath = path.join(dir, 'world.json');
  const world = createWorld({ id: 'api_file_route_world', seed: 'api_file_route_seed' });
  world.tick = 5;
  const app = createWorldTemplateApiServer(world, { seedTicks: 0, requireAuth: false, defaultSavePath: filePath });
  const server = app.server;
  try {
    const port = await listen(server);
    const saved = await requestJson(port, 'POST', '/save', { path: filePath, options: { createBackup: false } });
    assert.strictEqual(saved.ok, true);
    assert.strictEqual(saved.data.mode, 'file');
    assert.ok(fs.existsSync(filePath));

    const listed = await requestJson(port, 'GET', `/saves?dir=${encodeURIComponent(dir)}`);
    assert.strictEqual(listed.ok, true);
    assert.strictEqual(listed.data.mode, 'file');
    assert.strictEqual(listed.data.saves.length, 1);
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
