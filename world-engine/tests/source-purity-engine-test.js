'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  scanSourceText,
  scanSourceDirectory,
  summarizeFindings,
  assertSourcePurity,
  createPurityBaseline,
  compareToPurityBaseline,
  stripCommentsPreservingLines,
} = require('../core/source-purity-engine');

function main() {
  testTextScanning();
  testCommentStrippingAndDirectives();
  testDirectoryScanningAndBaseline();
  testAssertionFailure();
  console.log('source purity engine test passed');
}

function testTextScanning() {
  const source = [
    "const value = Math.random();",
    "const now = Date.now();",
    "const date = new Date();",
    "const elapsed = performance.now();",
    "const hr = process.hrtime();",
  ].join('\n');
  const findings = scanSourceText(source, 'core/bad-engine.js');
  assert.strictEqual(findings.length, 5);
  assert.deepStrictEqual(findings.map(item => item.ruleId), [
    'implicit_math_random',
    'implicit_date_now',
    'implicit_new_date',
    'implicit_performance_now',
    'implicit_process_hrtime',
  ]);
  const summary = summarizeFindings(findings);
  assert.strictEqual(summary.total, 5);
  assert.strictEqual(summary.errors, 2);
  assert.strictEqual(summary.warnings, 3);
  assert.strictEqual(summary.byRule.implicit_math_random, 1);
}

function testCommentStrippingAndDirectives() {
  const commented = [
    '// Math.random() should not be counted in comments',
    '/* Date.now() should not be counted in block comments */',
    "const text = 'new Date() inside string should still be visible to the scanner';",
    'const allowed = Math.random(); // source-purity-allow: implicit_math_random',
    'const blocked = Date.now();',
  ].join('\n');
  const stripped = stripCommentsPreservingLines(commented);
  assert.strictEqual(stripped.split('\n').length, commented.split('\n').length);

  const findings = scanSourceText(commented, 'core/commented.js');
  assert.strictEqual(findings.length, 2);
  assert.strictEqual(findings[0].ruleId, 'implicit_new_date');
  assert.strictEqual(findings[1].ruleId, 'implicit_date_now');

  const allowlisted = scanSourceText('const now = Date.now();', 'core/allowlisted.js', {
    allowlist: [{ file: 'core/allowlisted.js', line: 1, ruleId: 'implicit_date_now' }],
  });
  assert.deepStrictEqual(allowlisted, []);
}

function testDirectoryScanningAndBaseline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-source-purity-'));
  try {
    fs.mkdirSync(path.join(dir, 'core'));
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'core', 'clean.js'), [
      "const { createRandomContext } = require('./random-engine');",
      'function run(context) { return context.random.float(); }',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'core', 'bad.js'), [
      'function bad() {',
      '  return Math.random() + Date.now();',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'ignored.js'), 'Math.random();');

    const report = scanSourceDirectory(dir);
    assert.strictEqual(report.files, 2);
    assert.strictEqual(report.findings.length, 2);
    assert.strictEqual(report.summary.errors, 2);
    assert.ok(report.findings.every(item => item.file.endsWith('/core/bad.js')));

    const baseline = createPurityBaseline(report);
    const comparison = compareToPurityBaseline(report, baseline);
    assert.strictEqual(comparison.ok, true);
    assert.deepStrictEqual(comparison.newFindings, []);

    fs.writeFileSync(path.join(dir, 'core', 'new-bad.js'), 'const date = new Date();');
    const changed = scanSourceDirectory(dir);
    const drift = compareToPurityBaseline(changed, baseline);
    assert.strictEqual(drift.ok, false);
    assert.strictEqual(drift.newFindings.length, 1);
    assert.strictEqual(drift.newFindings[0].ruleId, 'implicit_new_date');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testAssertionFailure() {
  const report = {
    root: 'memory',
    findings: scanSourceText('Math.random(); Date.now();', 'core/fail.js'),
  };
  report.summary = summarizeFindings(report.findings);
  assert.throws(
    () => assertSourcePurity(report),
    error => error.code === 'source_purity_failed' && error.message.includes('implicit_math_random'),
  );
  assert.doesNotThrow(() => assertSourcePurity(report, { maxErrors: 2 }));
}

main();
