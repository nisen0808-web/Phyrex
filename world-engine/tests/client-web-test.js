'use strict';

const assert = require('assert');
const http = require('http');
const { createWorldApiServer } = require('../core/api-server-engine');

async function main() {
  const { server } = createWorldApiServer(null, { seedTicks: 5 });
  const base = await listen(server);
  try {
    const root = await request(base, '/');
    assert.strictEqual(root.statusCode, 200, 'root should serve client index');
    assert.ok(root.text.includes('MUD 世界模拟器'), 'index should include title');

    const index = await request(base, '/client');
    assert.strictEqual(index.statusCode, 200, '/client should serve index');
    assert.ok(index.text.includes('/client/app.js'), 'index should reference app.js');
    assert.ok(index.text.includes('/client/style.css'), 'index should reference style.css');

    const app = await request(base, '/client/app.js');
    assert.strictEqual(app.statusCode, 200, 'app.js should be served');
    assert.ok(app.headers['content-type'].includes('application/javascript'), 'app.js content type should be js');
    assert.ok(app.text.includes('createAccount'), 'app.js should include createAccount');
    assert.ok(app.text.includes('connectWs'), 'app.js should include websocket client');

    const css = await request(base, '/client/style.css');
    assert.strictEqual(css.statusCode, 200, 'style.css should be served');
    assert.ok(css.headers['content-type'].includes('text/css'), 'style.css content type should be css');
    assert.ok(css.text.includes('.panel'), 'css should include panel style');

    const missing = await request(base, '/client/not-found.js');
    assert.strictEqual(missing.statusCode, 404, 'missing client asset should be 404');

    const traversal = await request(base, '/client/../package.json');
    assert.ok([403, 404].includes(traversal.statusCode), 'path traversal should not expose package.json');

    const health = await requestJson(base, '/health');
    assert.strictEqual(health.ok, true, 'health should still work');
    const world = await requestJson(base, '/world');
    assert.strictEqual(world.ok, true, 'world endpoint should still work');

    console.log('local browser client test passed');
  } finally {
    await close(server);
  }
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function request(base, path) {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

async function requestJson(base, path) {
  const result = await request(base, path);
  if (result.statusCode >= 400) throw new Error(`HTTP ${result.statusCode}: ${result.text}`);
  return JSON.parse(result.text || '{}');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
