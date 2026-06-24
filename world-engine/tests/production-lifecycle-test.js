'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProductionWorldApiServer } = require('../core/production-api-engine');
const { resolveProductionConfig } = require('../core/production-config-engine');
const {
  loadStartupWorld,
  createProductionLifecycle,
  closeStreams,
  closeSockets,
} = require('../core/production-lifecycle-engine');

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-lifecycle-'));
  const config = resolveProductionConfig({
    cwd: process.cwd(),
    args: {
      production: true,
      operatorToken: 'lifecycle-token-' + 'z'.repeat(40),
      dataDir,
      savePath: 'world.json',
      shutdownSave: 'shutdown.json',
      shutdownTimeoutMs: 5000,
      corsOrigins: 'https://mud.example',
    },
    env: {},
  });
  const { server, api } = createProductionWorldApiServer(null, {
    seedTicks: 4,
    productionConfig: config,
  });
  await listen(server);
  const logs = [];
  const lifecycle = createProductionLifecycle({
    server,
    api,
    config,
    signals: false,
    logger: {
      log: value => logs.push(value),
      error: value => logs.push(value),
    },
  });

  try {
    const worldBefore = api.getWorld();
    const tickBefore = worldBefore.tick;
    const summary = await lifecycle.shutdown('integration_test');
    assert.strictEqual(summary.ok, true);
    assert.strictEqual(summary.reason, 'integration_test');
    assert.strictEqual(summary.worldId, worldBefore.id);
    assert.strictEqual(summary.tick, tickBefore);
    assert.strictEqual(summary.close.closed, true);
    assert.strictEqual(summary.close.timedOut, false);
    assert.ok(summary.save);
    assert.ok(fs.existsSync(config.shutdownSavePath));
    assert.strictEqual(server.listening, false);
    assert.strictEqual(lifecycle.shuttingDown, true);
    assert.ok(logs.some(value => String(value).includes('shutdown.complete')));

    const repeated = await lifecycle.shutdown('ignored_second_reason');
    assert.deepStrictEqual(repeated, summary, 'shutdown should be idempotent');

    const restored = loadStartupWorld({
      ...config,
      startupSavePath: config.shutdownSavePath,
    });
    assert.strictEqual(restored.id, worldBefore.id);
    assert.strictEqual(restored.tick, tickBefore);

    assert.throws(
      () => loadStartupWorld({ startupSavePath: path.join(dataDir, 'missing.json') }),
      /startup_save_missing/,
    );

    const fakeStream = { ended: false, end() { this.ended = true; } };
    const fakeSocket = { destroyed: false, end() {}, destroy() { this.destroyed = true; } };
    closeStreams(new Set([fakeStream]));
    closeSockets(new Set([fakeSocket]));
    assert.strictEqual(fakeStream.ended, true);
    assert.strictEqual(fakeSocket.destroyed, true);

    console.log('production lifecycle test passed');
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
