'use strict';

const assert = require('assert');
const http = require('http');
const { createWorldApiServer } = require('../core/api-server-engine');

async function main() {
  const { server } = createWorldApiServer(null, { seedTicks: 5 });
  const base = await listen(server);

  try {
    const root = await request(base, '/');
    assert.strictEqual(root.statusCode, 200, 'root should serve client index');
    assert.ok(root.text.includes('MUD 世界模拟器'), 'index should include title');

    const index = await request(base, '/client');
    assert.strictEqual(index.statusCode, 200, '/client should serve index');
    assert.ok(index.text.includes('/client/app.js'), 'index should reference app.js');
    assert.ok(index.text.includes('/client/style.css'), 'index should reference style.css');
    assert.ok(index.text.includes('/client/runtime-controls.js'), 'index should reference runtime controls');
    assert.ok(index.text.includes('/client/runtime-controls.css'), 'index should reference runtime control styles');
    assert.ok(index.text.includes('/client/character-controls.js'), 'index should reference character controls');
    assert.ok(index.text.includes('/client/character-controls.css'), 'index should reference character control styles');
    assert.ok(index.text.includes('/client/admin-console.js'), 'index should reference admin console');
    assert.ok(index.text.includes('/client/admin-console.css'), 'index should reference admin console styles');
    assert.ok(index.text.includes('/client/save-manager.js'), 'index should reference save manager');
    assert.ok(index.text.includes('/client/save-manager.css'), 'index should reference save manager styles');
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
    assert.ok(characterJs.headers['content-type'].includes('application/javascript'), 'character-controls.js content type should be JavaScript');
    assert.ok(characterJs.text.includes('createAdditionalCharacter'), 'character controls should create characters');
    assert.ok(characterJs.text.includes('switch_character'), 'character controls should switch characters');
    assert.ok(characterJs.text.includes('observer_mode'), 'character controls should enter observer mode');
    assert.ok(characterJs.text.includes('renderControlledCharacters'), 'character controls should render controlled characters');

    const adminJs = await request(base, '/client/admin-console.js');
    assert.strictEqual(adminJs.statusCode, 200, 'admin-console.js should be served');
    assert.ok(adminJs.headers['content-type'].includes('application/javascript'), 'admin-console.js content type should be JavaScript');
    assert.ok(adminJs.text.includes('refreshAdminConsole'), 'admin console should refresh operational data');
    assert.ok(adminJs.text.includes('renderAdminAudit'), 'admin console should render API audit data');
    assert.ok(adminJs.text.includes('renderAdminErrors'), 'admin console should render API errors');

    const saveManagerJs = await request(base, '/client/save-manager.js');
    assert.strictEqual(saveManagerJs.statusCode, 200, 'save-manager.js should be served');
    assert.ok(saveManagerJs.headers['content-type'].includes('application/javascript'), 'save-manager.js content type should be JavaScript');
    assert.ok(saveManagerJs.text.includes('refreshSaveManager'), 'save manager should refresh save listings');
    assert.ok(saveManagerJs.text.includes('createManagedSave'), 'save manager should create named saves');
    assert.ok(saveManagerJs.text.includes('renderSaveAutosaveStatus'), 'save manager should render autosave status');

    const css = await request(base, '/client/style.css');
    assert.strictEqual(css.statusCode, 200, 'style.css should be served');
    assert.ok(css.headers['content-type'].includes('text/css'), 'style.css content type should be CSS');
    assert.ok(css.text.includes('.mini-card'), 'style.css should include mini-card style');
    assert.ok(css.text.includes('.timeline'), 'style.css should include timeline style');
    assert.ok(css.text.includes('.toast'), 'style.css should include toast style');

    const runtimeCss = await request(base, '/client/runtime-controls.css');
    assert.strictEqual(runtimeCss.statusCode, 200, 'runtime-controls.css should be served');
    assert.ok(runtimeCss.headers['content-type'].includes('text/css'), 'runtime-controls.css content type should be CSS');

    const characterCss = await request(base, '/client/character-controls.css');
    assert.strictEqual(characterCss.statusCode, 200, 'character-controls.css should be served');
    assert.ok(characterCss.headers['content-type'].includes('text/css'), 'character-controls.css content type should be CSS');
    assert.ok(characterCss.text.includes('.character-control-row'), 'character CSS should style character rows');
    assert.ok(characterCss.text.includes('.character-manager-grid'), 'character CSS should style manager grid');

    const adminCss = await request(base, '/client/admin-console.css');
    assert.strictEqual(adminCss.statusCode, 200, 'admin-console.css should be served');
    assert.ok(adminCss.headers['content-type'].includes('text/css'), 'admin-console.css content type should be CSS');
    assert.ok(adminCss.text.includes('.admin-console-panel'), 'admin CSS should style the console panel');
    assert.ok(adminCss.text.includes('.admin-table'), 'admin CSS should style the audit table');

    const saveManagerCss = await request(base, '/client/save-manager.css');
    assert.strictEqual(saveManagerCss.statusCode, 200, 'save-manager.css should be served');
    assert.ok(saveManagerCss.headers['content-type'].includes('text/css'), 'save-manager.css content type should be CSS');
    assert.ok(saveManagerCss.text.includes('.save-manager-panel'), 'save manager CSS should style the panel');
    assert.ok(saveManagerCss.text.includes('.save-card'), 'save manager CSS should style save cards');

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
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
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
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
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
