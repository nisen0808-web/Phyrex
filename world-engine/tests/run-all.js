'use strict';

const path = require('path');

const tests = [
  'smoke-test.js',
  'information-memory-test.js',
  'identity-culture-test.js',
  'religion-civilization-test.js',
  'desire-opportunity-test.js',
];

for (const test of tests) {
  const file = path.join(__dirname, test);
  require(file);
}

console.log(`world-engine test runner passed ${tests.length} tests`);
