'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const tests = [
  'world-template-test.js',
  'stability-100-test.js',
];

const results = [];
for (const test of tests) {
  const result = spawnSync(process.execPath, [path.join(__dirname, test)], { encoding: 'utf8' });
  const passed = result.status === 0;
  results.push({ test, passed });
  if (passed) console.log(`PASS ${test}`);
  else {
    console.error(`FAIL ${test}`);
    if (result.stdout) console.error(result.stdout);
    if (result.stderr) console.error(result.stderr);
  }
}
const failed = results.filter(result => !result.passed);
console.log(`world-engine test runner completed ${tests.length} tests: ${tests.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;
