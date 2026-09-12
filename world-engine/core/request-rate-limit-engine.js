'use strict';

const { wallClockNow } = require('../platform/runtime-clock');

const DEFAULT_REQUEST_RATE_LIMIT_OPTIONS = Object.freeze({
  limit: 60,
  windowMs: 60 * 1000,
  maxKeys: 5000,
});

function createFixedWindowRateLimiter(options = {}) {
  const limit = boundedInteger(options.limit ?? DEFAULT_REQUEST_RATE_LIMIT_OPTIONS.limit, 1, 1000000, 'limit');
  const windowMs = boundedInteger(options.windowMs ?? DEFAULT_REQUEST_RATE_LIMIT_OPTIONS.windowMs, 10, 24 * 60 * 60 * 1000, 'windowMs');
  const maxKeys = boundedInteger(options.maxKeys ?? DEFAULT_REQUEST_RATE_LIMIT_OPTIONS.maxKeys, 10, 1000000, 'maxKeys');
  if (options.now !== undefined && typeof options.now !== 'function') throw new Error('Rate limiter now must be a function');
  const now = options.now || wallClockNow;
  const entries = new Map();

  function consume(key) {
    const normalized = normalizeKey(key);
    const current = Number(now());
    if (!Number.isFinite(current) || current < 0) throw new Error('Rate limiter clock returned an invalid time');
    purgeExpired(current);
    let entry = entries.get(normalized);
    if (!entry || current - entry.windowStartedAt >= windowMs) {
      entry = { count: 0, windowStartedAt: current, lastSeenAt: current };
    }
    if (entry.count >= limit) {
      entry.lastSeenAt = current;
      touch(normalized, entry);
      return Object.freeze({
        allowed: false,
        count: entry.count,
        remaining: 0,
        retryAfterMs: Math.max(1, windowMs - (current - entry.windowStartedAt)),
      });
    }
    entry.count += 1;
    entry.lastSeenAt = current;
    touch(normalized, entry);
    trim();
    return Object.freeze({
      allowed: true,
      count: entry.count,
      remaining: Math.max(0, limit - entry.count),
      retryAfterMs: 0,
    });
  }

  function touch(key, entry) {
    entries.delete(key);
    entries.set(key, entry);
  }

  function purgeExpired(current) {
    for (const [key, entry] of entries) {
      if (current - entry.windowStartedAt >= windowMs) entries.delete(key);
    }
  }

  function trim() {
    while (entries.size > maxKeys) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  function clear() { entries.clear(); }
  function size() { return entries.size; }

  return Object.freeze({
    consume,
    clear,
    size,
    options: Object.freeze({ limit, windowMs, maxKeys }),
  });
}

function normalizeKey(key) {
  const value = String(key ?? '').trim();
  if (!value || value.length > 512 || value.includes('\u0000')) throw new Error('Invalid rate limiter key');
  return value;
}

function boundedInteger(value, min, max, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`Invalid rate limiter ${name}`);
  return number;
}

module.exports = {
  DEFAULT_REQUEST_RATE_LIMIT_OPTIONS,
  createFixedWindowRateLimiter,
};
