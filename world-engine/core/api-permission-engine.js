'use strict';

const ROLE = {
  PLAYER: 'player',
  GM: 'gm',
  ADMIN: 'admin',
};

function hasRole(account, role) {
  return Boolean(account && Array.isArray(account.roles) && account.roles.includes(role));
}

function isPrivileged(account) {
  return hasRole(account, ROLE.ADMIN) || hasRole(account, ROLE.GM);
}

function ownsPlayer(account, playerId) {
  return Boolean(account && (account.playerIds || []).includes(playerId));
}

function canAccessAccount(account, accountId) {
  return Boolean(account && (account.id === accountId || isPrivileged(account)));
}

function canAccessPlayer(account, playerId) {
  return Boolean(account && (ownsPlayer(account, playerId) || isPrivileged(account)));
}

function canRunWorldControl(account) {
  return isPrivileged(account);
}

function requirePermission(condition, message = 'forbidden') {
  if (!condition) {
    const error = new Error(message);
    error.statusCode = 403;
    throw error;
  }
}

function requireSession(sessionAuth) {
  if (!sessionAuth || !sessionAuth.account) {
    const error = new Error('auth_required');
    error.statusCode = 401;
    throw error;
  }
  return sessionAuth;
}

module.exports = {
  ROLE,
  hasRole,
  isPrivileged,
  ownsPlayer,
  canAccessAccount,
  canAccessPlayer,
  canRunWorldControl,
  requirePermission,
  requireSession,
};
