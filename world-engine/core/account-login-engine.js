'use strict';

const {
  ACCOUNT_STATUS,
  getAccount,
  createSession,
  getAccountView,
  sanitizeSession,
} = require('./account-session-engine');
const {
  normalizeAccountId,
  verifyPasswordCredential,
  hasPasswordCredential,
} = require('./password-credential-engine');

function loginAccount(world, input = {}, options = {}) {
  const accountId = normalizeAccountId(input.accountId || input.id);
  const account = accountId ? getAccount(world, accountId) : null;
  const valid = Boolean(
    account
    && account.status === ACCOUNT_STATUS.ACTIVE
    && hasPasswordCredential(world, accountId)
    && verifyPasswordCredential(world, accountId, input.password),
  );
  if (!valid) throw loginError();
  const issued = createSession(world, accountId, {
    sessionTtlTicks: Number(options.sessionTtlTicks || 100000),
    meta: { source: 'password_login', ...(input.meta || {}) },
  });
  return {
    token: issued.token,
    account: getAccountView(world, accountId),
    session: sanitizeSession(issued),
  };
}

function loginError() {
  const error = new Error('invalid_credentials');
  error.code = 'invalid_credentials';
  error.statusCode = 401;
  return error;
}

module.exports = { loginAccount };
