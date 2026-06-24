'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);

const DEFAULT_CREDENTIAL_OPTIONS = {
  scheme: 'scrypt-v1',
  keyLength: 64,
  saltBytes: 16,
  cost: 16384,
  blockSize: 8,
  parallelization: 1,
  maxMemory: 64 * 1024 * 1024,
  minSecretLength: 12,
  maxSecretLength: 256,
};

function validateAccountSecret(secret, options = {}) {
  const config = { ...DEFAULT_CREDENTIAL_OPTIONS, ...(options || {}) };
  const value = String(secret || '');
  if (value.length < Number(config.minSecretLength || 12)) {
    throw credentialError('secret_too_short', 400);
  }
  if (value.length > Number(config.maxSecretLength || 256)) {
    throw credentialError('secret_too_long', 400);
  }
  if (/^\s+$/.test(value)) throw credentialError('secret_invalid', 400);
  return value;
}

async function createCredentialRecord(secret, options = {}) {
  const config = { ...DEFAULT_CREDENTIAL_OPTIONS, ...(options || {}) };
  const value = validateAccountSecret(secret, config);
  const salt = options.salt
    ? Buffer.from(String(options.salt), 'hex')
    : crypto.randomBytes(Number(config.saltBytes || 16));
  const hash = await deriveSecret(value, salt, config);
  return {
    scheme: config.scheme,
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    keyLength: Number(config.keyLength || 64),
    cost: Number(config.cost || 16384),
    blockSize: Number(config.blockSize || 8),
    parallelization: Number(config.parallelization || 1),
    createdAt: new Date().toISOString(),
  };
}

async function verifyCredentialRecord(record, secret, options = {}) {
  if (!record || record.scheme !== 'scrypt-v1') return false;
  const value = String(secret || '');
  if (!value || value.length > Number(options.maxSecretLength || DEFAULT_CREDENTIAL_OPTIONS.maxSecretLength)) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(String(record.salt || ''), 'hex');
    expected = Buffer.from(String(record.hash || ''), 'hex');
  } catch (_error) {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  const config = {
    ...DEFAULT_CREDENTIAL_OPTIONS,
    ...options,
    keyLength: Number(record.keyLength || expected.length),
    cost: Number(record.cost || DEFAULT_CREDENTIAL_OPTIONS.cost),
    blockSize: Number(record.blockSize || DEFAULT_CREDENTIAL_OPTIONS.blockSize),
    parallelization: Number(record.parallelization || DEFAULT_CREDENTIAL_OPTIONS.parallelization),
  };
  try {
    const actual = await deriveSecret(value, salt, config);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_error) {
    return false;
  }
}

async function setAccountSecret(account, secret, options = {}) {
  if (!account || !account.id) throw credentialError('missing_account', 404);
  const record = await createCredentialRecord(secret, options);
  account.meta = { ...(account.meta || {}), auth: record };
  return credentialSummary(account);
}

async function verifyAccountSecret(account, secret, options = {}) {
  return verifyCredentialRecord(account?.meta?.auth, secret, options);
}

function hasAccountSecret(account) {
  return Boolean(account?.meta?.auth?.scheme && account?.meta?.auth?.hash && account?.meta?.auth?.salt);
}

function credentialSummary(account) {
  const record = account?.meta?.auth;
  return {
    accountId: account?.id || null,
    configured: hasAccountSecret(account),
    scheme: record?.scheme || null,
    createdAt: record?.createdAt || null,
  };
}

async function deriveSecret(secret, salt, config) {
  return scryptAsync(secret, salt, Number(config.keyLength || 64), {
    N: Number(config.cost || 16384),
    r: Number(config.blockSize || 8),
    p: Number(config.parallelization || 1),
    maxmem: Number(config.maxMemory || DEFAULT_CREDENTIAL_OPTIONS.maxMemory),
  });
}

function credentialError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  DEFAULT_CREDENTIAL_OPTIONS,
  validateAccountSecret,
  createCredentialRecord,
  verifyCredentialRecord,
  setAccountSecret,
  verifyAccountSecret,
  hasAccountSecret,
  credentialSummary,
};
