'use strict';

const fs = require('fs');
const path = require('path');
const { loadWorld } = require('../core/persistence-engine');
const {
  createPerformanceOperationsReport,
  createPerformanceTrendReport,
  createPerformancePressureScenarioReport,
} = require('../core/performance-report-engine');
const { formatPerformanceReportMarkdown } = require('../core/performance-markdown-engine');

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(helpText());
    return { help: true };
  }

  const format = normalizeFormat(args.format || inferFormatFromOutput(args.output) || 'json');
  const input = args.input || path.join(__dirname, '..', 'output', 'runtime-world-save.json');
  const output = args.output || path.join(__dirname, '..', 'output', format === 'markdown' ? 'performance-report.md' : 'performance-report.json');
  const mode = args.mode || 'operations';
  const loaded = loadWorld(input);
  const world = loaded.world;
  const options = {
    windowSize: Number(args.window || args.windowSize || 20),
    topSystemsLimit: Number(args.top || args.topSystemsLimit || 8),
  };
  const scenarios = buildScenarios(world, args);
  const report = createSelectedReport(mode, world, scenarios, options);
  const rendered = renderReport(report, format, { title: `${mode} performance report` });

  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, rendered, 'utf8');

  if (!args.quiet) {
    console.log(`Performance report exported: ${output}`);
    console.log(`Mode: ${mode}`);
    console.log(`Format: ${format}`);
    console.log(`World: ${loaded.worldId}`);
    console.log(`Tick: ${loaded.tick}`);
    printSummary(mode, report);
  }
  return report;
}

function createSelectedReport(mode, world, scenarios, options) {
  if (mode === 'trend') return createPerformanceTrendReport(world, options);
  if (mode === 'pressure') return createPerformancePressureScenarioReport(world, scenarios, options);
  if (mode === 'operations') return createPerformanceOperationsReport(world, scenarios, options);
  throw new Error(`Unsupported performance report mode ${mode}`);
}

function renderReport(report, format, options = {}) {
  if (format === 'json') return JSON.stringify(report, null, 2);
  if (format === 'markdown') return formatPerformanceReportMarkdown(report, options);
  throw new Error(`Unsupported performance report format ${format}`);
}

function buildScenarios(world, args) {
  const samples = Array.isArray(world.kernel?.performance?.samples) ? world.kernel.performance.samples : [];
  const last = samples[samples.length - 1] || world.kernel?.performance?.last || null;
  if (!last) return [];
  const multipliers = parseNumberList(args.multipliers || args.multiplier || '1,1.5,2');
  return multipliers.map(multiplier => ({
    name: multiplier === 1 ? 'base' : `x${multiplier}`,
    sample: last,
    multiplier,
  }));
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--quiet') out.quiet = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        index += 1;
      } else {
        out[key] = true;
      }
    } else if (!out.input) out.input = arg;
    else if (!out.output) out.output = arg;
  }
  return out;
}

function parseNumberList(value) {
  return String(value || '')
    .split(',')
    .map(item => Number(item.trim()))
    .filter(item => Number.isFinite(item) && item > 0);
}

function normalizeFormat(value) {
  const format = String(value || 'json').trim().toLowerCase();
  if (format === 'md') return 'markdown';
  if (format === 'markdown' || format === 'json') return format;
  throw new Error(`Unsupported performance report format ${format}`);
}

function inferFormatFromOutput(output) {
  if (!output) return null;
  const extension = path.extname(String(output)).toLowerCase();
  if (extension === '.md' || extension === '.markdown') return 'markdown';
  if (extension === '.json') return 'json';
  return null;
}

function printSummary(mode, report) {
  if (mode === 'trend') {
    console.log(`Samples: ${report.sampleCount}`);
    console.log(`Trend: ${report.trend.direction}`);
    console.log(`Average total load: ${report.averageTotalLoad}`);
    return;
  }
  if (mode === 'pressure') {
    console.log(`Scenarios: ${report.scenarioCount}`);
    console.log(`Highest risk: ${report.highestRisk?.name || 'none'}`);
    return;
  }
  console.log(`Trend: ${report.trend.trend.direction}`);
  console.log(`Scenarios: ${report.pressure.scenarioCount}`);
  console.log(`Recommendations: ${report.recommendations.length}`);
}

function helpText() {
  return [
    'Usage:',
    '  node demo/performance-report-cli.js [input-save] [output-file] [--mode operations|trend|pressure] [--format json|markdown]',
    '',
    'Options:',
    '  --input <file>         Save file path',
    '  --output <file>        Output report path',
    '  --mode <mode>          operations, trend, or pressure',
    '  --format <format>      json or markdown',
    '  --window <number>      Trend window size',
    '  --top <number>         Top systems limit',
    '  --multipliers <list>   Pressure multipliers, for example 1,1.5,2',
    '  --quiet                Do not print summary',
  ].join('\n');
}

if (require.main === module) main();

module.exports = {
  main,
  parseArgs,
  parseNumberList,
  normalizeFormat,
  inferFormatFromOutput,
  renderReport,
  createSelectedReport,
  buildScenarios,
};
