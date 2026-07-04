'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorld } = require('../core/world-engine');
const {
  loadDatabaseConfig,
  DATABASE_PROVIDERS,
} = require('../core/database-config-engine');
const {
  createDatabaseStore,
  saveWorldToDatabase,
  loadWorldFromDatabase,
  listDatabaseWorlds,
  appendDatabaseEvent,
  getDatabaseStatus,
} = require('../core/database-engine');
const {
  buildDatabaseCheckReport,
  inspectJsonLineFile,
  summarizeDatabaseCheckReport,
} = require('../core/database-check-report-engine');

function main() {
  testDatabaseConfig();
  testDatabaseStore();
  testDatabaseCheckReport();
  console.log('database config test passed');
}

function testDatabaseConfig() {
  const dir = tempDir('phyrex-db-config-');
  try {
    const config = loadDatabaseConfig({}, {
      WORLD_ENGINE_DB_PROVIDER: 'jsonl',
      WORLD_ENGINE_DB_DIR: dir,
      WORLD_ENGINE_DB_NAME: 'test world',
    });
    assert.strictEqual(config.provider, DATABASE_PROVIDERS.JSONL);
    assert.ok(config.worldsFile.endsWith('test_world-worlds.jsonl'));
    assert.ok(config.eventsFile.endsWith('test_world-events.jsonl'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testDatabaseStore() {
  const dir = tempDir('phyrex-db-store-');
  try {
    const database = { provider: 'jsonl', directory: dir, name: 'runtime-test' };
    const world = createWorld({ id: 'db_world', seed: 'db_seed' });
    world.tick = 7;

    const saved = saveWorldToDatabase(world, { database, reason: 'test_save' });
    assert.strictEqual(saved.worldId, 'db_world');
    assert.strictEqual(saved.tick, 7);

    world.tick = 8;
    const store = createDatabaseStore(database);
    const saved2 = store.saveWorld(world, { reason: 'test_save_2' });
    assert.strictEqual(saved2.tick, 8);

    const loaded = loadWorldFromDatabase('db_world', { database });
    assert.strictEqual(loaded.world.id, 'db_world');
    assert.strictEqual(loaded.world.tick, 8);

    const worlds = listDatabaseWorlds({ database });
    assert.strictEqual(worlds.length, 1);
    assert.strictEqual(worlds[0].tick, 8);

    const event = appendDatabaseEvent({ worldId: 'db_world', tick: 8, type: 'test.event', payload: { ok: true } }, { database });
    assert.strictEqual(event.type, 'test.event');

    const status = getDatabaseStatus(database);
    assert.strictEqual(status.records, 2);
    assert.strictEqual(status.events, 1);
    assert.ok(fs.existsSync(status.schemaFile));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testDatabaseCheckReport() {
  const dir = tempDir('phyrex-db-check-');
  try {
    const database = { provider: 'jsonl', directory: dir, name: 'check-test' };
    const world = createWorld({ id: 'check_world', seed: 'check_seed' });
    world.tick = 3;
    saveWorldToDatabase(world, { database, reason: 'check_test' });
    appendDatabaseEvent({ worldId: 'check_world', tick: 3, type: 'check.event', payload: { ok: true } }, { database });

    const report = buildDatabaseCheckReport({ database });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.counts.worlds, 1);
    assert.strictEqual(report.counts.events, 1);
    assert.strictEqual(report.files.worlds.recordTypes.world_save, 1);
    assert.strictEqual(report.files.events.recordTypes.world_event, 1);

    const summary = summarizeDatabaseCheckReport(report);
    assert.strictEqual(summary.records, 1);
    assert.strictEqual(summary.events, 1);
    assert.strictEqual(summary.errors, 0);

    const badFile = path.join(dir, 'bad.jsonl');
    fs.writeFileSync(badFile, '{"recordType":"world_save","sequence":1}\nnot-json\n', 'utf8');
    const bad = inspectJsonLineFile(badFile, { expectedRecordType: 'world_save' });
    assert.strictEqual(bad.records, 1);
    assert.strictEqual(bad.parseErrors.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

main();
