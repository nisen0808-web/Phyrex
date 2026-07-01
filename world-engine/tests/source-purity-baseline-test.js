'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { scanSourceDirectory } = require('../core/source-purity-engine');
const { compareReportToRelativeBaseline } = require('../core/source-purity-baseline-engine');

function main() {
  const root = path.resolve(__dirname, '..', 'core');
  const baseline = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'SOURCE_PURITY_BASELINE.json'), 'utf8'));
  const report = scanSourceDirectory(root, {
    ignoreFiles: new Set(['source-purity-engine.js', 'source-purity-baseline-engine.js']),
  });
  assert.ok(report.files >= 40, `expected core scan to cover many files, got ${report.files}`);
  const comparison = compareReportToRelativeBaseline(report, baseline, { root });
  assert.strictEqual(comparison.newFindings.length, 0, JSON.stringify(comparison.newFindings, null, 2));
  console.log('source purity baseline test passed');
}

main();
