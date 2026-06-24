'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildDemoWorld } = require('../demo/run-demo');
const {
  createAccount,
  createSession,
} = require('../core/account-session-engine');
const {
  validatePassword,
  setAccountPassword,
  verifyAccountPassword,
  accountHasPassword,
  clearAccountPassword,
  sanitizeCredentialRecord,
} = require('../core/password-auth-engine');
const {
  saveWorld,
  loadWorld,
  listSaves,
  prepareWorldForPersistence,
} = require('../core/persistence-engine');

function main() {
  const world = buildDemoWorld();
  createAccount(world, { id: 'secure_account', name: 'Secure Account' });

  assert.strictEqual(validatePassword('short').ok, false, 'short password should fail');
  assert.ok(validatePassword('onlyletterslong').errors.includes('password_requires_number'));
  assert.ok(validatePassword('123456789012').errors.includes('password_requires_letter'));
  assert.strictEqual(validatePassword('StrongPassword123!').ok, true);

  const publicRecord = setAccountPassword(world, 'secure_account', 'StrongPassword123!');
  assert.deepStrictEqual(Object.keys(publicRecord).sort(), [
    'configured',
    'createdAt',
    'scheme',
    'updatedAt',
    'updatedAtTick',
  ]);
  assert.strictEqual(publicRecord.configured, true);
  assert.strictEqual(accountHasPassword(world, 'secure_account'), true);
  assert.strictEqual(verifyAccountPassword(world, 'secure_account', 'StrongPassword123!'), true);
  assert.strictEqual(verifyAccountPassword(world, 'secure_account', 'WrongPassword123!'), false);
  assert.strictEqual(verifyAccountPassword(world, 'missing', 'StrongPassword123!'), false);
  assert.strictEqual(sanitizeCredentialRecord(world.accounts.byId.secure_account.credentials).configured, true);

  const session = createSession(world, 'secure_account');
  assert.ok(session.token);
  assert.strictEqual(Object.keys(world.accounts.sessions).length, 1);

  const prepared = prepareWorldForPersistence(world, { excludeSessions: true });
  assert.notStrictEqual(prepared, world, 'session-free persistence should clone the world');
  assert.strictEqual(Object.keys(prepared.accounts.sessions).length, 0);
  assert.strictEqual(Object.keys(prepared.accounts.byToken).length, 0);
  assert.ok(prepared.accounts.byId.secure_account.credentials.hash, 'password hash must remain persisted');
  assert.strictEqual(Object.keys(world.accounts.sessions).length, 1, 'live world sessions must remain untouched');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-password-save-'));
  const filePath = path.join(directory, 'world.json');
  try {
    const saved = saveWorld(world, filePath, {
      createBackup: false,
      excludeSessions: true,
      reason: 'password_auth_test',
    });
    assert.strictEqual(saved.sessionsExcluded, true);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.strictEqual(raw.metadata.sessionsExcluded, true);
    assert.strictEqual(Object.keys(raw.world.accounts.sessions).length, 0);
    assert.strictEqual(Object.keys(raw.world.accounts.byToken).length, 0);
    assert.ok(raw.world.accounts.byId.secure_account.credentials.hash);

    const listed = listSaves(directory);
    assert.strictEqual(listed[0].sessionsExcluded, true);

    const loaded = loadWorld(filePath);
    assert.strictEqual(Object.keys(loaded.world.accounts.sessions).length, 0);
    assert.strictEqual(verifyAccountPassword(loaded.world, 'secure_account', 'StrongPassword123!'), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  assert.strictEqual(clearAccountPassword(world, 'secure_account'), true);
  assert.strictEqual(accountHasPassword(world, 'secure_account'), false);
  assert.strictEqual(clearAccountPassword(world, 'missing'), false);

  console.log('password credential and session-free persistence test passed');
}

main();
