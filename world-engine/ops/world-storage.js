'use strict';

const fs = require('fs');
const path = require('path');
const {
  loadWorld,
  saveWorld,
} = require('../core/persistence-engine');
const {
  createWorldTemplateRegistry,
  createWorldFromTemplate,
  getWorldTemplate,
  listWorldTemplates,
} = require('../core/world-template-engine');
const {
  ACCOUNT_STATUS,
  createAccount,
  createSession,
  validateSession,
  getSessionByToken,
} = require('../core/account-session-engine');
const { canRunWorldControl } = require('../core/api-permission-engine');
const { getVersionInfo } = require('../core/version-engine');

class OperationalStorageError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'OperationalStorageError';
    this.details = details;
  }
}

function ensureOperationalDirectories(config) {
  for (const directory of [
    config.dataDir,
    config.backupDir,
    path.dirname(config.worldFile),
    path.dirname(config.adminTokenFile),
    path.dirname(config.autosavePath),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return {
    dataDir: config.dataDir,
    backupDir: config.backupDir,
    worldFile: config.worldFile,
    adminTokenFile: config.adminTokenFile,
  };
}

function loadOperationalWorld(config, options = {}) {
  const logger = options.logger || null;
  ensureOperationalDirectories(config);
  const primaryExists = fs.existsSync(config.worldFile);
  if (primaryExists) {
    try {
      const loaded = loadWorld(config.worldFile);
      logger?.info('world_loaded', {
        source: 'primary',
        file: loaded.file,
        worldId: loaded.worldId,
        tick: loaded.tick,
      });
      return {
        world: loaded.world,
        source: 'primary',
        file: loaded.file,
        recovered: false,
        metadata: loaded.metadata || {},
      };
    } catch (error) {
      logger?.error('world_primary_load_failed', { file: config.worldFile, error });
      if (!config.recoverFromBackup) {
        throw new OperationalStorageError('Primary world save is unreadable and recovery is disabled', {
          file: config.worldFile,
          cause: error.message,
        });
      }
      const recovered = recoverOperationalWorld(config, { logger });
      if (recovered) return recovered;
      throw new OperationalStorageError('Primary world save is unreadable and no valid backup was found', {
        file: config.worldFile,
        cause: error.message,
      });
    }
  }

  if (config.recoverFromBackup) {
    const recovered = recoverOperationalWorld(config, { logger });
    if (recovered) return recovered;
  }

  const world = buildInitialOperationalWorld(config);
  logger?.info('world_created', {
    source: 'template',
    templateId: config.initialTemplateId,
    worldId: world.id,
    tick: world.tick,
  });
  return {
    world,
    source: `template:${config.initialTemplateId}`,
    file: null,
    recovered: false,
    metadata: {},
  };
}

function recoverOperationalWorld(config, options = {}) {
  const logger = options.logger || null;
  for (const candidate of findRecoveryCandidates(config)) {
    try {
      const loaded = loadWorld(candidate.file);
      logger?.warn('world_recovered', {
        source: candidate.source,
        file: loaded.file,
        worldId: loaded.worldId,
        tick: loaded.tick,
      });
      return {
        world: loaded.world,
        source: candidate.source,
        file: loaded.file,
        recovered: true,
        metadata: loaded.metadata || {},
      };
    } catch (error) {
      logger?.warn('world_recovery_candidate_failed', {
        source: candidate.source,
        file: candidate.file,
        error,
      });
    }
  }
  return null;
}

function findRecoveryCandidates(config) {
  const candidates = [];
  if (fs.existsSync(config.backupDir)) {
    for (const name of fs.readdirSync(config.backupDir)) {
      const file = path.join(config.backupDir, name);
      if (!name.endsWith('.json') || !fs.statSync(file).isFile()) continue;
      candidates.push({ file, source: 'backup-directory', mtimeMs: fs.statSync(file).mtimeMs });
    }
  }

  const primaryDir = path.dirname(config.worldFile);
  const primaryName = path.basename(config.worldFile);
  if (fs.existsSync(primaryDir)) {
    for (const name of fs.readdirSync(primaryDir)) {
      if (!name.startsWith(`${primaryName}.bak.`)) continue;
      const file = path.join(primaryDir, name);
      if (!fs.statSync(file).isFile()) continue;
      candidates.push({ file, source: 'primary-rotation', mtimeMs: fs.statSync(file).mtimeMs });
    }
  }

  return candidates.sort((left, right) => Number(right.mtimeMs || 0) - Number(left.mtimeMs || 0));
}

function buildInitialOperationalWorld(config) {
  const registry = createWorldTemplateRegistry();
  const template = getWorldTemplate(registry, config.initialTemplateId);
  if (!template) {
    const available = listWorldTemplates(registry).map(item => item.id).join(', ');
    throw new OperationalStorageError(`Unknown initial world template ${config.initialTemplateId}`, {
      available,
    });
  }
  return createWorldFromTemplate(registry, config.initialTemplateId, {
    worldId: config.initialWorldId || undefined,
    seedTicks: config.seedTicks,
    initialize: true,
  });
}

function bootstrapOperationalAdmin(world, config, options = {}) {
  if (!config.bootstrapAdmin) return null;
  ensureOperationalDirectories(config);
  const logger = options.logger || null;
  const account = createAccount(world, {
    id: config.adminAccountId,
    name: config.adminAccountName,
    roles: ['admin', 'gm'],
    status: ACCOUNT_STATUS.ACTIVE,
    meta: { operationalBootstrap: true },
  });
  account.status = ACCOUNT_STATUS.ACTIVE;
  account.name = config.adminAccountName || account.name;
  account.roles = [...new Set([...(account.roles || []), 'admin', 'gm'])];
  account.meta = { ...(account.meta || {}), operationalBootstrap: true };

  const configuredToken = config.adminToken || null;
  const fileToken = configuredToken ? null : readTokenFile(config.adminTokenFile);
  const candidateToken = configuredToken || fileToken;
  if (candidateToken) {
    const authenticated = validateSession(world, candidateToken);
    if (authenticated?.account?.id === account.id && canRunWorldControl(authenticated.account)) {
      writeTokenFile(config.adminTokenFile, candidateToken);
      logger?.info('admin_session_reused', {
        accountId: account.id,
        tokenFile: config.adminTokenFile,
      });
      return {
        account,
        session: authenticated.session,
        token: candidateToken,
        tokenFile: config.adminTokenFile,
        reused: true,
      };
    }
    const collision = getSessionByToken(world, candidateToken);
    if (configuredToken && collision && collision.accountId !== account.id) {
      throw new OperationalStorageError('Configured administrator token belongs to a different account', {
        accountId: account.id,
        tokenAccountId: collision.accountId,
      });
    }
  }

  const session = createSession(world, account.id, {
    token: configuredToken || undefined,
    sessionTtlTicks: config.adminSessionTtlTicks,
    meta: { operationalBootstrap: true },
  });
  writeTokenFile(config.adminTokenFile, session.token);
  logger?.warn('admin_session_created', {
    accountId: account.id,
    tokenFile: config.adminTokenFile,
    expiresAt: session.expiresAt,
  });
  return {
    account,
    session,
    token: session.token,
    tokenFile: config.adminTokenFile,
    reused: false,
  };
}

function savePrimaryWorld(world, config, reason = 'operational_save', options = {}) {
  ensureOperationalDirectories(config);
  const version = getVersionInfo({ buildSha: config.buildSha, buildDate: config.buildDate });
  return saveWorld(world, config.worldFile, {
    createBackup: options.createBackup === true,
    maxBackups: config.maxBackups,
    reason,
    metadata: {
      source: 'operational_service',
      releaseVersion: version.version,
      buildSha: version.buildSha,
      ...(options.metadata || {}),
    },
  });
}

function createOperationalBackup(world, config, reason = 'manual') {
  ensureOperationalDirectories(config);
  const fileName = [
    sanitizeFilePart(world.id || 'world'),
    `tick-${Number(world.tick || 0)}`,
    sanitizeFilePart(reason),
    timestampForFile(),
  ].join('-') + '.json';
  const filePath = path.join(config.backupDir, fileName);
  const version = getVersionInfo({ buildSha: config.buildSha, buildDate: config.buildDate });
  const result = saveWorld(world, filePath, {
    createBackup: false,
    reason,
    metadata: {
      source: 'operational_backup',
      releaseVersion: version.version,
      buildSha: version.buildSha,
    },
  });
  pruneOperationalBackups(config.backupDir, config.maxBackups);
  return result;
}

function pruneOperationalBackups(directory, maxBackups) {
  if (!fs.existsSync(directory)) return [];
  const files = fs.readdirSync(directory)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      const file = path.join(directory, name);
      return { file, mtimeMs: fs.statSync(file).mtimeMs };
    })
    .sort((left, right) => Number(right.mtimeMs || 0) - Number(left.mtimeMs || 0));
  const removed = [];
  for (const item of files.slice(Math.max(1, Number(maxBackups || 1)))) {
    fs.rmSync(item.file, { force: true });
    removed.push(item.file);
  }
  return removed;
}

function readTokenFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim() || null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function writeTokenFile(filePath, token) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${String(token).trim()}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (_error) {
    // Windows and some mounted filesystems may not support POSIX mode changes.
  }
  return filePath;
}

function inspectTokenFilePermissions(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, mode: null, secure: null };
  const mode = fs.statSync(filePath).mode & 0o777;
  return {
    exists: true,
    mode,
    secure: process.platform === 'win32' ? null : (mode & 0o077) === 0,
  };
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function sanitizeFilePart(value) {
  return String(value || 'world').replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

module.exports = {
  OperationalStorageError,
  ensureOperationalDirectories,
  loadOperationalWorld,
  recoverOperationalWorld,
  findRecoveryCandidates,
  buildInitialOperationalWorld,
  bootstrapOperationalAdmin,
  savePrimaryWorld,
  createOperationalBackup,
  pruneOperationalBackups,
  readTokenFile,
  writeTokenFile,
  inspectTokenFilePermissions,
  timestampForFile,
  sanitizeFilePart,
};
