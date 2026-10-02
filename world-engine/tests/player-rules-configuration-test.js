'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fixture } = require('./helpers/player-rules-fixture');
const { advanceWorld } = require('../core/world-engine');
const { configurePlayerActionRules, getPlayerActionRules } = require('../core/player-action-rules-engine');
const { playerStateView } = require('../core/durable-state-view-engine');
const { createDurableWorldRuntime } = require('../runtime/durable-world-runtime');
const { digest, detachedJson } = require('../storage/postgres/codec');
const { main: initialize } = require('../demo/engine-init-cli');
async function main() {
  const world = fixture(), original = digest(world);
  for (const input of [null, [], { version: 2 }, { workEnergy: 0 }, { workYield: '20' }, { workResource: '__proto__' }, { private: 'secret' }]) {
    assert.throws(() => configurePlayerActionRules(world, input), { code: 'WORLD_RUNTIME_INVALID_ACTION_RULES' });
    assert.strictEqual(digest(world), original);
  }
  configurePlayerActionRules(world, { workYield: 7, workEnergy: 3 });
  world.entities['hero-one'].playerActionState = { version: 1, lastTick: 0, experience: 8, secret: 'private-state' };
  const view = playerStateView(world, 1, 'one');
  assert.strictEqual(view.actionRules.workYield, 7); assert.strictEqual(view.character.actionState.experience, 8);
  assert.ok(!JSON.stringify(view).includes('private-state'));
  view.actionRules.workYield = 99; assert.strictEqual(getPlayerActionRules(world).workYield, 7);
  const ledger = { world: detachedJson(world), revision: 1, metadata: {} };
  const store = { provider: 'postgres', async loadWorld() { return { worldId: world.id, world: detachedJson(ledger.world), tick: ledger.world.tick, revision: ledger.revision, metadata: detachedJson(ledger.metadata) }; },
    async saveWorld(candidate, options) { ledger.world = detachedJson(candidate); ledger.metadata = detachedJson(options.metadata); ledger.revision++;
      return { id: options.requestId, worldId: world.id, revision: ledger.revision, tick: candidate.tick }; }, async close() {} };
  const options = { worldId: world.id, store, advance: (candidate, ticks) => advanceWorld(candidate, ticks), simulationId: 'rules-unit-v1' };
  const first = await createDurableWorldRuntime(options); await first.step(); await first.close();
  const next = await createDurableWorldRuntime(options); await next.close();
  configurePlayerActionRules(ledger.world, { workYield: 8, workEnergy: 3 });
  await assert.rejects(createDurableWorldRuntime({ ...options, upgradeCommandProfile: true }), { code: 'WORLD_RUNTIME_CONFIG_MISMATCH' });
  const old = digest({ version: 3, profile: 'rules-unit-v1', simulation: {}, commands: { profile: 'postgres-player-contract-v2', maxPerBatch: 100 } });
  ledger.metadata = { durableRuntime: { configHash: old } };
  await assert.rejects(createDurableWorldRuntime(options), { code: 'WORLD_RUNTIME_COMMAND_PROFILE_UPGRADE_REQUIRED' });
  const upgraded = await createDurableWorldRuntime({ ...options, upgradeCommandProfile: true }); await upgraded.step(); await upgraded.close();
  assert.strictEqual(ledger.metadata.durableRuntime.upgradedFrom, old);
  const tempRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'phyrex-player-rules-'));
  try {
    const rules = path.join(directory, 'rules.json'), output = path.join(directory, 'world.json');
    fs.writeFileSync(rules, JSON.stringify({ workYield: 7, workEnergy: 3 }));
    await initialize(['--output', output, '--population', '2', '--player-rules', rules]);
    const data = fs.readFileSync(output, 'utf8'); assert.ok(data.includes('"workYield":7')); assert.ok(data.includes('"workEnergy":3'));
    fs.writeFileSync(rules, '{"workYield":"bad"}');
    const invalid = path.join(directory, 'invalid-world.json');
    await assert.rejects(initialize(['--output', invalid, '--population', '2', '--player-rules', rules]));
    assert.strictEqual(fs.existsSync(invalid), false);
  } finally {
    assert.strictEqual(path.dirname(path.resolve(directory)), tempRoot);
    assert.ok(path.basename(directory).startsWith('phyrex-player-rules-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log('player rules configuration passed: strict construction, safe state projection, hash fencing, explicit upgrade and new-world CLI');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
