'use strict';
const assert = require('assert');
async function main() {
  const { ConsoleSession } = await import('../client/durable/session.mjs');
  const map = new Map(), storage = { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
  const ok = data => new Response(JSON.stringify({ ok: true, data }), { status: 200 });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async function () { assert.strictEqual(this, globalThis, 'browser fetch must retain its receiver'); return ok({ tick: 1 }); };
    const browser = new ConsoleSession({ storage }); browser.connect('world', 'one', 'private-token'); assert.strictEqual((await browser.state()).tick, 1);
  } finally { globalThis.fetch = originalFetch; }
  let calls = 0, saved, release;
  const first = new ConsoleSession({ storage, uuid: () => 'first', fetcher: async (_url, options) => { calls++; saved = options.body; throw new Error('response lost after commit'); } });
  first.connect('world', 'one', 'private-token');
  await assert.rejects(first.submit('wait', { ticks: 1 }), { code: 'connection_unknown' });
  assert.strictEqual(first.pending.id, 'web-first');
  await assert.rejects(first.submit('work'), { code: 'pending_confirmation' }); assert.strictEqual(calls, 1);
  assert.ok(!JSON.stringify([...map]).includes('private-token'));
  first.disconnect();
  const restored = new ConsoleSession({ storage, fetcher: async (_url, options) => { assert.strictEqual(options.body, saved); return ok({ id: 'web-first', worldId: 'world', playerId: 'one', status: 'applied', result: { status: 'completed' } }); } });
  restored.connect('world', 'two', 'other-token'); assert.strictEqual(restored.pending, null);
  restored.connect('world', 'one', 'private-token'); assert.strictEqual(restored.pending.id, 'web-first');
  assert.strictEqual((await restored.submit()).result.status, 'completed'); assert.strictEqual(map.size, 0);
  const blocked = new ConsoleSession({ storage: { getItem() {}, setItem() { throw new Error(); } }, fetcher: () => { throw new Error('must not send'); } });
  blocked.connect('world', 'one', 'private-token'); await assert.rejects(blocked.submit('wait'), { code: 'pending_storage_unavailable' });
  const switching = new ConsoleSession({ storage, fetcher: () => new Promise(resolve => { release = resolve; }) });
  switching.connect('world', 'one', 'old-token'); const read = switching.state();
  switching.connect('world', 'two', 'new-token'); release(ok({ private: 'old player' }));
  await assert.rejects(read, { code: 'session_changed' }); assert.strictEqual(switching.scope.playerId, 'two');
  const revoked = new ConsoleSession({ storage, fetcher: async () => new Response('not JSON', { status: 401 }) });
  revoked.connect('world', 'one', 'private-token'); await assert.rejects(revoked.state(), { code: 'auth_required' }); assert.strictEqual(revoked.connected, false);
  const parallel = new ConsoleSession({ storage, uuid: () => 'parallel', fetcher: () => new Promise(resolve => { release = resolve; }) });
  parallel.connect('world', 'one', 'private-token'); const send = parallel.submit('wait');
  await assert.rejects(parallel.submit(), { code: 'submission_busy' });
  release(ok({ id: 'wrong-id', worldId: 'world', playerId: 'one', status: 'pending' }));
  await assert.rejects(send, { code: 'connection_unknown' }); assert.strictEqual(parallel.pending.id, 'web-parallel');
  const throttled = new ConsoleSession({ storage, fetcher: async () => new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), { status: 429, headers: { 'Retry-After': '12' } }) });
  throttled.connect('world', 'one', 'private-token'); await assert.rejects(throttled.submit(), { status: 429, retryAfter: 12 }); assert.strictEqual(throttled.pending.id, 'web-parallel');
  const timed = new ConsoleSession({ storage, timeout: 10, fetcher: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout')))) });
  timed.connect('world', 'one', 'private-token'); await assert.rejects(timed.submit(), { code: 'connection_unknown' }); assert.strictEqual(timed.pending.id, 'web-parallel');
  console.log('durable console session retry, storage, isolation, revocation and timeout checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
