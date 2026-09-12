'use strict';

const assert = require('assert');
const { captureCommandApiAudit } = require('../storage/postgres/codec');
const { MIGRATIONS, checkMigrationHistory } = require('../storage/postgres/migrations');

function main() {
  const captured = captureCommandApiAudit({
    worldId: 'world', accountId: 'account', playerId: 'player', commandId: 'command', commandSequence: 9,
    method: 'GET', route: 'command.status', statusCode: 200, outcome: 'read_pending',
    token: 'must-not-survive', input: { secret: true }, inputDigest: 'f'.repeat(64), sourceIp: '127.0.0.1',
  });
  assert.deepStrictEqual(captured, {
    worldId: 'world', accountId: 'account', playerId: 'player', commandId: 'command', commandSequence: 9,
    method: 'GET', route: 'command.status', statusCode: 200, outcome: 'read_pending',
  });
  const serialized = JSON.stringify(captured);
  for (const secret of ['must-not-survive', 'secret', 'inputDigest', 'sourceIp', '127.0.0.1']) assert.ok(!serialized.includes(secret));

  assert.deepStrictEqual(captureCommandApiAudit({
    worldId: 'world', accountId: 'account', method: 'POST', route: 'command.submit', statusCode: 403,
    outcome: 'player_forbidden',
  }), {
    worldId: 'world', accountId: 'account', playerId: null, commandId: null, commandSequence: null,
    method: 'POST', route: 'command.submit', statusCode: 403, outcome: 'player_forbidden',
  });

  for (const input of [
    { worldId: 'world', accountId: 'account', method: 'DELETE', route: 'command.status', statusCode: 200, outcome: 'x' },
    { worldId: 'world', accountId: 'account', method: 'GET', route: 'other', statusCode: 200, outcome: 'x' },
    { worldId: 'world', accountId: 'account', method: 'GET', route: 'command.status', statusCode: 99, outcome: 'x' },
    { worldId: 'world', accountId: 'account', method: 'GET', route: 'command.status', statusCode: 600, outcome: 'x' },
    { worldId: 'world', accountId: 'account', method: 'GET', route: 'command.status', statusCode: 200, outcome: '' },
  ]) assert.throws(() => captureCommandApiAudit(input));

  assert.strictEqual(MIGRATIONS.at(-1).version, 3);
  assert.strictEqual(MIGRATIONS.at(-1).name, 'durable_command_api_audit');
  assert.strictEqual(checkMigrationHistory(MIGRATIONS.map(({ version, name, checksum }) => ({ version, name, checksum }))), 3);
  assert.ok(MIGRATIONS[0].sql.includes('transactional_world_checkpoints') === false, 'published migration SQL remains raw SQL, not metadata text');

  console.log('postgres command api audit contract test passed');
}

main();
