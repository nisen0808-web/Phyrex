'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorld } = require('../core/world-engine');
const {
  createAccount,
  createSession,
  validateSession,
  revokeSession,
  ensureAccountState,
  hashSessionToken,
} = require('../core/account-session-engine');
const { saveWorld, loadWorld } = require('../core/persistence-engine');

function main() {
  const world = createWorld({ id: 'session-hash-test', seed: 17 });
  createAccount(world, { id: 'secure_player', roles: ['player'] });

  const issued = createSession(world, 'secure_player', { sessionTtlTicks: 1000 });
  const stored = ensureAccountState(world).sessions[issued.id];
  assert.ok(issued.token, 'session creation should return its one-time secret');
  assert.strictEqual(stored.token, undefined, 'stored session should omit the original secret');
  assert.strictEqual(stored.tokenHash, hashSessionToken(issued.token));
  assert.strictEqual(validateSession(world, issued.token).account.id, 'secure_player');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-session-hash-'));
  const filePath = path.join(directory, 'world.json');
  try {
    saveWorld(world, filePath, { createBackup: false });
    const text = fs.readFileSync(filePath, 'utf8');
    assert.strictEqual(text.includes(issued.token), false, 'world save should omit the original session secret');
    const loaded = loadWorld(filePath).world;
    assert.strictEqual(validateSession(loaded, issued.token).account.id, 'secure_player');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  revokeSession(world, issued.token, 'test');
  assert.strictEqual(validateSession(world, issued.token), null);

  console.log('session token hash test passed');
}

main();
