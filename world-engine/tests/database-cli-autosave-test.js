'use strict';

const assert = require('assert');
const {
  parseArgs,
  endpoints,
  buildRuntimeLoopOptions,
  buildDatabaseOptions,
} = require('../demo/api-server');

function main() {
  const args = parseArgs([
    '--auto-loop',
    '--autosave-every', '25',
    '--autosave-mode', 'database',
    '--db-provider', 'jsonl',
    '--db-dir', 'world-engine/data/db',
    '--db-name', 'world-engine',
    '--db-auto-create', 'true',
    '--interval', '500',
    '--ticks-per-cycle', '2',
  ]);

  assert.strictEqual(args.autoLoop, true);
  assert.strictEqual(args.autosaveMode, 'database');
  assert.strictEqual(args.dbProvider, 'jsonl');

  const database = buildDatabaseOptions(args);
  assert.strictEqual(database.provider, 'jsonl');
  assert.strictEqual(database.directory, 'world-engine/data/db');
  assert.strictEqual(database.name, 'world-engine');
  assert.strictEqual(database.autoCreate, 'true');

  const runtimeLoop = buildRuntimeLoopOptions(args, { savePath: 'fallback.json' });
  assert.strictEqual(runtimeLoop.intervalMs, 500);
  assert.strictEqual(runtimeLoop.ticksPerCycle, 2);
  assert.strictEqual(runtimeLoop.autosaveEveryTicks, 25);
  assert.strictEqual(runtimeLoop.autosaveMode, 'database');
  assert.strictEqual(runtimeLoop.autosavePath, null);
  assert.strictEqual(runtimeLoop.autosaveDatabase.name, 'world-engine');

  const fileLoop = buildRuntimeLoopOptions({ autosaveEvery: '10', autosaveMode: 'file' }, { savePath: 'fallback.json' });
  assert.strictEqual(fileLoop.autosavePath, 'fallback.json');

  assert.ok(endpoints().includes('GET /admin/database'));
  console.log('database cli autosave test passed');
}

main();
