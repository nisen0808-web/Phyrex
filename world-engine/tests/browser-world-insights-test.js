'use strict';

const assert = require('assert');
const http = require('http');
const vm = require('vm');
const insights = require('../client/world-insights-model');
const { createWorldApiServer } = require('../core/world-template-api-engine');

async function main() {
  testWorldInsightsModel();

  const { server } = createWorldApiServer(null, { seedTicks: 5 });
  const base = await listen(server);
  try {
    const snapshot = await requestJson(base, '/snapshot');
    assert.strictEqual(snapshot.ok, true, 'snapshot endpoint should remain available');
    const view = insights.buildInsightView(snapshot.data);
    assert.ok(view.world.id, 'live snapshot should produce an insight world id');
    assert.ok(view.metrics.population >= view.metrics.alive, 'population metrics should be coherent');

    const index = await request(base, '/client');
    assert.ok(index.text.includes('/client/world-insights-model.js'));
    assert.ok(index.text.includes('/client/world-insights.js'));
    assert.ok(index.text.includes('/client/world-insights.css'));

    const modelScript = await request(base, '/client/world-insights-model.js');
    assert.strictEqual(modelScript.statusCode, 200);
    assert.ok(modelScript.headers['content-type'].includes('application/javascript'));
    assert.ok(modelScript.text.includes('buildInsightView'));
    assert.ok(modelScript.text.includes('createTextSummary'));
    new vm.Script(modelScript.text, { filename: 'world-insights-model.js' });

    const controller = await request(base, '/client/world-insights.js');
    assert.strictEqual(controller.statusCode, 200);
    assert.ok(controller.headers['content-type'].includes('application/javascript'));
    assert.ok(controller.text.includes('refreshWorldInsights'));
    assert.ok(controller.text.includes('copyWorldInsightsSummary'));
    assert.ok(controller.text.includes('exportWorldSnapshot'));
    assert.ok(controller.text.includes("worldInsightsRequest('/snapshot')"));
    new vm.Script(controller.text, { filename: 'world-insights.js' });

    const stylesheet = await request(base, '/client/world-insights.css');
    assert.strictEqual(stylesheet.statusCode, 200);
    assert.ok(stylesheet.headers['content-type'].includes('text/css'));
    assert.ok(stylesheet.text.includes('.world-insights-panel'));
    assert.ok(stylesheet.text.includes('.world-insights-rank-row'));

    console.log('browser world insights integration test passed');
  } finally {
    await close(server);
  }
}

function testWorldInsightsModel() {
  const snapshot = {
    world: { id: 'insight_world', tick: 42, calendar: { phase: 'day' } },
    population: {
      total: 10,
      alive: 8,
      dead: 2,
      averagePower: 12.345,
      averageHappiness: 67.5,
      byLocation: { qingyun_city: 5, mist_forest: 3 },
      bySpecies: { human: 7, spirit: 1 },
    },
    players: { total: 2 },
    quests: { total: 4, active: 2 },
    commands: {
      total: 3,
      recent: [{ id: 'cmd_1', type: 'work', status: 'completed', createdAt: 40 }],
    },
    offlineCommands: { total: 1 },
    items: { instances: 12 },
    shops: { total: 2 },
    narrative: {
      topEntities: [
        { entityId: 'hero', name: 'Hero', totalScore: 25, locationId: 'qingyun_city' },
        { entityId: 'rival', name: 'Rival', totalScore: 18 },
      ],
    },
    cities: [{ id: 'city', name: 'City', population: 100, wealth: 20, security: 30 }],
    organizations: [{ id: 'sect', name: 'Sect', members: 8, authority: 20, reputation: 10 }],
    civilizations: [{ id: 'civ', name: 'Civ', score: 99, level: 2, cities: 1, organizations: 1 }],
    journals: { recent: [{ id: 'journal_1', tick: 42, title: 'Arrival', summary: 'Entered city', type: 'travel' }] },
    encounters: { recent: [{ id: 'enc_1', createdAt: 41, title: 'Bandits', status: 'resolved', type: 'combat' }] },
    recentReports: [{ id: 'report_1', tick: 39, type: 'economy', summary: 'Market shifted' }],
    limits: { memory: 5 },
  };

  const view = insights.buildInsightView(snapshot, { rankingLimit: 5 });
  assert.strictEqual(view.world.id, 'insight_world');
  assert.strictEqual(view.metrics.alive, 8);
  assert.strictEqual(view.locations[0].id, 'qingyun_city');
  assert.strictEqual(view.locations[0].share, 0.625);
  assert.strictEqual(view.rankings.entities[0].name, 'Hero');
  assert.strictEqual(view.rankings.cities[0].name, 'City');
  assert.strictEqual(view.rankings.organizations[0].name, 'Sect');
  assert.strictEqual(view.rankings.civilizations[0].score, 99);
  assert.strictEqual(view.activity[0].id, 'journal_1');
  assert.strictEqual(insights.filterActivity(view.activity, 'market').length, 1);
  assert.strictEqual(insights.filterActivity(view.activity, '', 'encounter').length, 1);
  const summary = insights.createTextSummary(view);
  assert.ok(summary.includes('insight_world'));
  assert.ok(summary.includes('Hero'));
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
