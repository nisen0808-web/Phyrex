'use strict';

const fs = require('fs');
const path = require('path');
const {
  buildDatabaseCheckReport,
  summarizeDatabaseCheckReport,
} = require('../core/database-check-report-engine');

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const output = args.output || path.join('world-engine', 'output', 'database-check.json');
  const report = buildDatabaseCheckReport({ database: buildDatabaseOptions(args) });
  writeJson(output, report);
  if (!args.quiet) {
    console.log(JSON.stringify({ ok: true, output, ...summarizeDatabaseCheckReport(report) }, null, 2));
  }
  return report;
}

function buildDatabaseOptions(args = {}) {
  return {
    provider: args.dbProvider || 'jsonl',
    directory: args.dbDir || path.join('world-engine', 'data', 'db'),
    name: args.dbName || 'world-engine',
    autoCreate: args.dbAutoCreate,
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseArgs(argv = []) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db-provider') out.dbProvider = argv[++i];
    else if (arg === '--db-dir') out.dbDir = argv[++i];
    else if (arg === '--db-name') out.dbName = argv[++i];
    else if (arg === '--db-auto-create') out.dbAutoCreate = argv[++i];
    else if (arg === '--output') out.output = argv[++i];
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '--help') {
      console.log([
        'Usage: node world-engine/demo/database-check-cli.js [options]',
        '',
        'Options:',
        '  --db-provider <provider>   Database provider, default jsonl',
        '  --db-dir <dir>             Database directory',
        '  --db-name <name>           Database name',
        '  --output <file>            Output JSON file',
        '  --quiet                    Do not print summary to stdout',
      ].join('\n'));
      process.exit(0);
    }
  }
  return out;
}

if (require.main === module) main();

module.exports = {
  main,
  parseArgs,
  buildDatabaseOptions,
  writeJson,
};
