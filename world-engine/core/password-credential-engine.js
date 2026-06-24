'use strict';

const crypto = require('crypto');
const {
  ensureAccountState,
  getAccount,
} = require('./account-session-engine');

const CREDENTIAL_VERSION = 1;
const DEFAULT_PASSWORD_POLICY = {
  minLength: 10,
  maxLength: 256,
  requireLetter: true,
  requireNumber: true,
  saltBytes: 16,
  keyLength: 64,
  scrypt: {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  },
};

function ensureCredentialState(world) {
  const accounts = ensureAccountState(world);
  if (!accounts.credentials || typeof accounts.credentials !== 'object') {
    accounts.credentials = {
      byAccountId: {},
      stats: {
        created: 0,
        changed: 0,
        verified: 0,
        failed: 0,
      },
    };
  }
  if (!accounts.credentials.byAccountId) accounts.credentials.byAccountId = {};
  if (!accounts.credentials.stats) {
    accounts.credentials.stats = { created: 0, changed: 0, verified: 0, failed: 0 };
  }
  return accounts.credentials;
}

function normalizeAccountId(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase();
}

function validateAccountId(value) {
  const accountId = normalizeAccountId(value);
  if (accountId.length < 3 || accountId.length > 64) {
    throw credentialError('account_id_length', 'Account ID must contain 3 to 64 characters');
  }
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(accountId)) {
    throw credentialError('account_id_format', 'Account ID may contain lowercase letters, numbers, dot, underscore and hyphen');
  }
  return accountId;
}

function validatePasswordPolicy(password, policy = {}) {
  const config = mergePasswordPolicy(policy);
  const value = String(password || '');
  const length = Array.from(value).length;
  if (length < config.minLength) {
    throw credentialError('password_too_short', `Password must contain at least ${config.minLength} characters`);
  }
  if (length > config.maxLength) {
    throw credentialError('password_too_long', `Password must contain at most ${config.maxLength} characters`);
  }
  if (config.requireLetter && !/\p{L}/u.test(value)) {
    throw credentialError('password_requires_letter', 'Password must contain a letter');
  }
  if (config.requireNumber && !/\p{N}/u.test(value)) {
    throw credentialError('password_requires_number', 'Password must contain a number');
  }
  return true;
}

function setPasswordCredential(world, accountId, password, options = {}) {
  const account = getAccount(world, accountId);
  if (!account) throw credentialError('missing_account', `Missing account ${accountId}`);
  const policy = mergePasswordPolicy(options.policy || options);
  validatePasswordPolicy(password, policy);
  const state = ensureCredentialState(world);
  const existing = state.byAccountId[accountId] || null;
  const salt = crypto.randomBytes(Number(policy.saltBytes || 16));
  const hash = derivePasswordHash(password, salt, policy);
  const credential = {
    version: CREDENTIAL_VERSION,
    accountId,
    algorithm: 'scrypt',
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    keyLength: Number(policy.keyLength),
    scrypt: {
      N: Number(policy.scrypt.N),
      r: Number(policy.scrypt.r),
      p: Number(policy.scrypt.p),
      maxmem: Number(policy.scrypt.maxmem),
    },
    createdAt: existing?.createdAt ?? Number(world.tick || 0),
    updatedAt: Number(world.tick || 0),
    passwordChangedAt: Number(world.tick || 0),
  };
  state.byAccountId[accountId] = credential;
  if (existing) state.stats.changed = Number(state.stats.changed || 0) + 1;
  else state.stats.created = Number(state.stats.created || 0) + 1;
  return sanitizeCredential(credential);
}

function verifyPasswordCredential(world, accountId, password) {
  const state = ensureCredentialState(world);
  const credential = state.byAccountId[accountId];
  if (!credential || credential.algorithm !== 'scrypt') {
    state.stats.failed = Number(state.stats.failed || 0) + 1;
    performDummyPasswordHash(password);
    return false;
  }

  let valid = false;
  try {
    const salt = Buffer.from(credential.salt, 'base64');
    const expected = Buffer.from(credential.hash, 'base64');
    const actual = derivePasswordHash(password, salt, {
      keyLength: credential.keyLength,
      scrypt: credential.scrypt,
    });
    valid = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (_error) {
    valid = false;
  }

  if (valid) state.stats.verified = Number(state.stats.verified || 0) + 1;
  else state.stats.failed = Number(state.stats.failed || 0) + 1;
  return valid;
}

function hasPasswordCredential(world, accountId) {
  return Boolean(ensureCredentialState(world).byAccountId[accountId]);
}

function removePasswordCredential(world, accountId) {
  const state = ensureCredentialState(world);
  const existing = state.byAccountId[accountId] || null;
  if (existing) delete state.byAccountId[accountId];
  return existing ? sanitizeCredential(existing) : null;
}

function getCredentialStats(world) {
  const state = ensureCredentialState(world);
  return {
    credentials: Object.keys(state.byAccountId || {}).length,
    stats: { ...(state.stats || {}) },
  };
}

function sanitizeCredential(credential) {
  if (!credential) return null;
  return {
    version: credential.version,
    accountId: credential.accountId,
    algorithm: credential.algorithm,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
    passwordChangedAt: credential.passwordChangedAt,
  };
}

function derivePasswordHash(password, salt, policy = {}) {
  const config = mergePasswordPolicy(policy);
  return crypto.scryptSync(
    String(password || ''),
    salt,
    Number(config.keyLength),
    {
      N: Number(config.scrypt.N),
      r: Number(config.scrypt.r),
      p: Number(config.scrypt.p),
      maxmem: Number(config.scrypt.maxmem),
    },
  );
}

function performDummyPasswordHash(password) {
  try {
    derivePasswordHash(password, Buffer.alloc(DEFAULT_PASSWORD_POLICY.saltBytes, 0), DEFAULT_PASSWORD_POLICY);
  } catch (_error) {
    // Authentication must still return a generic failure if the dummy hash cannot run.
  }
}

function mergePasswordPolicy(patch = {}) {
  return {
    ...DEFAULT_PASSWORD_POLICY,
    ...(patch || {}),
    scrypt: {
      ...DEFAULT_PASSWORD_POLICY.scrypt,
      ...(patch?.scrypt || {}),
    },
  };
}

function credentialError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  error.statusCode = 400;
  return error;
}

module.exports = {
  CREDENTIAL_VERSION,
  DEFAULT_PASSWORD_POLICY,
  ensureCredentialState,
  normalizeAccountId,
  validateAccountId,
  validatePasswordPolicy,
  setPasswordCredential,
  verifyPasswordCredential,
  hasPasswordCredential,
  removePasswordCredential,
  getCredentialStats,
  sanitizeCredential,
  mergePasswordPolicy,
};
