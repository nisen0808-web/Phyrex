'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function main() {
  const root = path.join(__dirname, '..');
  const indexPath = path.join(root, 'viewer', 'index.html');
  const appPath = path.join(root, 'viewer', 'app.js');
  const stylePath = path.join(root, 'viewer', 'styles.css');
  const serverPath = path.join(root, 'viewer', 'serve-viewer.js');

  for (const file of [indexPath, appPath, stylePath, serverPath]) {
    assert.ok(fs.existsSync(file), `${file} should exist`);
  }

  const html = fs.readFileSync(indexPath, 'utf8');
  const app = fs.readFileSync(appPath, 'utf8');
  const css = fs.readFileSync(stylePath, 'utf8');
  const server = fs.readFileSync(serverPath, 'utf8');

  assert.ok(html.includes('snapshot-url'), 'viewer html should include snapshot url input');
  assert.ok(html.includes('metrics'), 'viewer html should include metrics mount');
  assert.ok(html.includes('players'), 'viewer html should include players mount');
  assert.ok(html.includes('commands'), 'viewer html should include commands mount');
  assert.ok(html.includes('tutorials'), 'viewer html should include tutorials mount');
  assert.ok(html.includes('quests'), 'viewer html should include quests mount');
  assert.ok(html.includes('journals'), 'viewer html should include journals mount');
  assert.ok(html.includes('encounters'), 'viewer html should include encounters mount');
  assert.ok(html.includes('questBoards'), 'viewer html should include quest board mount');
  assert.ok(html.includes('raw'), 'viewer html should include raw snapshot mount');
  assert.ok(app.includes('loadSnapshot'), 'viewer app should load snapshots');
  assert.ok(app.includes('renderMetrics'), 'viewer app should render metrics');
  assert.ok(app.includes('renderPlayers'), 'viewer app should render players');
  assert.ok(app.includes('renderCommands'), 'viewer app should render commands');
  assert.ok(app.includes('renderTutorials'), 'viewer app should render tutorials');
  assert.ok(app.includes('renderQuests'), 'viewer app should render quests');
  assert.ok(app.includes('renderJournals'), 'viewer app should render journals');
  assert.ok(app.includes('renderEncounters'), 'viewer app should render encounters');
  assert.ok(app.includes('renderQuestBoards'), 'viewer app should render quest boards');
  assert.ok(app.includes('escapeHtml'), 'viewer app should escape HTML');
  assert.ok(css.includes('.card'), 'viewer css should style cards');
  assert.ok(server.includes('http.createServer'), 'viewer server should create HTTP server');
  assert.ok(server.includes('output/demo-snapshot.json'), 'viewer server should mention default snapshot');

  console.log('viewer smoke test passed');
}

main();
