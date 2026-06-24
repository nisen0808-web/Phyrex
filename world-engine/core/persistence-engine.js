'use strict';

const fs = require('fs');
const path = require('path');

const PERSISTENCE_SCHEMA_VERSION = 1;

const DEFAULT_PERSISTENCE_OPTIONS = {
  pretty: true,
  createBackup: true,
  maxBackups: 5,
  atomic: true,
};

let PERSISTENCE_SECURITY = {
  enforce: false,
  allowedRoots: [],
};

function configurePersistenceSecurity(options = {}) {
  const allowedRoots = [...new Set((options.allowedRoots || [])
    .map(root => String(root || '').trim())
    .filter(Boolean)
    .map(root => canonicalPath(path.resolve(root))))];
  PERSISTENCE_SECURITY = {
    enforce: options.enforce !== false && allowedRoots.length > 0,
    allowedRoots,
  };
  return getPersistenceSecurity();
}

function resetPersistenceSecurity() {
  PERSISTENCE_SECURITY = { enforce: false, allowedRoots: [] };
  return getPersistenceSecurity();
}

function getPersistenceSecurity() {
  return {
    enforce: Boolean(PERSISTENCE_SECURITY.enforce),
    allowedRoots: [...PERSISTENCE_SECURITY.allowedRoots],
  };
}

function resolvePersistencePath(filePath) {
  if (!filePath) throw persistenceError('missing_persistence_path', 400);
  const absolute = canonicalPath(path.resolve(filePath));
  if (PERSISTENCE_SECURITY.enforce && !PERSISTENCE_SECURITY.allowedRoots.some(root => withinRoot(root, absolute))) {
    throw persistenceError('persistence_path_forbidden', 403);
  }
  return absolute;
}

function createSaveEnvelope(world, options = {}) {
  if (!world) throw new Error('createSaveEnvelope requires world');
  const now = new Date().toISOString();
  return {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    savedAt: now,
    worldId: world.id,
    tick: world.tick,
    metadata: {
      ...(options.metadata || {}),
      engine: 'world-engine',
      reason: options.reason || 'manual',
    },
    world,
  };
}

function saveWorld(world, filePath, options = {}) {
  if (!filePath) throw new Error('saveWorld requires filePath');
  const config = { ...DEFAULT_PERSISTENCE_OPTIONS, ...(options || {}) };
  const envelope = createSaveEnvelope(world, config);
  const absolute = resolvePersistencePath(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  if (config.createBackup && fs.existsSync(absolute)) createBackupFile(absolute, config.maxBackups);
  const text = config.pretty === false ? JSON.stringify(envelope) : JSON.stringify(envelope, null, 2);
  if (config.atomic === false) fs.writeFileSync(absolute, text, { encoding: 'utf8', mode: 0o600 });
  else atomicWriteFile(absolute, text);
  return {
    file: absolute,
    schemaVersion: envelope.schemaVersion,
    worldId: envelope.worldId,
    tick: envelope.tick,
    savedAt: envelope.savedAt,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

function loadWorld(filePath, options = {}) {
  if (!filePath) throw new Error('loadWorld requires filePath');
  const absolute = resolvePersistencePath(filePath);
  const text = fs.readFileSync(absolute, 'utf8');
  const raw = JSON.parse(text);
  const envelope = normalizeEnvelope(raw);
  const migrated = migrateSaveEnvelope(envelope, options);
  repairLoadedWorld(migrated.world);
  return {
    file: absolute,
    schemaVersion: migrated.schemaVersion,
    worldId: migrated.worldId,
    tick: migrated.tick,
    savedAt: migrated.savedAt,
    metadata: { ...(migrated.metadata || {}) },
    world: migrated.world,
  };
}

function autosaveWorld(world, directory, options = {}) {
  const dir = resolvePersistencePath(directory || path.join(__dirname, '..', 'saves'));
  const name = options.fileName || `${sanitize(world.id || 'world')}-tick-${world.tick}.json`;
  return saveWorld(world, path.join(dir, name), { ...options, reason: options.reason || 'autosave' });
}

function listSaves(directory) {
  const dir = resolvePersistencePath(directory || path.join(__dirname, '..', 'saves'));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      const file = resolvePersistencePath(path.join(dir, name));
      const stat = fs.statSync(file);
      let header = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const metadata = parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
          ? { ...parsed.metadata }
          : {};
        header = {
          schemaVersion: parsed.schemaVersion,
          worldId: parsed.worldId || parsed.world?.id,
          tick: parsed.tick ?? parsed.world?.tick,
          savedAt: parsed.savedAt,
          metadata,
          label: metadata.label || metadata.name || null,
          reason: metadata.reason || null,
        };
      } catch (_) {
        header = { unreadable: true, metadata: {} };
      }
      return { file, name, size: stat.size, mtimeMs: stat.mtimeMs, ...header };
    })
    .sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
}

