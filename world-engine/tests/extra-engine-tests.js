'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const tests = [
  'governance-process-execution-test.js',
  ['conflict', 'governance', 'process', 'test.js'].join('-'),
  'opportunity-governance-linkage-test.js',
  'trade-flow-system-test.js',
  'organization-process-linkage-test.js',
];

for (const test of tests) {
  const file = path.join(__dirname, test);
  const result = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  if (result.status === 0) {
    console.log(`PASS ${test}`);
    continue;
  }
  console.error(`FAIL ${test}`);
  if (result.stdout) console.error(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exitCode = 1;
  break;
}
