'use strict';

const assert = require('assert');
const packageJson = require('../package.json');

function main() {
  const script = packageJson.scripts['api:live:db'];
  assert.ok(script, 'api:live:db script should exist');
  assert.ok(script.includes('--auto-loop'));
  assert.ok(script.includes('--autosave-mode database'));
  assert.ok(script.includes('--db-provider jsonl'));
  assert.ok(script.includes('--db-dir world-engine/data/db'));
  assert.ok(script.includes('--db-name world-engine'));
  assert.ok(script.includes('--autosave-every 25'));
  console.log('database live script test passed');
}

main();
