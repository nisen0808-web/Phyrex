'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const tests = [
  'smoke-test.js',
  'information-memory-test.js',
  'identity-culture-test.js',
  'religion-civilization-test.js',
  'desire-opportunity-test.js',
  'process-emergence-test.js',
  'governance-conflict-test.js',
  'technology-infrastructure-test.js',
  'snapshot-test.js',
  'viewer-test.js',
  'player-command-test.js',
  'shell-engine-test.js',
  'shell-script-test.js',
  'quest-tutorial-report-test.js',
  'map-alias-test.js',
  'query-content-test.js',
  'journal-encounter-board-test.js',
  'item-inventory-shop-test.js',
  'stability-100-test.js',
];

const results = [];

for (const test of tests) {
  const file = path.join(__dirname, test);
  const result = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  const passed = result.status === 0;
  results.push({ test, passed, status: result.status, stdout: result.stdout, stderr: result.stderr });

  if (passed) {
    console.log(`PASS ${test}`);
  } else {
    console.error(`FAIL ${test}`);
    if (result.stdout) console.error(result.stdout);
    if (result.stderr) console.error(result.stderr);
  }
}

const failed = results.filter(result => !result.passed);
console.log(`world-engine test runner completed ${tests.length} tests: ${tests.length - failed.length} passed, ${failed.length} failed`);

if (failed.length) {
  process.exitCode = 1;
}
