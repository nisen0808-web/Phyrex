'use strict';

const crypto = require('crypto');

const ACCOUNT_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CLOSED: 'closed',
};

const SESSION_STATUS = {
  ACTIVE: 'active',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
};

const DEFAULT_ACCOUNT_OPTIONS = {
  sessionTtlTicks: 10000,
  maxSessionsPerAccount: 20,
};

function ensureAccountState(world) {
  if (!world.accounts) world.accounts = {};
  const state = world.accounts;
  if (!state.byId) state.byId = {};
  if (!state.byPlayer) state.byPlayer = {};
  if (!state.sessions) state.sessions = {};
  if (!state.byTokenHash) state.byTokenHash = {};
  if (!state.stats) {
    state.stats = {
      created: 0,
      sessionsCreated: 0,
      sessionsRevoked: 0,
      sessionsMigrated: 0,
      playersLinked: 0,
    };
  }
  if (state.stats.sessionsMigrated === undefined) state.stats.sessionsMigrated = 0;
  migrateLegacySessionTokens(state);
  return state;
}

function repairAccountSessionState(world) {
  return ensureAccountState(world);
}

function createAccount(world, input = {}) {
  const state = ensureAccountState(world);
  const id = input.id || `account_${world.tick}_${randomId(8)}`;
  if (state.byId[id]) return state.byId[id];
  const account = {
    id,
    name: input.name || id,
    status: input.status || ACCOUNT_STATUS.ACTIVE,
    roles: normalizeRoles(input.roles),
    playerIds: Array.isArray(input.playerIds) ? [...new Set(input.playerIds)] : [],
    createdAt: world.tick,
    updatedAt: world.tick,
    lastLoginAt: null,
    meta: { ...(input.meta || {}) },
  };
  state.byId[id] = account;
  for (const playerId of account.playerIds) state.byPlayer[playerId] = id;
  state.stats.created = Number(state.stats.created || 0) + 1;
  return account;
}

function getAccount(world, accountId) {
  const state = ensureAccountState(world);
  return state.byId[accountId] || null;
}

function linkPlayerToAccount(world, accountId, playerId) {
  const state = ensureAccountState(world);
  const account = getAccount(world, accountId);
  if (!account) throw new Error(`Missing account ${accountId}`);
  if (!world.players?.byId?.[playerId]) throw new Error(`Missing player ${playerId}`);
  if (!account.playerIds.includes(playerId)) account.playerIds.push(playerId);
  account.updatedAt = world.tick;
  state.byPlayer[playerId] = accountId;
  state.stats.playersLinked = Number(state.stats.playersLinked || 0) + 1;
  return account;
}

function getAccountByPlayer(world, playerId) {
  const state = ensureAccountState(world);
  const accountId = state.byPlayer[playerId];
  return accountId ? state.byId[accountId] || null : null;
}

function createSession(world, accountId, options = {}) {
  const state = ensureAccountState(world);
  const account = getAccount(world, accountId);
  if (!account) throw new Error(`Missing account ${accountId}`);
  if (account.status !== ACCOUNT_STATUS.ACTIVE) throw new Error(`Account ${accountId} is not active`);
  const ttl = Number(options.sessionTtlTicks ?? DEFAULT_ACCOUNT_OPTIONS.sessionTtlTicks);
  const token = options.token || `sess_${randomId(32)}`;
  const tokenHash = hashSessionToken(token);
  if (state.byTokenHash[tokenHash]) throw new Error('Session token collision');
  const session = {
    id: `session_${world.tick}_${randomId(8)}`,
    tokenHash,
    tokenPrefix: sessionTokenPrefix(token),
    accountId,
    status: SESSION_STATUS.ACTIVE,
    createdAt: world.tick,
    lastSeenAt: world.tick,
    expiresAt: ttl > 0 ? world.tick + ttl : null,
    meta: { ...(options.meta || {}) },
  };
  state.sessions[session.id] = session;
  state.byTokenHash[tokenHash] = session.id;
  account.lastLoginAt = world.tick;
  account.updatedAt = world.tick;
  state.stats.sessionsCreated = Number(state.stats.sessionsCreated || 0) + 1;
  trimAccountSessions(
    world,
    accountId,
    options.maxSessionsPerAccount || DEFAULT_ACCOUNT_OPTIONS.maxSessionsPerAccount,
  );
  return { ...session, token };
}

function getSessionByToken(world, token) {
  if (!token) return null;
  const state = ensureAccountState(world);
  const sessionId = state.byTokenHash[hashSessionToken(token)];
  return sessionId ? state.sessions[sessionId] || null : null;
}

function validateSession(world, token) {
  const session = getSessionByToken(world, token);
  if (!session) return null;
  if (session.status !== SESSION_STATUS.ACTIVE) return null;
  if (session.expiresAt !== null && Number(session.expiresAt) < Number(world.tick || 0)) {
    session.status = SESSION_STATUS.EXPIRED;
    delete ensureAccountState(world).byTokenHash[session.tokenHash];
    return null;
  }
  session.lastSeenAt = world.tick;
  const account = getAccount(world, session.accountId);
  if (!account || account.status !== ACCOUNT_STATUS.ACTIVE) return null;
  return { session, account };
}

