'use strict';

const assert = require('assert');
const {
  createAuthSecurityState,
  inspectLoginAttempt,
  recordLoginFailure,
  recordLoginSuccess,
  consumeRegistrationAttempt,
  getAuthSecurityStats,
} = require('../core/auth-security-engine');

function main() {
  const state = createAuthSecurityState({
    maxLoginAttempts: 3,
    loginWindowMs: 1000,
    lockoutMs: 5000,
    registrationLimit: 2,
    registrationWindowMs: 1000,
  });

  assert.strictEqual(inspectLoginAttempt(state, 'key', 0).allowed, true);
  assert.strictEqual(recordLoginFailure(state, 'key', 10).allowed, true);
  assert.strictEqual(recordLoginFailure(state, 'key', 20).allowed, true);
  const locked = recordLoginFailure(state, 'key', 30);
  assert.strictEqual(locked.allowed, false);
  assert.ok(locked.retryAfterMs > 0);
  recordLoginSuccess(state, 'key');
  assert.strictEqual(inspectLoginAttempt(state, 'key', 40).allowed, true);

  assert.strictEqual(consumeRegistrationAttempt(state, 'source', 0).allowed, true);
  assert.strictEqual(consumeRegistrationAttempt(state, 'source', 10).allowed, true);
  assert.strictEqual(consumeRegistrationAttempt(state, 'source', 20).allowed, false);
  assert.strictEqual(consumeRegistrationAttempt(state, 'source', 2000).allowed, true);

  const stats = getAuthSecurityStats(state);
  assert.strictEqual(stats.stats.loginFailures, 3);
  assert.strictEqual(stats.stats.lockouts, 1);
  assert.strictEqual(stats.stats.registrationsLimited, 1);

  console.log('request throttle test passed');
}

main();
