'use strict';

const assert = require('assert');
const path = require('path');
const {
  RELEASE_VERSION,
  loadProductionConfig,
  validateProductionConfig,
  redactProductionConfig,
  booleanValue,
  numberValue,
  parseList,
  isLoopbackHost,
} = require('../core/production-config-engine');
const {
  parseArgs,
  commandLineOverrides,
  publicClientUrl,
} = require('../production/server');

function main() {
  const config = loadProductionConfig({
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: '9123',
    WORLD_DATA_DIR: 'tmp/production-data',
    WORLD_ADMIN_ID: 'ops_admin',
    WORLD_ADMIN_NAME: 'Operations Admin',
    WORLD_ADMIN_PASSWORD: 'OperationsPassword123!',
    WORLD_CORS_ORIGINS: 'https://ops.example, https://play.example',
    WORLD_ALLOW_REGISTRATION: 'true',
    WORLD_REQUIRE_PASSWORDS: 'true',
    WORLD_RATE_LIMIT_MAX: '321',
    WORLD_AUTH_RATE_LIMIT_MAX: '12',
    WORLD_AUTO_LOOP: 'false',
    WORLD_SHUTDOWN_SAVE: 'true',
  });

  assert.strictEqual(RELEASE_VERSION, '1.0.0');
  assert.strictEqual(config.port, 9123);
  assert.strictEqual(config.requireAuth, true);
  assert.strictEqual(config.allowRegistration, true);
  assert.strictEqual(config.requirePasswords, true);
  assert.strictEqual(config.adminId, 'ops_admin');
  assert.deepStrictEqual(config.corsOrigins, ['https://ops.example', 'https://play.example']);
  assert.strictEqual(config.rateLimitMax, 321);
  assert.strictEqual(config.authRateLimitMax, 12);
  assert.strictEqual(config.autoStartLoop, false);
  assert.strictEqual(path.isAbsolute(config.dataDirectory), true);
  assert.strictEqual(config.savePath, path.join(config.dataDirectory, 'world.json'));
  assert.strictEqual(config.backupDirectory, path.join(config.dataDirectory, 'backups'));

  const redacted = redactProductionConfig(config);
  assert.strictEqual(redacted.adminPasswordConfigured, true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(redacted, 'adminPassword'), false);
  assert.strictEqual(JSON.stringify(redacted).includes('OperationsPassword123!'), false);

  assert.throws(
    () => loadProductionConfig({ NODE_ENV: 'production', HOST: '0.0.0.0' }),
    /admin_password_required/,
  );
  assert.throws(
    () => loadProductionConfig({
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      WORLD_ADMIN_PASSWORD: 'OperationsPassword123!',
      WORLD_CORS_ORIGINS: '*',
    }),
    /wildcard_cors_requires_explicit_override/,
  );
  assert.throws(
    () => loadProductionConfig({
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      WORLD_REQUIRE_AUTH: 'false',
      WORLD_ADMIN_PASSWORD: 'OperationsPassword123!',
    }),
    /public_host_requires_auth/,
  );

  const insecure = loadProductionConfig({
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    WORLD_REQUIRE_AUTH: 'false',
    WORLD_REQUIRE_PASSWORDS: 'false',
    WORLD_ALLOW_INSECURE: 'true',
    WORLD_AUTO_LOOP: 'false',
  });
  assert.strictEqual(insecure.requireAuth, false);
  assert.strictEqual(insecure.allowInsecure, true);

  const validation = validateProductionConfig({
    ...config,
    host: '127.0.0.1',
    corsOrigins: [],
    autoStartLoop: false,
    shutdownSave: false,
    autosaveEveryTicks: 0,
  });
  assert.strictEqual(validation.ok, true);
  assert.ok(validation.warnings.includes('cors_same_origin_only'));
  assert.ok(validation.warnings.includes('runtime_loop_disabled'));
  assert.ok(validation.warnings.includes('shutdown_save_disabled'));
  assert.ok(validation.warnings.includes('runtime_autosave_disabled'));

  assert.strictEqual(booleanValue('yes', false), true);
  assert.strictEqual(booleanValue('off', true), false);
  assert.strictEqual(numberValue('999', 5, 1, 100), 100);
  assert.deepStrictEqual(parseList('a, b, a'), ['a', 'b', 'a']);
  assert.strictEqual(isLoopbackHost('localhost'), true);
  assert.strictEqual(isLoopbackHost('0.0.0.0'), false);

  const args = parseArgs([
    '--host', '127.0.0.1',
    '--port', '9000',
    '--data-dir', '/data',
    '--save', '/data/world.json',
    '--backup-dir', '/data/backups',
    '--no-loop',
    '--allow-registration',
    '--metrics-public',
    '--pretty',
  ]);
  assert.deepStrictEqual(commandLineOverrides(args), {
    host: '127.0.0.1',
    dataDirectory: '/data',
    savePath: '/data/world.json',
    backupDirectory: '/data/backups',
    autoStartLoop: false,
    allowRegistration: true,
    metricsPublic: true,
    logFormat: 'pretty',
    port: 9000,
  });
  assert.strictEqual(publicClientUrl({ host: '0.0.0.0', port: 8790 }), 'http://127.0.0.1:8790/client');
  assert.throws(() => parseArgs(['--unknown']), /unknown_argument/);

  console.log('production configuration validation test passed');
}

main();
