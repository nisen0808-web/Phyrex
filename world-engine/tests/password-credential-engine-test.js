'use strict';

const assert = require('assert');
const { createWorld } = require('../core/world-engine');
const { createAccount } = require('../core/account-session-engine');
const {
  ensureCredentialState,
  normalizeAccountId,
  validateAccountId,
  validatePasswordPolicy,
  setPasswordCredential,
  verifyPasswordCredential,
  hasPasswordCredential,
  getCredentialStats,
} = require('../core/password-credential-engine');

function main() {
  const world = createWorld({ id: 'credential-test', seed: 23 });
  createAccount(world, { id: 'secure_player', roles: ['player'] });

  assert.strictEqual(normalizeAccountId(' Secure_Player '), 'secure_player');
  assert.strictEqual(validateAccountId('secure.player-1'), 'secure.player-1');
  assert.throws(() => validateAccountId('Admin User'), /lowercase letters/);
  assert.throws(() => validatePasswordPolicy('short1'), /at least/);
  assert.throws(() => validatePasswordPolicy('onlyletterslong'), /number/);

  const secret = 'ValidPassword123!';
  const view = setPasswordCredential(world, 'secure_player', secret);
  assert.strictEqual(view.accountId, 'secure_player');
  assert.strictEqual(view.algorithm, 'scrypt');
  assert.strictEqual(hasPasswordCredential(world, 'secure_player'), true);
  assert.strictEqual(verifyPasswordCredential(world, 'secure_player', secret), true);
  assert.strictEqual(verifyPasswordCredential(world, 'secure_player', 'WrongPassword123!'), false);

  const state = ensureCredentialState(world);
  assert.ok(state.byAccountId.secure_player.hash);
  assert.ok(state.byAccountId.secure_player.salt);
  assert.strictEqual(JSON.stringify(state).includes(secret), false, 'credential state should omit the original password');
  assert.strictEqual(getCredentialStats(world).credentials, 1);

  console.log('password credential engine test passed');
}

main();
