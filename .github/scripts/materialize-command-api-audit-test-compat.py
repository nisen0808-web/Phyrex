from pathlib import Path

# Controlled command API store gains the new audit method required by the server contract.
p = Path('world-engine/tests/durable-command-api-test.js')
s = p.read_text()
old = "const state = { world: clone(world), revision: 7, commands: new Map(), nextSequence: 1, closes: 0, raceRevoke: false };"
new = "const state = { world: clone(world), revision: 7, commands: new Map(), audits: [], nextSequence: 1, closes: 0, raceRevoke: false };"
if s.count(old) != 1: raise SystemExit('api state anchor mismatch')
s = s.replace(old, new)
old = """    async getCommand(worldId, commandId, options = {}) {
      if (worldId !== state.world.id) return null;
      if (options.expectedWorldRevision !== state.revision) throw dbError('REVISION_CONFLICT');
      const row = state.commands.get(commandId);
      return row ? clone(row) : null;
    },
    async close() { state.closes += 1; },"""
new = """    async getCommand(worldId, commandId, options = {}) {
      if (worldId !== state.world.id) return null;
      if (options.expectedWorldRevision !== state.revision) throw dbError('REVISION_CONFLICT');
      const row = state.commands.get(commandId);
      return row ? clone(row) : null;
    },
    async appendCommandApiAudit(input) {
      state.audits.push(clone(input));
      return { sequence: state.audits.length, ...clone(input) };
    },
    async close() { state.closes += 1; },"""
if s.count(old) != 1: raise SystemExit('api store anchor mismatch')
p.write_text(s.replace(old, new))

# Rate-limit fixture also implements the audit method; 401/429 tests can then assert no writes.
p = Path('world-engine/tests/durable-command-api-rate-limit-test.js')
s = p.read_text()
old = "const state = { world: clone(world), revision: 1, commands: new Map(), sequence: 1 };"
new = "const state = { world: clone(world), revision: 1, commands: new Map(), audits: [], sequence: 1 };"
if s.count(old) != 1: raise SystemExit('rate state anchor mismatch')
s = s.replace(old, new)
old = """    async getCommand(worldId, commandId, options = {}) {
      assert.strictEqual(options.expectedWorldRevision, state.revision);
      const row = state.commands.get(commandId); return worldId === state.world.id && row ? clone(row) : null;
    },
    async close() {},"""
new = """    async getCommand(worldId, commandId, options = {}) {
      assert.strictEqual(options.expectedWorldRevision, state.revision);
      const row = state.commands.get(commandId); return worldId === state.world.id && row ? clone(row) : null;
    },
    async appendCommandApiAudit(input) {
      state.audits.push(clone(input));
      return { sequence: state.audits.length, ...clone(input) };
    },
    async close() {},"""
if s.count(old) != 1: raise SystemExit('rate store anchor mismatch')
p.write_text(s.replace(old, new))

# The inbox suite validates the current registry instead of assuming Migration 2 is the latest forever.
p = Path('world-engine/tests/integration/postgres-command-inbox.js')
s = p.read_text()
old = "const { createPostgresDatabaseStore } = require('../../storage/postgres/store');"
new = "const { createPostgresDatabaseStore } = require('../../storage/postgres/store');\nconst { MIGRATIONS } = require('../../storage/postgres/migrations');"
if s.count(old) != 1: raise SystemExit('migration import anchor mismatch')
s = s.replace(old, new)
old = """    assert.strictEqual(migrated.version, 2);
    assert.strictEqual(migrated.applied, 2);"""
new = """    assert.strictEqual(migrated.version, MIGRATIONS.length);
    assert.strictEqual(migrated.applied, MIGRATIONS.length);"""
if s.count(old) != 1: raise SystemExit('migration assertion anchor mismatch')
p.write_text(s.replace(old, new))