function migrateSaveEnvelope(envelope) {
  if (envelope.schemaVersion > PERSISTENCE_SCHEMA_VERSION) throw new Error(`Unsupported future save schema ${envelope.schemaVersion}`);
  let current = envelope;
  while (current.schemaVersion < PERSISTENCE_SCHEMA_VERSION) current = migrateOneVersion(current);
  return current;
}

function migrateOneVersion(envelope) {
  throw new Error(`No migration path for schema ${envelope.schemaVersion}`);
}

function normalizeEnvelope(raw) {
  if (raw && raw.world && raw.schemaVersion) {
    return {
      schemaVersion: Number(raw.schemaVersion || 1),
      savedAt: raw.savedAt || null,
      worldId: raw.worldId || raw.world.id,
      tick: raw.tick ?? raw.world.tick,
      metadata: raw.metadata || {},
      world: raw.world,
    };
  }
  if (raw && raw.id && raw.tick !== undefined) {
    return {
      schemaVersion: 1,
      savedAt: null,
      worldId: raw.id,
      tick: raw.tick,
      metadata: { legacy: true },
      world: raw,
    };
  }
  throw new Error('Invalid save file');
}

function repairLoadedWorld(world) {
  if (!world || typeof world !== 'object') return world;
  deleteTransientSetCaches(world);
  return world;
}

function deleteTransientSetCaches(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Object.prototype.hasOwnProperty.call(value, '_consumedSet')) delete value._consumedSet;
  if (Object.prototype.hasOwnProperty.call(value, '_seenSet')) delete value._seenSet;
  if (Object.prototype.hasOwnProperty.call(value, '_cacheSet')) delete value._cacheSet;
  for (const child of Object.values(value)) deleteTransientSetCaches(child, seen);
}

function createBackupFile(filePath, maxBackups) {
  const absolute = resolvePersistencePath(filePath);
  const backup = resolvePersistencePath(`${absolute}.bak.${Date.now()}`);
  fs.copyFileSync(absolute, backup);
  fs.chmodSync(backup, 0o600);
  const dir = path.dirname(absolute);
  const base = path.basename(absolute);
  const backups = fs.readdirSync(dir)
    .filter(name => name.startsWith(`${base}.bak.`))
    .map(name => ({ name, file: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => Number(b.mtime || 0) - Number(a.mtime || 0));
  for (const old of backups.slice(Math.max(0, maxBackups || 5))) fs.rmSync(old.file, { force: true });
  return backup;
}

function atomicWriteFile(filePath, text) {
  const temp = resolvePersistencePath(`${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let descriptor = null;
  try {
    descriptor = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(descriptor, text, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temp, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch (_) { /* ignore cleanup failure */ }
    }
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function canonicalPath(value) {
  const absolute = path.resolve(value);
  let cursor = absolute;
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const base = fs.existsSync(cursor) ? fs.realpathSync.native(cursor) : cursor;
  return path.resolve(base, ...suffix);
}

function withinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function persistenceError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sanitize(value) {
  return String(value || 'world').replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

module.exports = {
  PERSISTENCE_SCHEMA_VERSION,
  DEFAULT_PERSISTENCE_OPTIONS,
  configurePersistenceSecurity,
  resetPersistenceSecurity,
  getPersistenceSecurity,
  resolvePersistencePath,
  createSaveEnvelope,
  saveWorld,
  loadWorld,
  autosaveWorld,
  listSaves,
  migrateSaveEnvelope,
  repairLoadedWorld,
};
