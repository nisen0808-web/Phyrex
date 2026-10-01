'use strict';
const { detachedJson, digest, textId, safeInteger } = require('../storage/postgres/codec');
const { createAccount, getAccount, linkPlayerToAccount, createSession, revokeSession,
  revokeAccountSessions, hashSessionToken } = require('../core/account-session-engine');
const { retryable } = require('./durable-world-runtime');

function adminError(code) { const error = new Error(`Account administration: ${code}`); error.code = `WORLD_ADMIN_${code}`; return error; }
function identifier(value, name) {
  textId(value, name, 120);
  if (['__proto__', 'prototype', 'constructor'].includes(value)) throw adminError('INVALID_INPUT');
  return value;
}
function captureOperation(input) {
  const operation = detachedJson(input);
  const fields = {
    'account.create': ['accountId', 'name', 'roles'],
    'account.roles': ['accountId', 'roles'],
    'account.status': ['accountId', 'status'],
    'player.link': ['accountId', 'playerId'],
    'player.unlink': ['accountId', 'playerId'],
    'session.issue': ['accountId', 'token', 'ttlTicks', 'maxSessions'],
    'session.revoke': ['accountId', 'sessionId'],
    'session.revoke-all': ['accountId'],
  };
  if (!operation || !Object.hasOwn(fields, operation.type) || Object.keys(operation).some(key => key !== 'type' && !fields[operation.type].includes(key))) throw adminError('INVALID_INPUT');
  identifier(operation.accountId, 'accountId');
  if (operation.type === 'account.create') {
    operation.name = operation.name ?? operation.accountId; textId(operation.name, 'account name', 120);
    operation.roles = operation.roles ?? ['player'];
  }
  if (['account.create', 'account.roles'].includes(operation.type)) {
    if (!Array.isArray(operation.roles) || !operation.roles.length || operation.roles.length > 3 || operation.roles.some(role => !['player', 'gm', 'admin'].includes(role))) throw adminError('INVALID_INPUT');
    operation.roles = [...new Set(operation.roles)].sort();
  }
  if (operation.type === 'account.status' && !['active', 'suspended', 'closed'].includes(operation.status)) throw adminError('INVALID_INPUT');
  if (operation.type.startsWith('player.')) identifier(operation.playerId, 'playerId');
  if (operation.type === 'session.revoke') identifier(operation.sessionId, 'sessionId');
  if (operation.type === 'session.issue') {
    if (typeof operation.token !== 'string' || !/^[A-Za-z0-9_-]{32,512}$/.test(operation.token)) throw adminError('INVALID_TOKEN');
    operation.ttlTicks = operation.ttlTicks ?? 10000;
    operation.maxSessions = operation.maxSessions ?? 20;
    safeInteger(operation.ttlTicks, 'session TTL', 1); safeInteger(operation.maxSessions, 'session limit', 1);
    if (operation.maxSessions > 1000) throw adminError('INVALID_INPUT');
  }
  return operation;
}

