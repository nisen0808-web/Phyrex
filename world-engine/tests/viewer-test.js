'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { summarizeRecentEventTypes } = require('../core/database-viewer-summary-engine');

function main() {
  const root = path.join(__dirname, '..');
  const indexPath = path.join(root, 'viewer', 'index.html');
  const appPath = path.join(root, 'viewer', 'app.js');
  const databaseAppPath = path.join(root, 'viewer', 'database-summary.js');
  const databaseReportPath = path.join(root, 'viewer', 'database-report.html');
  const databaseReportAppPath = path.join(root, 'viewer', 'database-report.js');
  const pagesPath = path.join(root, 'viewer', 'pages.json');
  const stylePath = path.join(root, 'viewer', 'styles.css');
  const serverPath = path.join(root, 'viewer', 'serve-viewer.js');
  const databaseSummaryPath = path.join(root, 'core', 'database-viewer-summary-engine.js');

  for (const file of [indexPath, appPath, databaseAppPath, databaseReportPath, databaseReportAppPath, pagesPath, stylePath, serverPath, databaseSummaryPath]) assert.ok(fs.existsSync(file), `${file} should exist`);

  const html = fs.readFileSync(indexPath, 'utf8');
  const app = fs.readFileSync(appPath, 'utf8');
  const databaseApp = fs.readFileSync(databaseAppPath, 'utf8');
  const databaseReport = fs.readFileSync(databaseReportPath, 'utf8');
  const databaseReportApp = fs.readFileSync(databaseReportAppPath, 'utf8');
  const pages = JSON.parse(fs.readFileSync(pagesPath, 'utf8'));
  const css = fs.readFileSync(stylePath, 'utf8');
  const server = fs.readFileSync(serverPath, 'utf8');
  const databaseSummary = fs.readFileSync(databaseSummaryPath, 'utf8');

  assert.ok(html.includes('snapshot-url'), 'viewer html should include snapshot url input');
  assert.ok(html.includes('metrics'), 'viewer html should include metrics mount');
  assert.ok(html.includes('players'), 'viewer html should include players mount');
  assert.ok(html.includes('commands'), 'viewer html should include commands mount');
  assert.ok(html.includes('tutorials'), 'viewer html should include tutorials mount');
  assert.ok(html.includes('quests'), 'viewer html should include quests mount');
  assert.ok(html.includes('journals'), 'viewer html should include journals mount');
  assert.ok(html.includes('encounters'), 'viewer html should include encounters mount');
  assert.ok(html.includes('questBoards'), 'viewer html should include quest board mount');
  assert.ok(html.includes('items'), 'viewer html should include items mount');
  assert.ok(html.includes('shops'), 'viewer html should include shops mount');
  assert.ok(html.includes('database-url'), 'viewer html should include database summary url input');
  assert.ok(html.includes('databaseSummary'), 'viewer html should include database summary mount');
  assert.ok(html.includes('databaseHealth'), 'viewer html should include database health mount');
  assert.ok(html.includes('database-summary.js'), 'viewer html should load database summary script');
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
  assert.ok(app.includes('renderItems'), 'viewer app should render items');
  assert.ok(app.includes('renderShops'), 'viewer app should render shops');
  assert.ok(app.includes('escapeHtml'), 'viewer app should escape HTML');
  assert.ok(databaseApp.includes('loadDatabaseSummary'), 'database viewer app should load summary');
  assert.ok(databaseApp.includes('renderDatabaseSummary'), 'database viewer app should render summary');
  assert.ok(databaseApp.includes('renderDatabaseHealth'), 'database viewer app should render health');
  assert.ok(databaseReport.includes('database-report-url'), 'database report page should include report url input');
  assert.ok(databaseReport.includes('databaseReportRaw'), 'database report page should include raw report mount');
  assert.ok(databaseReportApp.includes('loadDatabaseReport'), 'database report app should load report');
  assert.ok(databaseReportApp.includes('renderDatabaseReport'), 'database report app should render report');
  assert.ok(databaseReportApp.includes('renderReportFiles'), 'database report app should render files');
  assert.strictEqual(pages.version, 1);
  assert.ok(pages.pages.some(page => page.href === './index.html'));
  assert.ok(pages.pages.some(page => page.href === './database-report.html'));
  assert.ok(css.includes('.card'), 'viewer css should style cards');
  assert.ok(server.includes('http.createServer'), 'viewer server should create HTTP server');
  assert.ok(server.includes('output/demo-snapshot.json'), 'viewer server should mention default snapshot');
  assert.ok(server.includes('viewer/database-report.html'), 'viewer server should mention database report page');
  assert.ok(databaseSummary.includes('buildDatabaseViewerSummary'), 'database viewer summary should expose builder');
  assert.ok(databaseSummary.includes('summarizeDatabaseHealth'), 'database viewer summary should expose health summary');
  assert.deepStrictEqual(summarizeRecentEventTypes([{ type: 'b' }, { type: 'a' }, { type: 'b' }]), [
    { type: 'b', count: 2 },
    { type: 'a', count: 1 },
  ]);

  console.log('viewer smoke test passed');
}

main();
