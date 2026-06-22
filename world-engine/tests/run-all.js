'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const tests = [
  'browser-gameplay-test.js',
  'browser-onboarding-test.js',
  'browser-character-control-test.js',
  'runtime-loop-test.js',
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

if (failed.length) process.exitCode = 1;
