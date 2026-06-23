'use strict';

const assert = require('assert');
const http = require('http');
const vm = require('vm');
const palette = require('../client/command-palette-model');
const { createWorldApiServer } = require('../core/api-server-engine');

async function main() {
  testCommandPaletteModel();

  const { server } = createWorldApiServer(null, { seedTicks: 5 });
  const base = await listen(server);

  try {
    const index = await request(base, '/client');
    assert.strictEqual(index.statusCode, 200, 'browser client should load');
    assert.ok(index.text.includes('/client/command-palette-model.js'), 'client should load command palette model');
    assert.ok(index.text.includes('/client/command-palette.js'), 'client should load command palette controller');
    assert.ok(index.text.includes('/client/command-palette.css'), 'client should load command palette styles');

    const modelScript = await request(base, '/client/command-palette-model.js');
    assert.strictEqual(modelScript.statusCode, 200, 'command palette model should be served');
    assert.ok(modelScript.headers['content-type'].includes('application/javascript'));
    assert.ok(modelScript.text.includes('rankCommands'));
    assert.ok(modelScript.text.includes('resolveShortcut'));
    new vm.Script(modelScript.text, { filename: 'command-palette-model.js' });

    const controller = await request(base, '/client/command-palette.js');
    assert.strictEqual(controller.statusCode, 200, 'command palette controller should be served');
    assert.ok(controller.headers['content-type'].includes('application/javascript'));
    assert.ok(controller.text.includes('openCommandPalette'));
    assert.ok(controller.text.includes('executePaletteCommand'));
    assert.ok(controller.text.includes('buildCommandPaletteCommands'));
    assert.ok(controller.text.includes('window.runGameAction'));
    assert.ok(controller.text.includes('mud_command_palette_recent'));
    assert.ok(controller.text.includes('commandPaletteHotkeys'));
    new vm.Script(controller.text, { filename: 'command-palette.js' });

    const stylesheet = await request(base, '/client/command-palette.css');
    assert.strictEqual(stylesheet.statusCode, 200, 'command palette stylesheet should be served');
    assert.ok(stylesheet.headers['content-type'].includes('text/css'));
    assert.ok(stylesheet.text.includes('.command-palette-overlay'));
    assert.ok(stylesheet.text.includes('.command-palette-result.selected'));
    assert.ok(stylesheet.text.includes('.command-palette-highlight'));

    console.log('browser command palette integration test passed');
  } finally {
    await close(server);
  }
}

function testCommandPaletteModel() {
  const commands = [
    {
      id: 'explore',
      title: '探索当前地点',
      description: 'Explore the current location',
      group: '玩法动作',
      keywords: ['explore', '冒险'],
      shortcut: 'e',
    },
    {
      id: 'save-world',
      title: '立即保存世界',
      description: 'Create a checkpoint',
      group: '存档',
      keywords: ['save', 'checkpoint'],
    },
    {
      id: 'show-action-queue',
      title: '定位到行动队列',
      description: 'Open the turn planner',
      group: '自动化',
      keywords: ['queue', 'planner'],
      shortcut: 'p',
    },
  ];

  assert.strictEqual(palette.normalizeText('  SAVE_world  '), 'save world');
  assert.deepStrictEqual(palette.tokenize('行动  queue'), ['行动', 'queue']);

  const exact = palette.rankCommands(commands, 'explore');
  assert.strictEqual(exact[0].id, 'explore', 'exact keyword should rank first');

  const chinese = palette.rankCommands(commands, '行动 队列');
  assert.strictEqual(chinese.length, 1, 'all query tokens should be required');
  assert.strictEqual(chinese[0].id, 'show-action-queue');

  const favoriteFirst = palette.rankCommands(commands, '', {
    favoriteIds: ['save-world'],
    recentIds: ['explore'],
  });
  assert.strictEqual(favoriteFirst[0].id, 'save-world', 'favorite boost should exceed recent boost');

  const recent = palette.recordRecent(['save-world', 'explore'], 'explore', 3);
  assert.deepStrictEqual(recent, ['explore', 'save-world'], 'recent list should deduplicate and move command first');
  assert.deepStrictEqual(palette.recordRecent(recent, 'show-action-queue', 2), ['show-action-queue', 'explore']);

  const favorites = palette.toggleFavorite([], 'save-world');
  assert.deepStrictEqual(favorites, ['save-world']);
  assert.deepStrictEqual(palette.toggleFavorite(favorites, 'save-world'), []);

  const parsed = palette.parseShortcut('Ctrl+Shift+K');
  assert.deepStrictEqual(parsed, {
    key: 'k',
    ctrl: true,
    meta: false,
    alt: false,
    shift: true,
  });

  const shortcut = palette.resolveShortcut(commands, {
    key: 'E',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target: { tagName: 'DIV', isContentEditable: false },
  });
  assert.strictEqual(shortcut.id, 'explore', 'single-key shortcut should resolve');

  const blocked = palette.resolveShortcut(commands, {
    key: 'e',
    target: { tagName: 'INPUT', isContentEditable: false },
  });
  assert.strictEqual(blocked, null, 'shortcuts should not fire while editing input');

  assert.strictEqual(palette.isEditableTarget({ tagName: 'TEXTAREA' }), true);
  assert.strictEqual(palette.isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.strictEqual(palette.isEditableTarget({ tagName: 'BUTTON' }), false);
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
