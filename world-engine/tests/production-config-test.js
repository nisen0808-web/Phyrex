'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const {
  resolveProductionConfig,
  resolveManagedPath,
  isPathInside,
  redactProductionConfig,
  parseOrigins,
  readBoolean,
} = require('../core/production-config-engine');

function main() {
  const cwd = path.join(os.tmpdir(), 'phyrex-production-config');
  assert.throws(() => resolveProductionConfig({
    cwd,
    args: { production: true, corsOrigins: 'https://mud.example' },
    env: {},
  }), /operator_token/, 'production should require a long operator token');

  assert.throws(() => resolveProductionConfig({
    cwd,
    args: {
      production: true,
      operatorToken: 'a'.repeat(48),
      corsOrigins: '*',
    },
    env: {},
  }), /wildcard_forbidden/, 'production should reject wildcard CORS');

  const config = resolveProductionConfig({
    cwd,
    args: {
      production: true,
      operatorToken: 'b'.repeat(48),
      operatorAccountId: 'release_operator',
      dataDir: 'data',
      savePath: 'world.json',
      loadOnStart: 'world.json',
      shutdownSave: 'shutdown.json',
      corsOrigins: 'https://mud.example,https://admin.example',
      rateLimitMax: '42',
      authRateLimitMax: '7',
      metricsPublic: true,
      releaseVersion: '0.1.0',
      releaseSha: 'abc123',
    },
    env: {},
  });

  assert.strictEqual(config.enabled, true);
  assert.strictEqual(config.host, '0.0.0.0');
  assert.strictEqual(config.requireAuth, true);
  assert.strictEqual(config.operatorAccountId, 'release_operator');
  assert.deepStrictEqual(config.corsOrigins, ['https://mud.example', 'https://admin.example']);
  assert.strictEqual(config.rateLimitMax, 42);
  assert.strictEqual(config.authRateLimitMax, 7);
  assert.strictEqual(config.metricsPublic, true);
  assert.strictEqual(config.releaseSha, 'abc123');
  assert.ok(path.isAbsolute(config.dataDir));
  assert.ok(isPathInside(config.dataDir, config.defaultSavePath));
  assert.ok(isPathInside(config.dataDir, config.startupSavePath));
  assert.ok(isPathInside(config.dataDir, config.shutdownSavePath));

  const nested = resolveManagedPath(config.dataDir, 'nested/checkpoint.json', { extension: '.json' });
  assert.ok(isPathInside(config.dataDir, nested));
  assert.throws(
    () => resolveManagedPath(config.dataDir, '../outside.json', { extension: '.json' }),
    /outside_data_dir/,
  );
  assert.throws(
    () => resolveManagedPath(config.dataDir, 'notes.txt', { extension: '.json' }),
    /requires_json/,
  );

  const redacted = redactProductionConfig(config);
  assert.strictEqual(redacted.operatorToken, '[redacted]');
  assert.strictEqual(config.operatorToken, 'b'.repeat(48));

  const local = resolveProductionConfig({ cwd, args: {}, env: {} });
  assert.strictEqual(local.enabled, false);
  assert.deepStrictEqual(local.corsOrigins, ['*']);
  assert.deepStrictEqual(parseOrigins('https://a.example, https://b.example'), [
    'https://a.example',
    'https://b.example',
  ]);
  assert.strictEqual(readBoolean('yes'), true);
  assert.strictEqual(readBoolean('off', true), false);

  console.log('production config test passed');
}

main();