function applyOperation(world, operation) {
  const { type, accountId } = operation;
  let account = getAccount(world, accountId);
  if (type === 'account.create') {
    if (account) throw adminError('ACCOUNT_EXISTS');
    account = createAccount(world, { id: accountId, name: operation.name, roles: operation.roles });
  } else if (!account) throw adminError('MISSING_ACCOUNT');
  const result = { operation: type, accountId };
  if (type === 'account.roles') account.roles = operation.roles;
  if (type === 'account.status') {
    account.status = operation.status;
    if (account.status !== 'active') result.revokedSessions = revokeAccountSessions(world, accountId, { reason: 'account_disabled' }).length;
  }
  if (type === 'player.link') {
    if (!Object.hasOwn(world.players?.byId || {}, operation.playerId)) throw adminError('MISSING_PLAYER');
    linkPlayerToAccount(world, accountId, operation.playerId); result.playerId = operation.playerId;
  }
  if (type === 'player.unlink') {
    if (world.accounts.byPlayer[operation.playerId] !== accountId) throw adminError('PLAYER_NOT_OWNED');
    account.playerIds = account.playerIds.filter(id => id !== operation.playerId);
    delete world.accounts.byPlayer[operation.playerId]; result.playerId = operation.playerId;
  }
  if (type === 'session.issue') {
    if (account.status !== 'active') throw adminError('ACCOUNT_INACTIVE');
    // Reject token reuse even if a revoked session has no active-token index.
    const tokenHash = hashSessionToken(operation.token);
    if (Object.values(world.accounts.sessions).some(session => session.tokenHash === tokenHash)) throw adminError('TOKEN_REUSED');
    if (!Number.isSafeInteger(world.tick + operation.ttlTicks)) throw adminError('INVALID_INPUT');
    const session = createSession(world, accountId, { token: operation.token,
      sessionTtlTicks: operation.ttlTicks, maxSessionsPerAccount: operation.maxSessions });
    result.sessionId = session.id; result.expiresAt = session.expiresAt;
  }
  if (type === 'session.revoke') {
    const session = world.accounts.sessions[operation.sessionId];
    if (!session || session.accountId !== accountId) throw adminError('MISSING_SESSION');
    revokeSession(world, session.id, 'operator_revoked'); result.sessionId = session.id;
  }
  if (type === 'session.revoke-all') result.revokedSessions = revokeAccountSessions(world, accountId, { reason: 'operator_revoked' }).length;
  account.updatedAt = world.tick;
  return { ...result, status: account.status, roles: [...account.roles] };
}

// Trusted operator API: possession of database write access is the authority.
// It is intentionally not exposed as an HTTP route or player command.
async function administerAccount(store, input) {
  const worldId = textId(input.worldId, 'worldId');
  const requestId = `admin:${identifier(input.requestId, 'requestId')}`;
  const expectedRevision = safeInteger(input.expectedRevision, 'expectedRevision', 1);
  const operation = captureOperation(input.operation);
  const { token, ...safeOperation } = operation;
  const requestDigest = digest({ worldId, expectedRevision, operation: { ...safeOperation,
    ...(token ? { tokenHash: hashSessionToken(token) } : {}) } });
  const previous = await store.getCheckpointRequest(worldId, requestId);
  function acknowledge(previous) {
    const receipt = previous.metadata?.durableAdministration;
    if (receipt?.version !== 1 || receipt.requestDigest !== requestDigest) throw adminError('IDEMPOTENCY_CONFLICT');
    return { ...detachedJson(receipt.result), worldId, revision: previous.revision, idempotent: true };
  }
  if (previous) {
    return acknowledge(previous);
  }
  const loaded = await store.loadWorld(worldId);
  if (!loaded) throw adminError('MISSING_WORLD');
  if (loaded.revision !== expectedRevision) throw adminError('REVISION_CONFLICT');
  const candidate = detachedJson(loaded.world);
  const result = applyOperation(candidate, operation);
  const options = { expectedRevision, requestId, reason: 'durable_account_administration',
    metadata: { ...loaded.metadata, durableAdministration: { version: 1, requestDigest, result } },
    events: [{ id: requestId, type: 'account.administration', payload: result }] };
  // Reuse the exact candidate, including generated session ID, after a lost
  // commit acknowledgement. Never rebase or replay a mutation on a newer world.
  for (let attempt = 0; ; attempt++) {
    try {
      const saved = await store.saveWorld(detachedJson(candidate), detachedJson(options));
      return { ...result, worldId, revision: saved.revision, idempotent: saved.idempotent === true };
    } catch (error) {
      // Concurrent identical issuers may have generated distinct session IDs.
      // The winner's stable operation receipt is authoritative.
      if (error?.code === 'WORLD_DB_IDEMPOTENCY_CONFLICT') {
        const receipt = await store.getCheckpointRequest(worldId, requestId);
        if (receipt) return acknowledge(receipt);
      }
      if (attempt >= 2 || !retryable(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * (2 ** attempt)));
    }
  }
}
module.exports = { administerAccount, captureOperation, applyOperation };
