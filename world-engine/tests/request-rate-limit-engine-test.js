'use strict';

const assert = require('assert');
const { createFixedWindowRateLimiter } = require('../core/request-rate-limit-engine');
const { requestSourceKey, enforceRateLimit, mapError } = require('../core/durable-command-api-engine');

function main() {
  let now = 1000;
  const limiter = createFixedWindowRateLimiter({ limit: 2, windowMs: 100, maxKeys: 10, now: () => now });
  assert.deepStrictEqual(limiter.consume('a'), { allowed: true, count: 1, remaining: 1, retryAfterMs: 0 });
  assert.deepStrictEqual(limiter.consume('a'), { allowed: true, count: 2, remaining: 0, retryAfterMs: 0 });
  const denied = limiter.consume('a');
  assert.strictEqual(denied.allowed, false); assert.strictEqual(denied.retryAfterMs, 100);
  assert.throws(() => enforceRateLimit(denied), error => error.statusCode === 429 && error.apiCode === 'rate_limited');
  const mapped = mapError(Object.assign(new Error('rate_limited'), { statusCode: 429, apiCode: 'rate_limited', retryAfterMs: 100 }));
  assert.deepStrictEqual(mapped, { status: 429, code: 'rate_limited', retryAfterMs: 100 });
  now += 100;
  assert.strictEqual(limiter.consume('a').allowed, true);

  for (let index = 0; index < 30; index += 1) limiter.consume(`key-${index}`);
  assert.ok(limiter.size() <= 10);
  limiter.clear(); assert.strictEqual(limiter.size(), 0);

  assert.strictEqual(requestSourceKey({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.9' } }), 'socket:127.0.0.1');
  assert.strictEqual(requestSourceKey({ socket: { remoteAddress: '2001:db8::1' }, headers: { 'x-forwarded-for': '198.51.100.7' } }), 'socket:2001:db8::1');
  assert.throws(() => createFixedWindowRateLimiter({ limit: 0 }));
  assert.throws(() => createFixedWindowRateLimiter({ now: 1 }));

  console.log('request rate limiter contracts passed');
}

main();
