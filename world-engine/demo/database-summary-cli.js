'use strict';

const fs = require('fs');
const path = require('path');
const { buildDatabaseViewerSummary } = require('../core/database-viewer-summary-engine');

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const output = args.output || path.join('world-engine', 'output', 'database-summary.json');
  const summary = buildDatabaseViewerSummary({
    database: buildDatabaseOptions(args),
    worldLimit: Number(args.worldLimit || 20),
    eventLimit: Number(args.eventLimit || args.limit || 20),
    eventOrder: args.order || 'desc',
    worldId: args.worldId,
    type: args.type,
  });
  writeJson(output, summary);
  if (!args.quiet) {
    console.log(JSON.stringify({
      ok: true,
      output,
      provider: summary.status.provider,
      records: summary.totals.records,
      events: summary.totals.events,
      latestWorldId: summary.health.latestWorldId,
      latestTick: summary.health.latestTick,
    }, null, 2));
  }
  return summary;
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
    else if (arg === '--world-limit') out.worldLimit = argv[++i];
    else if (arg === '--event-limit') out.eventLimit = argv[++i];
    else if (arg === '--limit') out.limit = argv[++i];
    else if (arg === '--order') out.order = argv[++i];
    else if (arg === '--world-id') out.worldId = argv[++i];
    else if (arg === '--type') out.type = argv[++i];
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '--help') {
      console.log([
        'Usage: node world-engine/demo/database-summary-cli.js [options]',
        '',
        'Options:',
        '  --db-provider <provider>   Database provider, default jsonl',
        '  --db-dir <dir>             Database directory',
        '  --db-name <name>           Database name',
        '  --output <file>            Output JSON file',
        '  --world-limit <n>          Max world rows',
        '  --event-limit <n>          Max event rows',
        '  --world-id <id>            Filter events by world id',
        '  --type <event type>        Filter events by type',
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
