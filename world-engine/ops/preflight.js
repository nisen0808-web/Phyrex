'use strict';

const fs = require('fs');
const path = require('path');
const {
  loadOperationalConfig,
  publicOperationalConfig,
  operationalUsage,
} = require('./operational-config');
const {
  ensureOperationalDirectories,
  inspectTokenFilePermissions,
  buildInitialOperationalWorld,
} = require('./world-storage');
const { loadWorld } = require('../core/persistence-engine');
const { getVersionInfo } = require('../core/version-engine');

function runOperationalPreflight(config) {
  const checks = [];
  const warnings = [...(config.warnings || [])];
  const errors = [];

  try {
    ensureOperationalDirectories(config);
    checks.push(check('directories', true, {
      dataDir: config.dataDir,
      backupDir: config.backupDir,
    }));
  } catch (error) {
    checks.push(check('directories', false, { error: error.message }));
    errors.push(`directories: ${error.message}`);
  }

  for (const directory of [config.dataDir, config.backupDir, path.dirname(config.worldFile)]) {
    try {
      testDirectoryWritable(directory);
      checks.push(check(`writable:${directory}`, true));
    } catch (error) {
      checks.push(check(`writable:${directory}`, false, { error: error.message }));
      errors.push(`not writable: ${directory}`);
    }
  }

  if (fs.existsSync(config.worldFile)) {
    try {
      const loaded = loadWorld(config.worldFile);
      checks.push(check('world-save', true, {
        file: loaded.file,
        worldId: loaded.worldId,
        tick: loaded.tick,
        schemaVersion: loaded.schemaVersion,
      }));
    } catch (error) {
      checks.push(check('world-save', false, { file: config.worldFile, error: error.message }));
      errors.push(`world save unreadable: ${error.message}`);
    }
  } else {
    try {
      const world = buildInitialOperationalWorld(config);
      checks.push(check('initial-template', true, {
        templateId: config.initialTemplateId,
        worldId: world.id,
        tick: world.tick,
      }));
    } catch (error) {
      checks.push(check('initial-template', false, { error: error.message }));
      errors.push(`initial template invalid: ${error.message}`);
    }
  }

  const tokenPermissions = inspectTokenFilePermissions(config.adminTokenFile);
  checks.push(check('admin-token-file', true, {
    file: config.adminTokenFile,
    exists: tokenPermissions.exists,
    mode: tokenPermissions.mode,
    secure: tokenPermissions.secure,
  }));
  if (tokenPermissions.secure === false) {
    warnings.push(`administrator token file is accessible by group/other: ${config.adminTokenFile}`);
  }
  if (config.requireAuth && !config.bootstrapAdmin && !tokenPermissions.exists) {
    warnings.push('authentication is enabled, admin bootstrap is disabled, and no token file exists');
  }

  const result = {
    ok: errors.length === 0,
    version: getVersionInfo({ buildSha: config.buildSha, buildDate: config.buildDate }),
    config: publicOperationalConfig(config),
    checks,
    warnings,
    errors,
  };
  return result;
}

function testDirectoryWritable(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `.phyrex-preflight-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(file, 'ok', { encoding: 'utf8', flag: 'wx' });
    if (fs.readFileSync(file, 'utf8') !== 'ok') throw new Error('write verification failed');
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function check(name, ok, details = {}) {
  return { name, ok: Boolean(ok), ...details };
}

function main() {
  try {
    const config = loadOperationalConfig({ argv: process.argv.slice(2) });
    if (config.help) {
      console.log(operationalUsage());
      return;
    }
    const result = runOperationalPreflight(config);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error.message,
      errors: error.errors || [],
      warnings: error.warnings || [],
    }, null, 2));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  runOperationalPreflight,
  testDirectoryWritable,
  check,
  main,
};
