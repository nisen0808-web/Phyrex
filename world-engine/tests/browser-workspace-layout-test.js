'use strict';

const assert = require('assert');
const http = require('http');
const vm = require('vm');
const workspace = require('../client/workspace-layout-model');
const { createWorldApiServer } = require('../core/world-template-api-engine');

async function main() {
  testWorkspaceLayoutModel();

  const { server } = createWorldApiServer(null, { seedTicks: 5 });
  const base = await listen(server);
  try {
    const index = await request(base, '/client');
    assert.ok(index.text.includes('/client/workspace-layout-model.js'));
    assert.ok(index.text.includes('/client/workspace-layout.js'));
    assert.ok(index.text.includes('/client/workspace-layout.css'));
    assert.ok(index.text.includes('/client/world-control-command-extensions.js'));

    const modelScript = await request(base, '/client/workspace-layout-model.js');
    assert.strictEqual(modelScript.statusCode, 200);
    assert.ok(modelScript.headers['content-type'].includes('application/javascript'));
    assert.ok(modelScript.text.includes('createPanelKey'));
    assert.ok(modelScript.text.includes('sortPanels'));
    new vm.Script(modelScript.text, { filename: 'workspace-layout-model.js' });

    const controller = await request(base, '/client/workspace-layout.js');
    assert.strictEqual(controller.statusCode, 200);
    assert.ok(controller.text.includes('MutationObserver'));
    assert.ok(controller.text.includes('openWorkspaceNavigator'));
    assert.ok(controller.text.includes('collapseAllWorkspacePanels'));
    assert.ok(controller.text.includes('workspace-collapsed'));
    assert.ok(controller.text.includes('mud_workspace_state'));
    new vm.Script(controller.text, { filename: 'workspace-layout.js' });

    const extension = await request(base, '/client/world-control-command-extensions.js');
    assert.strictEqual(extension.statusCode, 200);
    assert.ok(extension.text.includes('show-world-templates'));
    assert.ok(extension.text.includes('show-world-insights'));
    assert.ok(extension.text.includes('open-workspace-navigator'));
    new vm.Script(extension.text, { filename: 'world-control-command-extensions.js' });

    const stylesheet = await request(base, '/client/workspace-layout.css');
    assert.strictEqual(stylesheet.statusCode, 200);
    assert.ok(stylesheet.headers['content-type'].includes('text/css'));
    assert.ok(stylesheet.text.includes('.workspace-navigator-overlay'));
    assert.ok(stylesheet.text.includes('.workspace-panel.workspace-collapsed'));
    assert.ok(stylesheet.text.includes('body.workspace-compact'));

    console.log('browser workspace layout integration test passed');
  } finally {
    await close(server);
  }
}

function testWorkspaceLayoutModel() {
  assert.strictEqual(workspace.createPanelKey({ id: 'World Insights' }), 'world-insights');
  assert.strictEqual(workspace.createPanelKey({ title: '世界 模板' }), '世界-模板');
  assert.strictEqual(workspace.createPanelKey({}, 2), 'panel-3');

  const normalized = workspace.normalizeWorkspaceState({
    collapsed: ['one', 'one', '', 'two'],
    pinned: ['two'],
    compact: 1,
  });
  assert.deepStrictEqual(normalized.collapsed, ['one', 'two']);
  assert.deepStrictEqual(normalized.pinned, ['two']);
  assert.strictEqual(normalized.compact, true);

  assert.deepStrictEqual(workspace.toggleId(['one'], 'two'), ['one', 'two']);
  assert.deepStrictEqual(workspace.toggleId(['one', 'two'], 'one'), ['two']);
  assert.deepStrictEqual(workspace.toggleId(['one'], 'one', true), ['one']);
  assert.deepStrictEqual(workspace.toggleId(['one'], 'one', false), []);

  const panels = [
    { key: 'world', title: '世界状态', description: 'world status' },
    { key: 'inventory', title: '背包', description: 'items' },
    { key: 'insights', title: '世界洞察', description: 'rankings population' },
  ];
  const sorted = workspace.sortPanels(panels, ['insights']);
  assert.strictEqual(sorted[0].key, 'insights');
  assert.deepStrictEqual(workspace.filterPanels(panels, '世界').map(item => item.key), ['world', 'insights']);
  assert.deepStrictEqual(workspace.filterPanels(panels, 'rankings population').map(item => item.key), ['insights']);
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

main().catch(error => {
  console.error(error);
  process.exit(1);
});
