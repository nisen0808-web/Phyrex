'use strict';

const assert = require('assert');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createWorldApiServer } = require('../core/api-server-engine');

async function main() {
  const savePath = path.join(__dirname, '..', 'output', 'api-test-save.json');
  const { server } = createWorldApiServer(null, { seedTicks: 5, defaultSavePath: savePath });
  const base = await listen(server);

  try {
    let health = await requestJson(base, 'GET', '/health');
    assert.strictEqual(health.ok, true, 'health should be ok');
    assert.ok(health.worldId, 'health should include world id');

    const world = await requestJson(base, 'GET', '/world');
    assert.strictEqual(world.ok, true, 'world query should be ok');
    assert.ok(world.data.totals.alive > 0, 'world should have alive entities');

    const created = await requestJson(base, 'POST', '/players', {
      player: { id: 'api_player', name: 'API Player' },
      character: {
        id: 'api_hero',
        name: 'API Hero',
        species: 'human',
        locationId: 'qingyun_city',
        stats: { health: 90, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10, social: 50 },
        resources: { currency: 100, food: 10 },
        demographics: { age: 18, generation: 1 },
      },
    });
    assert.strictEqual(created.ok, true, 'player creation should be ok');
    assert.strictEqual(created.data.player.id, 'api_player', 'created player id should match');

    const player = await requestJson(base, 'GET', '/players/api_player');
    assert.strictEqual(player.ok, true, 'player query should be ok');
    assert.strictEqual(player.data.player.id, 'api_player', 'player query id should match');

    const command = await requestJson(base, 'POST', '/commands', { playerId: 'api_player', command: { type: 'work', resource: 'currency', amount: 5 } });
    assert.strictEqual(command.ok, true, 'command should be accepted');
    assert.ok(['accepted', 'completed'].includes(command.data.command.status), 'command status should be accepted/completed');

    const offline = await requestJson(base, 'POST', '/offline', { playerId: 'api_player', command: { type: 'train', amount: 1, durationTicks: 2, runsEveryTicks: 1, repeat: 2 } });
    assert.strictEqual(offline.ok, true, 'offline command should be queued');
    assert.strictEqual(offline.data.status, 'queued', 'offline command status should be queued');

    const streamData = await readStreamEvent(base, '/stream');
    assert.ok(streamData.includes('event: hello'), 'SSE stream should send hello event');

    const wsHandshake = await readWebSocketHandshake(base, '/ws/ticks');
    assert.ok(wsHandshake.includes('101 Switching Protocols'), 'websocket should upgrade with 101');
    assert.ok(wsHandshake.includes('Sec-WebSocket-Accept'), 'websocket should include accept header');

    const tick = await requestJson(base, 'POST', '/tick', { ticks: 3 });
    assert.strictEqual(tick.ok, true, 'tick should be ok');
    assert.strictEqual(tick.data.status, 'idle', 'runtime tick should finish idle');

    const offlineQuery = await requestJson(base, 'GET', '/offline/api_player');
    assert.strictEqual(offlineQuery.ok, true, 'offline query should be ok');
    assert.ok(offlineQuery.data.offlineCommands.length >= 1, 'offline query should return commands');

    const snapshot = await requestJson(base, 'GET', '/snapshot');
    assert.strictEqual(snapshot.ok, true, 'snapshot should be ok');
    assert.ok(snapshot.data.offlineCommands.total >= 1, 'snapshot should include offline commands');

    const save = await requestJson(base, 'POST', '/save', { filePath: savePath, options: { createBackup: false } });
    assert.strictEqual(save.ok, true, 'save should be ok');
    assert.ok(fs.existsSync(savePath), 'save file should exist');

    const load = await requestJson(base, 'POST', '/load', { filePath: savePath });
    assert.strictEqual(load.ok, true, 'load should be ok');
    assert.ok(load.data.worldId, 'load should include world id');

    const saves = await requestJson(base, 'GET', `/saves?dir=${encodeURIComponent(path.dirname(savePath))}`);
    assert.strictEqual(saves.ok, true, 'saves should be ok');
    assert.ok(saves.data.saves.length >= 1, 'saves should list save file');

    console.log('api server integration test passed');
  } finally {
    await close(server);
  }
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

function requestJson(base, method, pathName, body = null) {
  const url = new URL(pathName, base);
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          const json = JSON.parse(text || '{}');
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${text}`));
          resolve(json);
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

function readStreamEvent(base, pathName) {
  const url = new URL(pathName, base);
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let text = '';
      res.on('data', chunk => {
        text += chunk.toString('utf8');
        if (text.includes('\n\n')) {
          req.destroy();
          resolve(text);
        }
      });
    });
    req.on('error', error => reject(error));
    req.setTimeout(5000, () => req.destroy(new Error('stream timeout')));
  });
}

function readWebSocketHandshake(base, pathName) {
  const url = new URL(pathName, base);
  const key = crypto.randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) }, () => {
      socket.write([
        `GET ${url.pathname} HTTP/1.1`,
        `Host: ${url.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n'));
    });
    let text = '';
    socket.on('data', chunk => {
      text += chunk.toString('latin1');
      if (text.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(text);
      }
    });
    socket.on('error', reject);
    socket.setTimeout(5000, () => socket.destroy(new Error('websocket timeout')));
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
