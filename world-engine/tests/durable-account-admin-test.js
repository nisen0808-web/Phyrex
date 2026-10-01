'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorld } = require('../core/world-engine');
const { createPlayer } = require('../core/player-engine');
const { createAccount, createSession, linkPlayerToAccount, validateSession } = require('../core/account-session-engine');
const { canAccessPlayer } = require('../core/api-permission-engine');
const { administerAccount, captureOperation } = require('../runtime/durable-account-admin');
const { digest, detachedJson, captureCheckpoint } = require('../storage/postgres/codec');
const { main: cli, parseArguments } = require('../demo/account-admin-cli');

async function main() {
  const world = createWorld({ id: 'admin-unit', seed: 41 });
  createPlayer(world, { id: 'p' });
  createAccount(world, { id: 'old', playerIds: ['p'] });
  createAccount(world, { id: 'new', playerIds: ['p'] });
  assert.strictEqual(canAccessPlayer(world.accounts.byId.old, 'p'), false);
  linkPlayerToAccount(world, 'old', 'p');
  assert.strictEqual(canAccessPlayer(world.accounts.byId.new, 'p'), false);
  const a = createSession(world, 'old', { token: 'a'.repeat(48), maxSessionsPerAccount: 1 });
  const b = createSession(world, 'old', { token: 'b'.repeat(48), maxSessionsPerAccount: 1 });
  assert.strictEqual(validateSession(world, a.token), null);
  assert.ok(validateSession(world, b.token), 'newest session survives a same-tick limit');
  for (const operation of [
    { type: 'account.create', accountId: '__proto__' }, { type: 'account.roles', accountId: 'old', roles: ['root'] },
    { type: 'account.status', accountId: 'old', status: 'invalid' }, { type: 'session.issue', accountId: 'old', token: 'short' },
    { type: 'session.issue', accountId: 'old', token: 'x'.repeat(48), ttlTicks: 0 },
    { type: 'account.create', accountId: 'x', unexpected: 'value' },
  ]) assert.throws(() => captureOperation(operation));

  let committed = { world: detachedJson(world), revision: 1, metadata: { durableRuntime: { configHash: 'keep-me' } } };
  const receipts = new Map(), attempts = [];
  let loseAcknowledgement = true;
  const store = {
    getCheckpointRequest: async (_worldId, id) => detachedJson(receipts.get(id) ?? null),
    loadWorld: async () => detachedJson(committed),
    saveWorld: async (candidate, options) => {
      attempts.push(digest({ candidate, options }));
      const hash = captureCheckpoint(candidate, options).requestHash;
      if (receipts.has(options.requestId)) {
        assert.strictEqual(receipts.get(options.requestId).hash, hash);
        return { ...receipts.get(options.requestId), idempotent: true };
      }
      assert.strictEqual(options.expectedRevision, committed.revision);
      committed = { world: detachedJson(candidate), revision: committed.revision + 1, metadata: detachedJson(options.metadata) };
      receipts.set(options.requestId, { revision: committed.revision, metadata: detachedJson(options.metadata), hash });
      if (loseAcknowledgement) { loseAcknowledgement = false; throw Object.assign(new Error('lost acknowledgement'), { code: 'WORLD_DB_UNAVAILABLE' }); }
      return { revision: committed.revision };
    },
  };
  const request = { worldId: world.id, requestId: 'issue', expectedRevision: 1,
    operation: { type: 'session.issue', accountId: 'old', token: 'secret_'.repeat(8), maxSessions: 1 } };
  const issued = await administerAccount(store, request);
  assert.strictEqual(issued.idempotent, true); assert.strictEqual(attempts.length, 2); assert.strictEqual(attempts[0], attempts[1]);
  assert.strictEqual(committed.metadata.durableRuntime.configHash, 'keep-me');
  assert.ok(validateSession(committed.world, request.operation.token));
  assert.strictEqual(JSON.stringify({ committed, issued, receipts: [...receipts] }).includes(request.operation.token), false);
  await administerAccount(store, { worldId: world.id, requestId: 'suspend', expectedRevision: 2,
    operation: { type: 'account.status', accountId: 'old', status: 'suspended' } });
  await administerAccount(store, { worldId: world.id, requestId: 'activate', expectedRevision: 3,
    operation: { type: 'account.status', accountId: 'old', status: 'active' } });
  assert.strictEqual(validateSession(committed.world, request.operation.token), null);
  assert.strictEqual((await administerAccount(store, request)).revision, 2, 'retry acknowledges history without reissuing credentials');
  assert.strictEqual(validateSession(committed.world, request.operation.token), null);
  await assert.rejects(administerAccount(store, { ...request, operation: { ...request.operation, token: 'different_'.repeat(8) } }), e => e.code === 'WORLD_ADMIN_IDEMPOTENCY_CONFLICT');
  const before = digest(committed);
  await assert.rejects(administerAccount(store, { ...request, requestId: 'new-but-stale' }), e => e.code === 'WORLD_ADMIN_REVISION_CONFLICT');
  assert.strictEqual(digest(committed), before);
  await assert.rejects(administerAccount({ ...store, saveWorld: async () => { throw Object.assign(new Error('fenced'), { code: 'WORLD_DB_REVISION_CONFLICT' }); } },
    { worldId: world.id, requestId: 'fail', expectedRevision: 4, operation: { type: 'account.roles', accountId: 'old', roles: ['admin'] } }));
  assert.strictEqual(digest(committed), before, 'failed mutation never publishes its candidate');

  assert.throws(() => parseArguments(['session.issue', '--token', 'raw-secret']));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-admin-unit-'));
  try {
    const file = path.join(directory, 'token');
    const result = await cli(['token.create', '--output', file]);
    const secret = fs.readFileSync(file, 'utf8').trim();
    assert.match(secret, /^[A-Za-z0-9_-]{64}$/); assert.ok(!JSON.stringify(result).includes(secret));
    await assert.rejects(cli(['token.create', '--output', file]), e => e.code === 'EEXIST');
    assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), secret);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  console.log('durable account administration passed: ownership, session limits, redaction, commit retry, revocation and revision fence');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
