'use strict';

const assert = require('assert');
const http = require('http');
const { createWorldApiServer } = require('../core/world-template-api-engine');

async function main() {
  const { server } = createWorldApiServer(null, { seedTicks: 5 });
  const base = await listen(server);

  try {
    const root = await request(base, '/');
    assert.strictEqual(root.statusCode, 200, 'root should serve client index');
    assert.ok(root.text.includes('MUD 世界模拟器'), 'index should include title');

    const index = await request(base, '/client');
    assert.strictEqual(index.statusCode, 200, '/client should serve index');
    for (const asset of [
      '/client/app.js',
      '/client/style.css',
      '/client/runtime-controls.js',
      '/client/runtime-controls.css',
      '/client/character-controls.js',
      '/client/character-controls.css',
      '/client/admin-console.js',
      '/client/admin-console.css',
      '/client/save-manager.js',
      '/client/save-manager.css',
      '/client/action-queue-model.js',
      '/client/action-queue.js',
      '/client/action-queue.css',
      '/client/world-template-manager.js',
      '/client/world-template-manager.css',
      '/client/world-insights-model.js',
      '/client/world-insights.js',
      '/client/world-insights.css',
      '/client/workspace-layout-model.js',
      '/client/workspace-layout.js',
      '/client/workspace-layout.css',
      '/client/command-palette-model.js',
      '/client/command-palette.js',
      '/client/command-palette.css',
      '/client/world-control-command-extensions.js',
    ]) {
      assert.ok(index.text.includes(asset), `index should reference ${asset}`);
    }
    assert.ok(index.text.includes('quickStartBtn'), 'index should include quick start');
    assert.ok(index.text.includes('saveWorldBtn'), 'index should include save button');
    assert.ok(index.text.includes('loadWorldBtn'), 'index should include load button');
    assert.ok(index.text.includes('characterPanel'), 'index should include character status panel');
    assert.ok(index.text.includes('accountPlayersPanel'), 'index should include account player list');
    assert.ok(index.text.includes('controlledCharactersPanel'), 'index should include controlled character list');
    assert.ok(index.text.includes('createAdditionalCharacterBtn'), 'index should include additional character button');
    assert.ok(index.text.includes('observerModeBtn'), 'index should include observer mode button');
    assert.ok(index.text.includes('inventoryPanel'), 'index should include inventory panel');
    assert.ok(index.text.includes('shopPanel'), 'index should include shop panel');
    assert.ok(index.text.includes('journalPanel'), 'index should include journal panel');

    const app = await request(base, '/client/app.js');
    assert.strictEqual(app.statusCode, 200, 'app.js should be served');
    assert.ok(app.headers['content-type'].includes('application/javascript'), 'app.js content type should be JavaScript');
    assert.ok(app.text.includes('quickStart'), 'app.js should include quick start');
    assert.ok(app.text.includes('runGameAction'), 'app.js should include browser gameplay actions');
    assert.ok(app.text.includes('renderInventory'), 'app.js should render inventory');
    assert.ok(app.text.includes('renderBoard'), 'app.js should render quest board');
    assert.ok(app.text.includes('connectWs'), 'app.js should include websocket client');

    const runtimeJs = await request(base, '/client/runtime-controls.js');
    assert.strictEqual(runtimeJs.statusCode, 200, 'runtime-controls.js should be served');
    assert.ok(runtimeJs.text.includes('startRuntimeLoopFromClient'), 'runtime controls should start loop');
    assert.ok(runtimeJs.text.includes('pauseRuntimeLoopFromClient'), 'runtime controls should pause loop');

    const characterJs = await request(base, '/client/character-controls.js');
    assert.strictEqual(characterJs.statusCode, 200, 'character-controls.js should be served');
    assert.ok(characterJs.headers['content-type'].includes('application/javascript'));
    assert.ok(characterJs.text.includes('createAdditionalCharacter'));
    assert.ok(characterJs.text.includes('switch_character'));
    assert.ok(characterJs.text.includes('observer_mode'));
    assert.ok(characterJs.text.includes('renderControlledCharacters'));

    const adminJs = await request(base, '/client/admin-console.js');
    assert.strictEqual(adminJs.statusCode, 200, 'admin-console.js should be served');
    assert.ok(adminJs.text.includes('refreshAdminConsole'));
    assert.ok(adminJs.text.includes('renderAdminAudit'));
    assert.ok(adminJs.text.includes('renderAdminErrors'));

    const saveManagerJs = await request(base, '/client/save-manager.js');
    assert.strictEqual(saveManagerJs.statusCode, 200, 'save-manager.js should be served');
    assert.ok(saveManagerJs.text.includes('refreshSaveManager'));
    assert.ok(saveManagerJs.text.includes('createManagedSave'));
    assert.ok(saveManagerJs.text.includes('renderSaveAutosaveStatus'));

    const templateManagerJs = await request(base, '/client/world-template-manager.js');
    assert.strictEqual(templateManagerJs.statusCode, 200, 'world-template-manager.js should be served');
    assert.ok(templateManagerJs.text.includes('refreshWorldTemplates'));
    assert.ok(templateManagerJs.text.includes('resetWorldFromSelectedTemplate'));
    assert.ok(templateManagerJs.text.includes('recreateTemplatePlayer'));
    assert.ok(templateManagerJs.text.includes('window.confirm'));

    const css = await request(base, '/client/style.css');
    assert.strictEqual(css.statusCode, 200, 'style.css should be served');
    assert.ok(css.headers['content-type'].includes('text/css'));
    assert.ok(css.text.includes('.mini-card'));
    assert.ok(css.text.includes('.timeline'));
    assert.ok(css.text.includes('.toast'));

    for (const [asset, marker] of [
      ['/client/runtime-controls.css', '.runtime-loop-panel'],
      ['/client/character-controls.css', '.character-control-row'],
      ['/client/admin-console.css', '.admin-console-panel'],
      ['/client/save-manager.css', '.save-manager-panel'],
      ['/client/action-queue.css', '.action-queue-panel'],
      ['/client/world-template-manager.css', '.world-template-panel'],
      ['/client/world-insights.css', '.world-insights-panel'],
      ['/client/workspace-layout.css', '.workspace-navigator-overlay'],
      ['/client/command-palette.css', '.command-palette-overlay'],
    ]) {
      const result = await request(base, asset);
      assert.strictEqual(result.statusCode, 200, `${asset} should be served`);
      assert.ok(result.headers['content-type'].includes('text/css'), `${asset} should use CSS content type`);
      assert.ok(result.text.includes(marker), `${asset} should include ${marker}`);
    }

    const missing = await request(base, '/client/not-found.js');
    assert.strictEqual(missing.statusCode, 404, 'missing client asset should return 404');

    const traversal = await request(base, '/client/../package.json');
    assert.ok([403, 404].includes(traversal.statusCode), 'path traversal should not expose package.json');

    const health = await requestJson(base, '/health');
    assert.strictEqual(health.ok, true, 'health endpoint should still work');
    const world = await requestJson(base, '/world');
    assert.strictEqual(world.ok, true, 'world endpoint should still work');

    console.log('local browser client test passed');
  } finally {
    await close(server);
  }
}

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function request(base, pathname) {
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

async function requestJson(base, pathname) {
  const result = await request(base, pathname);
  if (result.statusCode >= 400) throw new Error(`HTTP ${result.statusCode}: ${result.text}`);
  return JSON.parse(result.text || '{}');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
