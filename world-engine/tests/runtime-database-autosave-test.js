'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorld } = require('../core/world-engine');
const {
  createRuntimeLoop,
  stepRuntimeLoop,
  getRuntimeLoopSummary,
} = require('../core/runtime-loop-engine');
const {
  runRuntimeAutosave,
  resolveRuntimeAutosaveMode,
} = require('../core/runtime-autosave-engine');
const { listDatabaseWorlds } = require('../core/database-engine');

function main() {
  testDirectRuntimeAutosave();
  testRuntimeLoopFileAutosave();
  testRuntimeLoopDatabaseAutosave();
  console.log('runtime database autosave test passed');
}

function testDirectRuntimeAutosave() {
  const dir = tempDir('phyrex-direct-autosave-');
  try {
    const world = createWorld({ id: 'direct_autosave_world', seed: 'direct_autosave_seed' });
    world.tick = 4;
    assert.strictEqual(resolveRuntimeAutosaveMode({ mode: 'db' }), 'database');
    const save = runRuntimeAutosave(world, { mode: 'database', database: { provider: 'jsonl', directory: dir, name: 'direct' } });
    assert.strictEqual(save.mode, 'database');
    assert.strictEqual(save.worldId, 'direct_autosave_world');
    assert.strictEqual(listDatabaseWorlds({ database: { provider: 'jsonl', directory: dir, name: 'direct' } }).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testRuntimeLoopFileAutosave() {
  const dir = tempDir('phyrex-loop-file-autosave-');
  try {
    const file = path.join(dir, 'runtime-world.json');
    const world = createWorld({ id: 'loop_file_world', seed: 'loop_file_seed' });
    const loop = createRuntimeLoop(world, {
      autosaveEveryTicks: 1,
      autosavePath: file,
      autosaveMode: 'file',
      simulation: disabledSimulation(),
    });
    const report = stepRuntimeLoop(loop, 1, { source: 'test' });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.autosave.mode, 'file');
    assert.ok(fs.existsSync(file));
    const summary = getRuntimeLoopSummary(loop);
    assert.strictEqual(summary.lastAutosave.mode, 'file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testRuntimeLoopDatabaseAutosave() {
  const dir = tempDir('phyrex-loop-db-autosave-');
  try {
    const database = { provider: 'jsonl', directory: dir, name: 'runtime-loop' };
    const world = createWorld({ id: 'loop_db_world', seed: 'loop_db_seed' });
    const loop = createRuntimeLoop(world, {
      autosaveEveryTicks: 1,
      autosaveMode: 'database',
      autosaveDatabase: database,
      simulation: disabledSimulation(),
    });
    const report = stepRuntimeLoop(loop, 1, { source: 'test' });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.autosave.mode, 'database');
    assert.strictEqual(report.autosave.provider, 'jsonl');
    const worlds = listDatabaseWorlds({ database });
    assert.strictEqual(worlds.length, 1);
    assert.strictEqual(worlds[0].worldId, 'loop_db_world');
    const summary = getRuntimeLoopSummary(loop);
    assert.strictEqual(summary.autosaveMode, 'database');
    assert.strictEqual(summary.lastAutosave.mode, 'database');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function disabledSimulation() {
  return { autoNovel: false, autoNarrative: false, population: { baseBirthChance: 0, baseMortalityChance: 0 } };
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

main();
