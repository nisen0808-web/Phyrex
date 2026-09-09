'use strict';
const { URL } = require('url');

function databaseError(code, message) {
  const error = new Error(message || code);
  error.code = `WORLD_DB_${code}`;
  return error;
}
function integer(value, fallback, min, max, name) {
  const number = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max || value === '') {
    throw databaseError('INVALID_CONFIG', `Invalid ${name}`);
  }
  return number;
}
function normalizePostgresConfig(input = {}, env = process.env) {
  let url;
  try { url = new URL(input.connectionString ?? env.WORLD_ENGINE_DATABASE_URL ?? env.DATABASE_URL); }
  catch (_) { throw databaseError('INVALID_CONFIG', 'A PostgreSQL connection URL is required'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === '/') {
    throw databaseError('INVALID_CONFIG', 'Invalid PostgreSQL connection URL');
  }
  const schema = input.schema ?? env.WORLD_ENGINE_DB_SCHEMA ?? 'world_engine';
  if (typeof schema !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema === 'public' || schema.startsWith('pg_')) {
    throw databaseError('INVALID_CONFIG', 'Use a dedicated PostgreSQL schema identifier');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const sslMode = input.sslMode ?? env.WORLD_ENGINE_DB_SSL_MODE ?? url.searchParams.get('sslmode') ?? (local ? 'disable' : 'verify-full');
  if (!['disable', 'verify-full'].includes(sslMode)) throw databaseError('INVALID_CONFIG', 'sslMode must be disable or verify-full');
  if (sslMode === 'disable' && !local && input.allowInsecureRemote !== true) {
    throw databaseError('INVALID_CONFIG', 'Remote PostgreSQL connections require certificate verification');
  }
  // Prevent URL SSL parameters from replacing the explicit verified TLS policy.
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('ssl')) {
      if (key !== 'sslmode') throw databaseError('INVALID_CONFIG', 'Configure TLS through adapter options');
      url.searchParams.delete(key);
    }
  }
  const ca = input.sslCa ?? env.WORLD_ENGINE_DB_SSL_CA;
  return {
    provider: 'postgres', schema, connectionString: url.toString(), sslMode,
    ssl: sslMode === 'disable' ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    max: integer(input.maxConnections ?? env.WORLD_ENGINE_DB_POOL_SIZE, 4, 1, 64, 'pool size'),
    connectionTimeoutMillis: integer(input.connectionTimeoutMillis, 5000, 1, 120000, 'connection timeout'),
    idleTimeoutMillis: integer(input.idleTimeoutMillis, 30000, 1, 600000, 'idle timeout'),
    statementTimeoutMillis: integer(input.statementTimeoutMillis, 15000, 1, 300000, 'statement timeout'),
    lockTimeoutMillis: integer(input.lockTimeoutMillis, 5000, 1, 120000, 'lock timeout'),
    maxEnvelopeBytes: integer(input.maxEnvelopeBytes, 32 * 1024 * 1024, 1024, 128 * 1024 * 1024, 'checkpoint size'),
  };
}
function safePostgresConfig(config) {
  return { provider: 'postgres', schema: config.schema, sslMode: config.sslMode,
    maxConnections: config.max, connectionTimeoutMillis: config.connectionTimeoutMillis,
    statementTimeoutMillis: config.statementTimeoutMillis, lockTimeoutMillis: config.lockTimeoutMillis,
    maxEnvelopeBytes: config.maxEnvelopeBytes };
}
module.exports = { normalizePostgresConfig, safePostgresConfig, databaseError, integer };
