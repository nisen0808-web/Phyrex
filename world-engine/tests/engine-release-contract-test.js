'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const engine = require('..');
const { gatesFor, verify } = require('../demo/engine-verify-cli');
async function main() {
  assert.strictEqual(engine.version, '1.0.1'); assert.ok(Object.isFrozen(engine));
  const world = engine.createSampleWorld({ population: 2, commerce: 'starter' });
  assert.ok(world.shops.byId.shop_village_general);
  engine.createPlayerCharacter(world, 'observer', { locationId: 'village' });
  const purchase = engine.submitPlayerIntent(world, 'observer', { type: 'buy_item', shopId: 'shop_village_general', definitionId: 'wooden_sword' }).command;
  engine.advanceDeterministicBatch(world, 1); assert.strictEqual(engine.getPlayerCommandResult(world, 'observer', purchase.id).status, 'completed');
  assert.strictEqual(engine.getPlayerCommandResult(world, 'someone-else', purchase.id), null);
  const view = engine.playerStateView(world, 1, 'observer'); assert.ok(view.inventory.items.length);
  assert.strictEqual(engine.submitPlayerIntent(world, 'observer', { type: 'work', amount: 100 }).command.status, 'rejected');
  const custom = engine.createWorld({ id: 'custom' });
  engine.registerLocation(custom, { id: 'a' }); engine.registerLocation(custom, { id: 'b' }); engine.connectLocations(custom, 'a', 'b');
  engine.registerEntity(custom, { id: 'npc', locationId: 'a' }); assert.ok(custom.locations.a.neighbors.includes('b'));
  const tempRoot = path.resolve(os.tmpdir()), directory = fs.mkdtempSync(path.join(tempRoot, 'phyrex-release-'));
  try {
    const output = path.join(directory, 'world.json');
    const init = spawnSync(process.execPath, [path.join(__dirname, '../demo/engine-init-cli.js'), '--output', output, '--population', '2', '--commerce', 'starter'], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(init.status, 0, init.stderr); assert.ok(JSON.parse(fs.readFileSync(output, 'utf8')).world.shops.byId.shop_village_general);
    const invalid = path.join(directory, 'invalid.json');
    const bad = spawnSync(process.execPath, [path.join(__dirname, '../demo/engine-init-cli.js'), '--output', invalid, '--commerce', 'invalid'], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(bad.status, 1); assert.ok(!fs.existsSync(invalid));
  } finally {
    assert.strictEqual(path.dirname(path.resolve(directory)), tempRoot); assert.ok(path.basename(directory).startsWith('phyrex-release-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
  const scripts = require('../package.json').scripts;
  for (const g of gatesFor('all')) assert.ok(fs.existsSync(path.join(__dirname, '..', g.script)), g.script);
  const sqlFiles = new Set(gatesFor('postgres').map(g => `node ${g.script}`));
  assert.deepStrictEqual(sqlFiles, new Set(Object.entries(scripts).filter(([k]) => /^test:postgres($|:)/.test(k) && k !== 'test:postgres:endurance').map(([, v]) => v)));
  const gates = gatesFor('stress');
  assert.strictEqual((await verify(gates, async () => ({ exitCode: 1, stdout: gates[0].marker }))).ok, false);
  assert.strictEqual((await verify(gates, async () => ({ exitCode: 0, stdout: 'echo ' + gates[0].marker }))).ok, false);
  assert.strictEqual((await verify(gates, async () => ({ exitCode: 0, stdout: gates[0].marker + '\n' }))).ok, true);
  let calls = 0; await verify(gatesFor('all'), async () => { calls++; return { exitCode: 0, stdout: '' }; }); assert.strictEqual(calls, 1);
  const cli = path.join(__dirname, '../demo/engine-verify-cli.js');
  const missingDb = spawnSync(process.execPath, [cli, '--suite', 'postgres'], { env: { ...process.env, WORLD_ENGINE_TEST_DATABASE_URL: '' }, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(missingDb.status, 1); assert.ok(missingDb.stderr.includes('ENGINE_VERIFICATION_FAILED'));
  console.log('engine release contract passed: public SDK, starter commerce, complete gate catalog and false-green prevention');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
