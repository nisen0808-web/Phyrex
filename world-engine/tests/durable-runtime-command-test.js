'use strict';

const assert = require('assert');
const { createWorld } = require('../core/world-engine');
const { createPlayer } = require('../core/player-engine');
const { repairLoadedWorld } = require('../core/persistence-engine');
const { createDurableWorldRuntime, MAX_COMMANDS_PER_BATCH } = require('../runtime/durable-world-runtime');
const { detachedJson, digest } = require('../storage/postgres/codec');

function fail(code) { const error = new Error('private failure'); error.code = code; return error; }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function command(sequence, id, playerId = 'player-1', input = { type: 'wait' }) {
  return { sequence, id, playerId, input: detachedJson(input), inputDigest: digest(input), status: 'pending' };
}
function fixture(options = {}) {
  const world = createWorld({ id: 'command_runtime_world', seed: 'command-runtime' });
  createPlayer(world, { id: 'player-1', name: 'Player One' });
  repairLoadedWorld(world);
  const ledger = {
    world: detachedJson(world), revision: 1, metadata: detachedJson(options.metadata || {}),
    commands: [], saves: [], records: [], reads: 0, closes: 0,
  };
  const store = {
    provider: 'postgres',
    async loadWorld(id) {
      if (id !== world.id) return null;
      return { world: detachedJson(ledger.world), worldId: id, tick: ledger.world.tick,
        revision: ledger.revision, metadata: detachedJson(ledger.metadata) };
    },
    async listPendingCommands(id, query = {}) {
      assert.strictEqual(id, world.id); ledger.reads += 1;
      return ledger.commands.filter(item => item.status === 'pending').slice(0, query.limit || 100).map(detachedJson);
    },
    async saveWorld(candidate, saveOptions) {
      ledger.saves.push({ world: detachedJson(candidate), options: detachedJson(saveOptions) });
      const previous = ledger.records.find(item => item.id === saveOptions.requestId);
      if (previous) return { ...previous, idempotent: true };
      if (saveOptions.expectedRevision !== ledger.revision) throw fail('WORLD_DB_REVISION_CONFLICT');
      for (const result of saveOptions.commandResults || []) {
        const row = ledger.commands.find(item => item.sequence === result.sequence && item.id === result.id);
        if (!row || row.status !== 'pending' || row.playerId !== result.playerId || row.inputDigest !== result.inputDigest) {
          throw fail('WORLD_DB_COMMAND_CONFLICT');
        }
      }
      ledger.world = detachedJson(candidate); ledger.revision += 1; ledger.metadata = detachedJson(saveOptions.metadata);
      for (const result of saveOptions.commandResults || []) {
        const row = ledger.commands.find(item => item.sequence === result.sequence);
        row.status = 'applied'; row.result = detachedJson(result.result);
      }
      const receipt = { id: saveOptions.requestId, worldId: candidate.id, revision: ledger.revision, tick: candidate.tick };
      ledger.records.push(receipt); return receipt;
    },
    async close() { ledger.closes += 1; },
  };
  let simulations = 0;
  function advance(candidate, ticks) { simulations += 1; candidate.sawCommandsBeforeAdvance = candidate.commands?.stats?.submitted || 0; candidate.tick += ticks; }
  return { world, ledger, store, simulations: () => simulations, advance,
    runtimeOptions: { store, worldId: world.id, advance, simulationId: 'controlled-v1' } };
}

