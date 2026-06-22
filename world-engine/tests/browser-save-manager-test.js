'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createWorldApiServer } = require('../core/api-server-engine');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-save-ui-'));
  const filePath = path.join(directory, 'checkpoint-alpha.json');
  const { server } = createWorldApiServer(null, { seedTicks: 5 });
  const base = await listen(server);

  try {
    const saved = await requestJson(base, 'POST', '/save', {
      filePath,
      options: {
        metadata: {
          label: 'Checkpoint Alpha',
          notes: 'Browser save manager integration test',
          source: 'browser_save_manager',
        },
      },
    });
    assert.strictEqual(saved.ok, true, 'save endpoint should create a managed save');
    assert.ok(fs.existsSync(filePath), 'managed save should exist');

    const listed = await requestJson(
      base,
      'GET',
      '/saves?dir=' + encodeURIComponent(directory),
    );
    assert.strictEqual(listed.data.saves.length, 1, 'save listing should include the managed save');
    const entry = listed.data.saves[0];
    assert.strictEqual(entry.label, 'Checkpoint Alpha', 'save listing should expose label');
    assert.strictEqual(entry.reason, 'manual', 'save listing should expose save reason');
    assert.strictEqual(entry.metadata.notes, 'Browser save manager integration test');
    assert.strictEqual(entry.metadata.source, 'browser_save_manager');
    assert.strictEqual(entry.metadata.engine, 'world-engine');
    assert.ok(entry.size > 0, 'save listing should expose size');

    await requestJson(base, 'POST', '/tick', { ticks: 2 });
    const loaded = await requestJson(base, 'POST', '/load', { filePath });
    assert.strictEqual(loaded.data.tick, saved.data.tick, 'load should restore saved tick');
    assert.strictEqual(loaded.data.worldId, saved.data.worldId, 'load should restore saved world');

    const loop = await requestJson(base, 'GET', '/admin/loop');
    assert.strictEqual(typeof loop.data.autosaveEveryTicks, 'number');
    assert.ok(Object.prototype.hasOwnProperty.call(loop.data, 'lastAutosaveTick'));

    const index = await requestText(base, '/client');
    assert.ok(index.text.includes('/client/save-manager.js'));
    assert.ok(index.text.includes('/client/save-manager.css'));

    const script = await requestText(base, '/client/save-manager.js');
    assert.strictEqual(script.statusCode, 200);
    assert.ok(script.headers['content-type'].includes('application/javascript'));
    assert.ok(script.text.includes('refreshSaveManager'));
    assert.ok(script.text.includes("saveManagerRequest('/save'"));
    assert.ok(script.text.includes("saveManagerRequest('/load'"));
    assert.ok(script.text.includes('window.confirm'));
    assert.ok(script.text.includes('renderSaveAutosaveStatus'));

    const css = await requestText(base, '/client/save-manager.css');
    assert.strictEqual(css.statusCode, 200);
    assert.ok(css.headers['content-type'].includes('text/css'));
    assert.ok(css.text.includes('.save-manager-panel'));
    assert.ok(css.text.includes('.save-card'));

    console.log('browser local save manager integration test passed');
  } finally {
    await close(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

function requestJson(base, method, pathname, body = null) {
  return requestText(base, pathname, method, body).then(result => {
    const parsed = JSON.parse(result.text || '{}');
    if (result.statusCode >= 400) {
      throw new Error(`HTTP ${result.statusCode}: ${JSON.stringify(parsed)}`);
    }
    return parsed;
  });
}

function requestText(base, pathname, method = 'GET', body = null) {
  const url = new URL(pathname, base);
  const payload = body ? JSON.stringify(body) : null;
  const headers = {};
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
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
