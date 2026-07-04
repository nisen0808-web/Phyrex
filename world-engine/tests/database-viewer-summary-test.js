'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorld } = require('../core/world-engine');
const { saveWorldToDatabase, appendDatabaseEvent } = require('../core/database-engine');
const {
  buildDatabaseViewerSummary,
  summarizeRecentEventTypes,
} = require('../core/database-viewer-summary-engine');

function main() {
  testDatabaseViewerSummary();
  testRecentEventTypeSummary();
  console.log('database viewer summary test passed');
}

function testDatabaseViewerSummary() {
  const dir = tempDir('phyrex-db-viewer-summary-');
  try {
    const database = { provider: 'jsonl', directory: dir, name: 'viewer-summary' };
    const world = createWorld({ id: 'viewer_world', seed: 'viewer_seed' });
    world.tick = 12;
    saveWorldToDatabase(world, { database, reason: 'viewer_summary_test' });
    appendDatabaseEvent({ worldId: 'viewer_world', tick: 12, type: 'system.alpha', payload: { ok: true } }, { database });
    appendDatabaseEvent({ worldId: 'viewer_world', tick: 12, type: 'system.alpha', payload: { ok: true } }, { database });
    appendDatabaseEvent({ worldId: 'viewer_world', tick: 12, type: 'system.beta', payload: { ok: true } }, { database });

    const summary = buildDatabaseViewerSummary({ database, eventLimit: 10 });
    assert.strictEqual(summary.status.provider, 'jsonl');
    assert.strictEqual(summary.totals.records, 1);
    assert.strictEqual(summary.totals.events, 3);
    assert.strictEqual(summary.latestWorld.worldId, 'viewer_world');
    assert.strictEqual(summary.health.ok, true);
    assert.strictEqual(summary.health.latestTick, 12);
    assert.strictEqual(summary.health.recentEventTypes[0].type, 'system.alpha');
    assert.strictEqual(summary.health.recentEventTypes[0].count, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testRecentEventTypeSummary() {
  const types = summarizeRecentEventTypes([
    { type: 'b' },
    { type: 'a' },
    { type: 'b' },
  ]);
  assert.deepStrictEqual(types, [
    { type: 'b', count: 2 },
    { type: 'a', count: 1 },
  ]);
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

main();