async function main() {
  let groups = 0;
  const pass = name => { groups += 1; console.log(`PASS ${name}`); };

  {
    const f = fixture(); f.ledger.commands.push(command(1, 'wait-1'));
    const runtime = await createDurableWorldRuntime(f.runtimeOptions);
    const result = await runtime.step();
    assert.strictEqual(result.commands, 1); assert.strictEqual(runtime.summary().commandsApplied, 1);
    assert.strictEqual(runtime.getWorld().sawCommandsBeforeAdvance, 1);
    assert.strictEqual(runtime.getWorld().commands.byId['wait-1'].status, 'completed');
    assert.strictEqual(f.ledger.commands[0].status, 'applied');
    assert.strictEqual(f.ledger.commands[0].result.status, 'completed');
    await runtime.close(); pass('pending command executes in isolated world before deterministic advancement and commits once');
  }

  {
    const f = fixture(); f.ledger.commands.push(command(1, 'missing-player', 'missing-player'));
    const runtime = await createDurableWorldRuntime(f.runtimeOptions); await runtime.step();
    const durable = f.ledger.commands[0];
    assert.strictEqual(durable.status, 'applied'); assert.strictEqual(durable.result.status, 'rejected');
    assert.strictEqual(durable.result.outcome.reason, 'missing_player');
    assert.strictEqual(runtime.getWorld().commands.byId['missing-player'].status, 'rejected');
    await runtime.close(); pass('deterministically rejected command is durably acknowledged instead of retrying forever');
  }

  {
    const f = fixture(); f.ledger.commands.push(command(1, 'retry-once'));
    const save = f.store.saveWorld; let first = true;
    f.store.saveWorld = async (...args) => { if (first) { first = false; throw fail('WORLD_DB_UNAVAILABLE'); } return save(...args); };
    const runtime = await createDurableWorldRuntime(f.runtimeOptions);
    await assert.rejects(runtime.step());
    assert.strictEqual(f.ledger.reads, 1); assert.strictEqual(f.simulations(), 1);
    const pendingRequest = runtime.summary().pending.requestId;
    await runtime.retry();
    assert.strictEqual(f.ledger.reads, 1); assert.strictEqual(f.simulations(), 1);
    assert.strictEqual(f.ledger.saves[0].options.requestId, pendingRequest);
    assert.strictEqual(runtime.getWorld().commands.stats.submitted, 1);
    await runtime.close(); pass('retry reuses frozen command results without re-reading or re-executing inbox commands');
  }

  {
    const f = fixture(); f.ledger.commands.push(command(1, 'read-retry'));
    const read = f.store.listPendingCommands; let first = true;
    f.store.listPendingCommands = async (...args) => { if (first) { first = false; f.ledger.reads += 1; throw fail('WORLD_DB_UNAVAILABLE'); } return read(...args); };
    const runtime = await createDurableWorldRuntime(f.runtimeOptions);
    await assert.rejects(runtime.step());
    assert.strictEqual(runtime.summary().prepareAttempts, 1);
    assert.strictEqual(runtime.summary().pending, null);
    assert.strictEqual(f.simulations(), 0);
    assert.strictEqual(runtime.getWorld().tick, 0);
    await runtime.retry();
    assert.strictEqual(f.ledger.reads, 2); assert.strictEqual(f.simulations(), 1);
    assert.strictEqual(runtime.getWorld().commands.byId['read-retry'].status, 'completed');
    await runtime.close(); pass('transient inbox read failure retries before candidate creation without simulating partial work');
  }

  {
    const f = fixture(); f.ledger.commands.push(command(1, 'first-batch'));
    const gate = deferred(), entered = deferred(), save = f.store.saveWorld;
    f.store.saveWorld = async (...args) => { entered.resolve(); await gate.promise; return save(...args); };
    const runtime = await createDurableWorldRuntime(f.runtimeOptions);
    const first = runtime.step(); await entered.promise;
    f.ledger.commands.push(command(2, 'second-batch'));
    gate.resolve(); await first;
    assert.strictEqual(runtime.getWorld().commands.byId['second-batch'], undefined);
    await runtime.step();
    assert.strictEqual(runtime.getWorld().commands.byId['second-batch'].status, 'completed');
    assert.strictEqual(f.ledger.reads, 2);
    await runtime.close(); pass('command arriving after candidate capture waits for the next committed batch');
  }

  {
    const legacyHash = digest({ version: 1, profile: 'controlled-v1', simulation: {} });
    const f = fixture({ metadata: { durableRuntime: { configHash: legacyHash } } });
    const runtime = await createDurableWorldRuntime(f.runtimeOptions); await runtime.step();
    assert.notStrictEqual(runtime.summary().configHash, legacyHash);
    await runtime.close();
    const resumed = await createDurableWorldRuntime(f.runtimeOptions); await resumed.close();
    await assert.rejects(createDurableWorldRuntime({ ...f.runtimeOptions, simulation: { changed: true } }),
      error => error.code === 'WORLD_RUNTIME_CONFIG_MISMATCH');
    pass('version-1 runtime config hash upgrades once while unrelated configuration changes remain blocked');
  }

  {
    const f = fixture(); f.ledger.commands.push(command(1, 'simulation-fails'));
    const runtime = await createDurableWorldRuntime({ ...f.runtimeOptions, advance: candidate => { candidate.tick += 1; throw new Error('boom'); } });
    await assert.rejects(runtime.step());
    assert.strictEqual(f.ledger.commands[0].status, 'pending'); assert.strictEqual(f.ledger.saves.length, 0);
    assert.strictEqual(runtime.summary().status, 'blocked');
    await runtime.close({ flush: false }); pass('simulation failure never acknowledges commands or writes a checkpoint');
  }

  {
    const f = fixture();
    for (let index = 1; index <= MAX_COMMANDS_PER_BATCH + 1; index += 1) f.ledger.commands.push(command(index, `bounded-${index}`));
    const runtime = await createDurableWorldRuntime(f.runtimeOptions);
    const first = await runtime.step(); assert.strictEqual(first.commands, MAX_COMMANDS_PER_BATCH);
    assert.strictEqual(f.ledger.commands.filter(item => item.status === 'pending').length, 1);
    const second = await runtime.step(); assert.strictEqual(second.commands, 1);
    assert.strictEqual(runtime.summary().commandsApplied, MAX_COMMANDS_PER_BATCH + 1);
    await runtime.close(); pass('command consumption is bounded per batch and preserves FIFO backlog for later revisions');
  }

  console.log(`durable runtime command contracts completed ${groups} groups: ${groups} passed, 0 failed`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
