'use strict';

const crypto = require('crypto');
const { getAccount } = require('./account-session-engine');

const PASSWORD_SCHEME = 'scrypt-v1';

const DEFAULT_PASSWORD_OPTIONS = {
  minLength: 12,
  maxLength: 256,
  saltBytes: 16,
  keyLength: 64,
  cost: 16384,
  blockSize: 8,
  parallelization: 1,
  maxMemory: 64 * 1024 * 1024,
};

function validatePassword(password, options = {}) {
  const config = { ...DEFAULT_PASSWORD_OPTIONS, ...(options || {}) };
  const value = typeof password === 'string' ? password : '';
  const errors = [];
  if (value.length < Number(config.minLength || 12)) errors.push('password_too_short');
  if (value.length > Number(config.maxLength || 256)) errors.push('password_too_long');
  if (!/[A-Za-z]/.test(value)) errors.push('password_requires_letter');
  if (!/[0-9]/.test(value)) errors.push('password_requires_number');
  return {
    ok: errors.length === 0,
    errors,
    minLength: Number(config.minLength || 12),
    maxLength: Number(config.maxLength || 256),
  };
}

function assertValidPassword(password, options = {}) {
  const result = validatePassword(password, options);
  if (!result.ok) {
    const error = new Error(result.errors[0] || 'invalid_password');
    error.code = result.errors[0] || 'invalid_password';
    error.validation = result;
    throw error;
  }
  return String(password);
}

function createPasswordRecord(password, options = {}) {
  const config = { ...DEFAULT_PASSWORD_OPTIONS, ...(options || {}) };
  const value = assertValidPassword(password, config);
  const salt = crypto.randomBytes(Number(config.saltBytes || 16));
  const hash = derivePasswordHash(value, salt, config);
  return {
    scheme: PASSWORD_SCHEME,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    keyLength: Number(config.keyLength || 64),
    cost: Number(config.cost || 16384),
    blockSize: Number(config.blockSize || 8),
    parallelization: Number(config.parallelization || 1),
    createdAt: new Date().toISOString(),
  };
}

function setAccountPassword(world, accountId, password, options = {}) {
  const account = getAccount(world, accountId);
  if (!account) throw new Error(`Missing account ${accountId}`);
  const record = createPasswordRecord(password, options);
  const previousCreatedAt = account.credentials?.createdAt || null;
  account.credentials = {
    ...record,
    createdAt: previousCreatedAt || record.createdAt,
    updatedAt: new Date().toISOString(),
    updatedAtTick: Number(world?.tick || 0),
  };
  account.updatedAt = Number(world?.tick || account.updatedAt || 0);
  return sanitizeCredentialRecord(account.credentials);
}

function verifyAccountPassword(world, accountId, password, options = {}) {
  const account = getAccount(world, accountId);
  if (!account) return false;
  return verifyPasswordRecord(account.credentials, password, options);
}

function verifyPasswordRecord(record, password, options = {}) {
  if (!record || record.scheme !== PASSWORD_SCHEME) return false;
  if (typeof password !== 'string' || !password.length) return false;
  try {
    const config = {
      ...DEFAULT_PASSWORD_OPTIONS,
      ...(options || {}),
      keyLength: Number(record.keyLength || DEFAULT_PASSWORD_OPTIONS.keyLength),
      cost: Number(record.cost || DEFAULT_PASSWORD_OPTIONS.cost),
      blockSize: Number(record.blockSize || DEFAULT_PASSWORD_OPTIONS.blockSize),
      parallelization: Number(record.parallelization || DEFAULT_PASSWORD_OPTIONS.parallelization),
    };
    const salt = Buffer.from(String(record.salt || ''), 'base64');
    const expected = Buffer.from(String(record.hash || ''), 'base64');
    if (!salt.length || !expected.length) return false;
    const actual = derivePasswordHash(password, salt, config);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (_error) {
    return false;
  }
}

function accountHasPassword(world, accountId) {
  return Boolean(getAccount(world, accountId)?.credentials?.hash);
}

function clearAccountPassword(world, accountId) {
  const account = getAccount(world, accountId);
  if (!account) return false;
  delete account.credentials;
  account.updatedAt = Number(world?.tick || account.updatedAt || 0);
  return true;
}

function sanitizeCredentialRecord(record) {
  if (!record) return null;
  return {
    scheme: record.scheme,
    configured: Boolean(record.hash && record.salt),
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
    updatedAtTick: record.updatedAtTick ?? null,
  };
}

function derivePasswordHash(password, salt, options) {
  return crypto.scryptSync(String(password), salt, Number(options.keyLength || 64), {
    N: Number(options.cost || 16384),
    r: Number(options.blockSize || 8),
    p: Number(options.parallelization || 1),
    maxmem: Number(options.maxMemory || 64 * 1024 * 1024),
  });
}

module.exports = {
  PASSWORD_SCHEME,
  DEFAULT_PASSWORD_OPTIONS,
  validatePassword,
  assertValidPassword,
  createPasswordRecord,
  setAccountPassword,
  verifyAccountPassword,
  verifyPasswordRecord,
  accountHasPassword,
  clearAccountPassword,
  sanitizeCredentialRecord,
};
