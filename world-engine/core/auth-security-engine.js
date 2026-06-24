'use strict';

const DEFAULT_AUTH_SECURITY_OPTIONS = {
  maxLoginAttempts: 5,
  loginWindowMs: 15 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000,
  registrationLimit: 10,
  registrationWindowMs: 60 * 60 * 1000,
  maxTrackedKeys: 5000,
};

function createAuthSecurityState(options = {}) {
  return {
    options: { ...DEFAULT_AUTH_SECURITY_OPTIONS, ...(options || {}) },
    loginAttempts: new Map(),
    registrationWindows: new Map(),
    stats: {
      loginFailures: 0,
      lockouts: 0,
      registrationsLimited: 0,
    },
  };
}

function inspectLoginAttempt(state, key, now = Date.now()) {
  const entry = state.loginAttempts.get(String(key || 'unknown'));
  if (!entry) return { allowed: true, attempts: 0, retryAfterMs: 0 };
  if (entry.lockedUntil && entry.lockedUntil > now) {
    return {
      allowed: false,
      attempts: entry.attempts,
      retryAfterMs: entry.lockedUntil - now,
      lockedUntil: entry.lockedUntil,
    };
  }
  if (now - entry.windowStartedAt >= state.options.loginWindowMs) {
    state.loginAttempts.delete(String(key || 'unknown'));
    return { allowed: true, attempts: 0, retryAfterMs: 0 };
  }
  return { allowed: true, attempts: entry.attempts, retryAfterMs: 0 };
}

function recordLoginFailure(state, key, now = Date.now()) {
  const normalizedKey = String(key || 'unknown');
  let entry = state.loginAttempts.get(normalizedKey);
  if (!entry || now - entry.windowStartedAt >= state.options.loginWindowMs) {
    entry = { attempts: 0, windowStartedAt: now, lockedUntil: null };
  }
  entry.attempts += 1;
  state.stats.loginFailures += 1;
  if (entry.attempts >= state.options.maxLoginAttempts) {
    entry.lockedUntil = now + state.options.lockoutMs;
    state.stats.lockouts += 1;
  }
  state.loginAttempts.set(normalizedKey, entry);
  trimTrackedEntries(state.loginAttempts, state.options.maxTrackedKeys);
  return inspectLoginAttempt(state, normalizedKey, now);
}

function recordLoginSuccess(state, key) {
  state.loginAttempts.delete(String(key || 'unknown'));
}

function consumeRegistrationAttempt(state, key, now = Date.now()) {
  const normalizedKey = String(key || 'unknown');
  let entry = state.registrationWindows.get(normalizedKey);
  if (!entry || now - entry.windowStartedAt >= state.options.registrationWindowMs) {
    entry = { count: 0, windowStartedAt: now };
  }
  if (entry.count >= state.options.registrationLimit) {
    state.stats.registrationsLimited += 1;
    const retryAfterMs = Math.max(1, state.options.registrationWindowMs - (now - entry.windowStartedAt));
    state.registrationWindows.set(normalizedKey, entry);
    return { allowed: false, count: entry.count, retryAfterMs };
  }
  entry.count += 1;
  state.registrationWindows.set(normalizedKey, entry);
  trimTrackedEntries(state.registrationWindows, state.options.maxTrackedKeys);
  return {
    allowed: true,
    count: entry.count,
    remaining: Math.max(0, state.options.registrationLimit - entry.count),
    retryAfterMs: 0,
  };
}

function getAuthSecurityStats(state) {
  return {
    trackedLoginKeys: state.loginAttempts.size,
    trackedRegistrationKeys: state.registrationWindows.size,
    stats: { ...(state.stats || {}) },
  };
}

function trimTrackedEntries(map, limit) {
  const max = Math.max(100, Number(limit || DEFAULT_AUTH_SECURITY_OPTIONS.maxTrackedKeys));
  while (map.size > max) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

module.exports = {
  DEFAULT_AUTH_SECURITY_OPTIONS,
  createAuthSecurityState,
  inspectLoginAttempt,
  recordLoginFailure,
  recordLoginSuccess,
  consumeRegistrationAttempt,
  getAuthSecurityStats,
};
