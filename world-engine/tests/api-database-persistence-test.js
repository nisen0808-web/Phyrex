'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorld } = require('../core/world-engine');
const {
  saveWorldForApi,
  loadWorldForApi,
  listWorldSavesForApi,
  getApiPersistenceStatus,
  resolvePersistenceMode,
} = require('../core/api-database-persistence-engine');

function main() {
  testFileMode();
  testDatabaseMode();
  console.log('api database persistence test passed');
}

function testFileMode() {
  const dir = tempDir('phyrex-api-file-');
  try {
    const filePath = path.join(dir, 'world.json');
    const world = createWorld({ id: 'api_file_world', seed: 'api_file_seed' });
    world.tick = 3;
    const saved = saveWorldForApi(world, { path: filePath }, { defaultSavePath: filePath });
    assert.strictEqual(saved.mode, 'file');
    assert.ok(fs.existsSync(filePath));
    const loaded = loadWorldForApi({ path: filePath }, { defaultSavePath: filePath });
    assert.strictEqual(loaded.loaded.world.id, 'api_file_world');
    const saves = listWorldSavesForApi({ dir }, {});
    assert.strictEqual(saves.mode, 'file');
    assert.strictEqual(saves.saves.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testDatabaseMode() {
  const dir = tempDir('phyrex-api-db-');
  try {
    const database = { provider: 'jsonl', directory: dir, name: 'api-test' };
    const world = createWorld({ id: 'api_db_world', seed: 'api_db_seed' });
    world.tick = 11;
    assert.strictEqual(resolvePersistenceMode({ persistence: 'db' }, {}), 'database');
    const saved = saveWorldForApi(world, { persistence: 'database', database }, {});
    assert.strictEqual(saved.mode, 'database');
    assert.strictEqual(saved.save.worldId, 'api_db_world');
    const loaded = loadWorldForApi({ persistence: 'database', database, worldId: 'api_db_world' }, {});
    assert.strictEqual(loaded.loaded.world.id, 'api_db_world');
    assert.strictEqual(loaded.loaded.world.tick, 11);
    const listed = listWorldSavesForApi({ persistence: 'database', database }, {});
    assert.strictEqual(listed.saves.length, 1);
    assert.strictEqual(listed.database.records, 1);
    const status = getApiPersistenceStatus({ persistence: 'database', database }, {});
    assert.strictEqual(status.database.provider, 'jsonl');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

main();
