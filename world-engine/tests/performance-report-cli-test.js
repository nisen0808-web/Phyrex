'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorld } = require('../core/world-engine');
const { saveWorld } = require('../core/persistence-engine');
const {
  main,
  parseArgs,
  parseNumberList,
  normalizeFormat,
  inferFormatFromOutput,
} = require('../demo/performance-report-cli');

function mainTest() {
  testArgParsing();
  testCliJsonExport();
  testCliMarkdownExport();
  console.log('performance report cli test passed');
}

function testArgParsing() {
  const args = parseArgs(['input.json', 'out.json', '--mode', 'trend', '--quiet', '--window', '5']);
  assert.strictEqual(args.input, 'input.json');
  assert.strictEqual(args.output, 'out.json');
  assert.strictEqual(args.mode, 'trend');
  assert.strictEqual(args.quiet, true);
  assert.strictEqual(normalizeFormat('md'), 'markdown');
  assert.strictEqual(inferFormatFromOutput('report.md'), 'markdown');
  assert.deepStrictEqual(parseNumberList('1,1.5,2'), [1, 1.5, 2]);
}

function testCliJsonExport() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-performance-report-cli-'));
  try {
    const input = path.join(dir, 'world-save.json');
    const output = path.join(dir, 'report.json');
    saveWorld(buildWorld(), input, { createBackup: false, reason: 'performance_cli_test' });
    const report = main([input, output, '--mode', 'operations', '--quiet', '--multipliers', '1,2']);
    assert.ok(fs.existsSync(output));
    const exported = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.strictEqual(exported.pressure.scenarioCount, 2);
    assert.strictEqual(report.pressure.highestRisk.name, 'x2');
    assert.ok(exported.recommendations.length >= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testCliMarkdownExport() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-performance-report-md-'));
  try {
    const input = path.join(dir, 'world-save.json');
    const output = path.join(dir, 'report.md');
    saveWorld(buildWorld(), input, { createBackup: false, reason: 'performance_cli_markdown_test' });
    const report = main([input, output, '--mode', 'operations', '--quiet', '--format', 'markdown', '--multipliers', '1,2']);
    assert.ok(fs.existsSync(output));
    const markdown = fs.readFileSync(output, 'utf8');
    assert.ok(markdown.includes('# operations performance report'));
    assert.ok(markdown.includes('## Trend'));
    assert.ok(markdown.includes('## Pressure Scenarios'));
    assert.ok(markdown.includes('## Recommendations'));
    assert.strictEqual(report.pressure.highestRisk.name, 'x2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function buildWorld() {
  const world = createWorld({ id: 'performance-cli-world', seed: 'performance-cli-seed' });
  world.tick = 12;
  world.kernel = {
    performance: {
      samples: [sample(10, 80, 20, 0, 0), sample(11, 120, 35, 1, 0), sample(12, 160, 45, 1, 1)],
      last: sample(12, 160, 45, 1, 1),
      stats: { samples: 3, warnings: 2, violations: 1, maxTotalLoad: 160 },
    },
  };
  return world;
}

function sample(tick, totalLoad, maxSystemLoad, warnings, violations) {
  return {
    tick,
    totalLoad,
    maxSystemLoad,
    warnings,
    violations,
    ok: violations === 0,
    topSystems: [
      { systemId: 'economy.production', load: maxSystemLoad, budget: 2800 },
      { systemId: 'agency.opportunity', load: maxSystemLoad * 0.8, budget: 2400 },
    ],
  };
}

mainTest();