function revokeSession(world, tokenOrSessionId, reason = 'manual') {
  const state = ensureAccountState(world);
  const session = state.sessions[tokenOrSessionId] || getSessionByToken(world, tokenOrSessionId);
  if (!session) return null;
  if (session.status === SESSION_STATUS.ACTIVE) {
    state.stats.sessionsRevoked = Number(state.stats.sessionsRevoked || 0) + 1;
  }
  session.status = SESSION_STATUS.REVOKED;
  session.revokedAt = world.tick;
  session.revokeReason = reason;
  if (session.tokenHash) delete state.byTokenHash[session.tokenHash];
  return session;
}

function revokeAccountSessions(world, accountId, options = {}) {
  const state = ensureAccountState(world);
  const exceptSessionId = options.exceptSessionId || null;
  const reason = options.reason || 'account_sessions_revoked';
  const revoked = [];
  for (const session of Object.values(state.sessions || {})) {
    if (session.accountId !== accountId || session.id === exceptSessionId) continue;
    if (session.status !== SESSION_STATUS.ACTIVE) continue;
    const result = revokeSession(world, session.id, reason);
    if (result) revoked.push(result);
  }
  return revoked;
}

function getAccountView(world, accountId) {
  const account = getAccount(world, accountId);
  if (!account) return null;
  const state = ensureAccountState(world);
  const sessions = Object.values(state.sessions || {}).filter(session => session.accountId === accountId);
  return {
    id: account.id,
    name: account.name,
    status: account.status,
    roles: [...(account.roles || [])],
    playerIds: [...(account.playerIds || [])],
    players: (account.playerIds || []).map(playerId => {
      const player = world.players?.byId?.[playerId];
      return player
        ? { id: player.id, name: player.name, status: player.status, activeEntityId: player.activeEntityId }
        : { id: playerId, missing: true };
    }),
    sessions: sessions.map(session => sanitizeSession(session)),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastLoginAt: account.lastLoginAt,
  };
}

function getAccountStats(world) {
  const state = ensureAccountState(world);
  const accounts = Object.values(state.byId || {});
  const sessions = Object.values(state.sessions || {});
  return {
    accounts: accounts.length,
    activeAccounts: accounts.filter(account => account.status === ACCOUNT_STATUS.ACTIVE).length,
    sessions: sessions.length,
    activeSessions: sessions.filter(session => session.status === SESSION_STATUS.ACTIVE).length,
    byStatus: countBy(accounts.map(account => account.status)),
    sessionByStatus: countBy(sessions.map(session => session.status)),
    stats: { ...(state.stats || {}) },
  };
}

function sanitizeSession(session) {
  return {
    id: session.id,
    accountId: session.accountId,
    status: session.status,
    tokenPrefix: session.tokenPrefix || null,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt || null,
  };
}

function trimAccountSessions(world, accountId, limit) {
  const state = ensureAccountState(world);
  const sessions = Object.values(state.sessions || {})
    .filter(session => session.accountId === accountId)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  for (const session of sessions.slice(limit)) revokeSession(world, session.id, 'trimmed');
}

function migrateLegacySessionTokens(state) {
  const mappings = state.byToken && typeof state.byToken === 'object'
    ? Object.entries(state.byToken)
    : [];
  for (const [token, sessionId] of mappings) {
    const session = state.sessions?.[sessionId];
    if (!session) continue;
    migrateOneSessionToken(state, session, token);
  }

  for (const session of Object.values(state.sessions || {})) {
    if (session.token) migrateOneSessionToken(state, session, session.token);
    if (session.tokenHash && session.status === SESSION_STATUS.ACTIVE) {
      state.byTokenHash[session.tokenHash] = session.id;
    }
    delete session.token;
  }
  delete state.byToken;
}

function migrateOneSessionToken(state, session, token) {
  if (!token) return;
  if (!session.tokenHash) {
    session.tokenHash = hashSessionToken(token);
    session.tokenPrefix = session.tokenPrefix || sessionTokenPrefix(token);
    state.stats.sessionsMigrated = Number(state.stats.sessionsMigrated || 0) + 1;
  }
  if (session.status === SESSION_STATUS.ACTIVE) state.byTokenHash[session.tokenHash] = session.id;
  delete session.token;
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function sessionTokenPrefix(token) {
  const value = String(token || '');
  return value ? value.slice(0, 12) : null;
}

function normalizeRoles(roles) {
  const allowed = new Set(['player', 'gm', 'admin']);
  const values = Array.isArray(roles) && roles.length ? roles : ['player'];
  const normalized = [...new Set(values.map(value => String(value || '').trim()).filter(value => allowed.has(value)))];
  return normalized.length ? normalized : ['player'];
}

function randomId(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function countBy(values) {
  const out = {};
  for (const value of values || []) {
    const key = value === undefined || value === null ? 'unknown' : String(value);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

module.exports = {
  ACCOUNT_STATUS,
  SESSION_STATUS,
  DEFAULT_ACCOUNT_OPTIONS,
  ensureAccountState,
  repairAccountSessionState,
  createAccount,
  getAccount,
  linkPlayerToAccount,
  getAccountByPlayer,
  createSession,
  getSessionByToken,
  validateSession,
  revokeSession,
  revokeAccountSessions,
  getAccountView,
  getAccountStats,
  sanitizeSession,
  hashSessionToken,
};
