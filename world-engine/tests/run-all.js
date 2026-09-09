'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function discoverTests(directory = __dirname) {
  // The long stress test has its own mandatory CI job. All other regression
  // scripts, including future additions, run from both npm entrypoints.
  return fs.readdirSync(directory)
    .filter(name => name.endsWith('-test.js') && name !== 'stability-1000-test.js')
    .sort();
}

function main() {
  const tests = discoverTests();
  if (!tests.length) throw new Error('No world-engine regression tests discovered');
  const results = [];
  for (const test of tests) {
    const result = spawnSync(process.execPath, [path.join(__dirname, test)], {
      encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
    });
    const passed = result.status === 0 && !result.error;
    results.push({ test, passed });
    if (passed) {
      console.log(`PASS ${test}`);
    } else {
      console.error(`FAIL ${test}`);
      if (result.error) console.error(result.error.message);
      if (result.signal) console.error(`Terminated by ${result.signal}`);
      if (result.stdout) console.error(result.stdout);
      if (result.stderr) console.error(result.stderr);
    }
  }
  const failed = results.filter(result => !result.passed);
  console.log(`world-engine test runner completed ${tests.length} tests: ${tests.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) process.exitCode = 1;
  return results;
}

if (require.main === module) main();
module.exports = { discoverTests, main };
