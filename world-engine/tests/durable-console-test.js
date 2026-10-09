'use strict';
const assert = require('assert');
const { consoleFixture } = require('./helpers/console-fixture');
const { fixture } = require('./helpers/service-fixture');
const { createDurableCommandApiServer } = require('../core/durable-command-api-engine');
const { listenForFetch } = require('./helpers/listen-for-fetch');
const { EventEmitter } = require('node:events');
async function main() {
  const probe = new EventEmitter(); let attempts = 0, releases = 0, selected;
  probe.listen = port => {
    attempts++;
    if (attempts > 1) assert(port >= 20000 && port < 60000);
    if (attempts === 2) { probe.emit('error', Object.assign(new Error('busy'), { code: 'EADDRINUSE' })); return; }
    selected = attempts === 1 ? 6000 : port; probe.emit('listening');
  };
  probe.address = () => ({ port: selected }); probe.close = done => { releases++; done(); };
  assert((await listenForFetch(probe)) > 10080); assert.equal(attempts, 3); assert.equal(releases, 1);
  assert.equal(probe.listenerCount('error') + probe.listenerCount('listening'), 0);
  const f = await consoleFixture(), base = `http://127.0.0.1:${f.port}`;
  const { ConsoleSession } = await import('../client/durable/session.mjs');
  const data = new Map(), storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const client = new ConsoleSession({ storage, fetcher: (url, options) => fetch(base + url, options) });
  try {
    for (const route of ['/', '/console/style.css', '/console/app.mjs', '/console/session.mjs', '/console/guide.mjs']) {
      const response = await fetch(base + route); assert.strictEqual(response.status, 200);
      assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
      assert.match(response.headers.get('Content-Security-Policy'), /form-action 'none'/, 'failed JavaScript must not fall back to native credential submission');
      assert.ok(!response.headers.get('Content-Security-Policy').includes('unsafe-inline'));
      assert.strictEqual(response.headers.get('Cache-Control'), 'no-store');
      const source = await response.text(); assert.ok(source.length > 100);
      if (route === '/') {
        const form = source.match(/<form id="login-form"[^>]*>/)[0], credential = source.match(/<input id="token"[^>]*>/)[0];
        assert.match(form, /method="post"/); assert.ok(!/\bname\s*=/.test(credential), 'credential is never a successful native form field');
        assert.match(source, /type="submit" disabled>连接世界/, 'enable submission only after event handlers are installed');
      }
      assert.ok(!source.includes('console-player-fixture')); assert.ok(!source.includes('console-admin-fixture'));
      assert.strictEqual((await fetch(base + route, { method: 'HEAD' })).status, 200);
    }
    assert.strictEqual(f.audits.length, 0, 'static requests must not grow SQL audit');
    assert.strictEqual((await fetch(base + '/', { method: 'POST' })).status, 405);
    assert.strictEqual((await fetch(base + '/?token=secret')).status, 400, 'tokens in query URLs are not supported');
    for (const route of ['/client/index.html', '/console/../package.json', '/console/%2e%2e%2fpackage.json', '/admin/status', '/accounts', '/save']) assert.strictEqual((await fetch(base + route)).status, 404);
    assert.strictEqual((await fetch(base + '/durable/worlds/console-test/players/one/state')).status, 401, 'public shell cannot authorize world reads');
    client.connect('console-test', 'one', 'console-player-fixture');
    f.world.items.definitions.wooden_sword.operatorSecret = 'do-not-expose-definition-metadata';
    const before = await client.state();
    assert.strictEqual(before.character.name, '岚');
    const stock = before.inventory.shops.find(shop => shop.id === 'market').stock.find(item => item.definitionId === 'wooden_sword');
    assert.strictEqual(stock.name, 'Wooden Sword'); assert.strictEqual(stock.type, 'equipment');
    assert.deepStrictEqual(stock.stats, { power: 2 });
    assert.ok(!JSON.stringify(before).includes('do-not-expose-definition-metadata'), 'shop definitions use a public field allowlist');
    await assert.rejects(client.request('/admin/audit'), { status: 403 });
    await assert.rejects(client.request('/players/two/state'), { status: 403 });
    const purchase = await client.submit('buy_item', { shopId: 'market', definitionId: 'wooden_sword', quantity: 1 });
    assert.strictEqual(purchase.status, 'pending'); f.step();
    const receipt = await client.receipt(purchase.id); assert.strictEqual(receipt.result.status, 'completed');
    const after = await client.state(); assert.strictEqual(after.character.resources.currency, before.character.resources.currency - 25);
    assert.strictEqual(after.inventory.items.length, before.inventory.items.length + 1);
    assert.strictEqual((await client.history()).records.length, 1);
    const replay = await client.request('/players/one/commands', { method: 'POST', body: JSON.stringify(f.rows[0].input) });
    assert.strictEqual(replay.idempotent, true); assert.strictEqual(f.rows.length, 1);
    assert.strictEqual((await client.state()).character.resources.currency, after.character.resources.currency);
    client.connect('console-test', 'one', 'console-admin-fixture');
    const audit = await client.request('/admin/audit?limit=2'); assert.strictEqual(audit.records.length, 2);
    assert.ok(audit.nextBeforeSequence); assert.ok(!JSON.stringify(audit).includes('console-admin-fixture'));
    assert.strictEqual((await client.request(`/admin/audit?limit=2&beforeSequence=${audit.nextBeforeSequence}`)).records.length, 2);
  } finally { client.disconnect(); await f.api.close(); }
  const disabled = await createDurableCommandApiServer({ ...fixture(), rateLimitNow: () => 0 });
  try { await listenForFetch(disabled.server); assert.strictEqual((await fetch(`http://127.0.0.1:${disabled.server.address().port}/`)).status, 404); }
  finally { await disabled.close(); }
  const limited = await createDurableCommandApiServer({ ...fixture(), rateLimitNow: () => 0, webConsole: true, sourceRateLimit: 1 });
  try {
    await listenForFetch(limited.server); const url = `http://127.0.0.1:${limited.server.address().port}/`;
    assert.strictEqual((await fetch(url)).status, 200); assert.strictEqual((await fetch(url)).status, 429);
  } finally { await limited.close(); }
  console.log('durable console HTTP, authorization, commerce and replay checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
