'use strict';

const assert = require('assert');
const packageJson = require('../package.json');
const { parseArgs, copyNumericEnv, boundedPort, safeErrorCode } = require('../demo/durable-command-api-server');

function main() {
  const args = parseArgs(['--host', '127.0.0.1', '--port', '8791', '--max-body-bytes', '65536']);
  assert.deepStrictEqual(args, { host: '127.0.0.1', port: '8791', maxBodyBytes: '65536' });
  assert.strictEqual(boundedPort('8791'), 8791);
  assert.throws(() => boundedPort('0'), /Invalid port/);
  assert.throws(() => parseArgs(['--database-url', 'secret']), /Unknown argument/);
  assert.strictEqual(safeErrorCode({ code: 'WORLD_DB_UNAVAILABLE' }), 'WORLD_DB_UNAVAILABLE');
  assert.strictEqual(safeErrorCode(new Error('postgresql://user:secret@example/db')), 'COMMAND_API_FAILED');

  const options = {};
  copyNumericEnv(options, {
    WORLD_ENGINE_COMMAND_API_SOURCE_RATE_LIMIT: '250',
    EMPTY: '',
  }, 'sourceRateLimit', 'WORLD_ENGINE_COMMAND_API_SOURCE_RATE_LIMIT');
  assert.strictEqual(options.sourceRateLimit, 250);
  copyNumericEnv(options, { EMPTY: '' }, 'unused', 'EMPTY');
  assert.strictEqual(options.unused, undefined);
  assert.throws(() => copyNumericEnv({}, { BAD: 'secret-not-a-number' }, 'bad', 'BAD'), /Invalid BAD/);

  assert.ok(packageJson.scripts['api:postgres:commands'].includes('durable-command-api-server.js'));
  assert.ok(packageJson.scripts['test:postgres:command-api'].includes('postgres-command-api.js'));
  console.log('durable command api cli test passed');
}

main();
