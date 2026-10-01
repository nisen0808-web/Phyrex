'use strict';
const assert = require('assert');
const { performance } = require('perf_hooks');
const { createEngineWorld } = require('../../demo/engine-v1-world');
const { ENGINE_V1_PROFILE } = require('../../runtime/engine-v1-profile');
const { advanceDeterministicBatch } = require('../../runtime/durable-world-runtime');
const { repairLoadedWorld } = require('../../core/persistence-engine');
const { auditWorldConsistency } = require('../../core/world-consistency-engine');
const { digest, detachedJson } = require('../../storage/postgres/codec');
const { calculateCausalityScore } = require('../../core/narrative-score-engine');

const CASES = Object.freeze({
  small: { population: 4, ticks: 1000, seed: 'scale-small-v1' },
  medium: { population: 12, ticks: 600, seed: 'scale-medium-v1' },
  large: { population: 32, ticks: 300, seed: 'scale-large-v1' },
});
async function main(name = process.argv[2]) {
  if (!Object.hasOwn(CASES, name)) throw new Error('Choose the small, medium or large scale gate');
  const config = CASES[name];
  // Accelerated lifetime exercises several generations in a bounded CI run.
  const world = createEngineWorld({ ...config, simulation: { population: { ...ENGINE_V1_PROFILE.population, ticksPerYear: 8, baseBirthChance: 0.01 } } });
  const started = performance.now();
  let restored = null, checkpoints = 0, peakBytes = 0, peakProcesses = 0, peakProcessPressure = 0;
  const samples = [];
  for (let tick = 0; tick < config.ticks; tick += 10) {
    const stepStarted = performance.now();
    advanceDeterministicBatch(world, 10);
    if (restored) {
      advanceDeterministicBatch(restored, 10); repairLoadedWorld(world); repairLoadedWorld(restored);
      assert.strictEqual(digest(restored), digest(world), `${name}: restored continuation differs at ${world.tick}`);
      restored = null; checkpoints++;
    }
    if (world.tick % 100 === 90) { repairLoadedWorld(world); restored = repairLoadedWorld(detachedJson(world)); }
    const bytes = Buffer.byteLength(JSON.stringify(world));
    peakBytes = Math.max(peakBytes, bytes);
    peakProcesses = Math.max(peakProcesses, Object.keys(world.processes.byId).length);
    peakProcessPressure = Math.max(peakProcessPressure, world.processes.capacity.overLimit);
    if (bytes >= 32 * 1024 * 1024) console.error(`CAPACITY_BREAKDOWN ${JSON.stringify(Object.entries(world).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))]).sort((a, b) => b[1] - a[1]).slice(0, 10))}`);
    assert.ok(bytes < 32 * 1024 * 1024, `${name}: default checkpoint size exceeded`);
    assert.ok(world.history.globalTimeline.length <= 1000);
    for (const entity of Object.values(world.entities)) {
      if (entity.goalRetention) assert.ok(entity.goalRetention.retainedTerminal <= Math.max(50, entity.goalRetention.protectedTerminal));
      if (entity.goalMemory) assert.ok(entity.goalMemory.length <= world.memory.length);
    }
    assert.ok(world.causality.length <= 500 + world.causalityArchive.overLimit);
    assert.strictEqual(world.processes.capacity.overLimit, Math.max(0, Object.keys(world.processes.byId).length - 200));
    assert.ok(Object.keys(world.processes.byId).length <= Math.max(200, world.processes.capacity.protected));
    assert.deepStrictEqual(auditWorldConsistency(world).issues, []);
    detachedJson(world); // Reject NaN/Infinity rather than JSON silently turning them into null.
    for (const entity of Object.values(world.entities)) assert.ok(Number.isFinite(calculateCausalityScore(world, entity.id)));
    if (world.tick % 100 === 0) {
      const sample = { tick: world.tick, bytes, births: world.population.births, deaths: world.population.deaths,
        alive: Object.values(world.entities).filter(e => e.status === 'alive').length,
        processes: Object.keys(world.processes.byId).length, processPressure: world.processes.capacity.overLimit,
        batchMs: Math.round(performance.now() - stepStarted) };
      samples.push(sample); console.log(`SAMPLE ${JSON.stringify(sample)}`);
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(world.population.births > 0, 'must exercise actual births');
  assert.ok(world.population.deaths > 0, 'must exercise actual deaths');
  assert.ok(Object.values(world.entities).some(e => e.demographics.generation > 1), 'must exercise descendants');
  assert.ok(world.causalityArchive.removedRecords > 0, 'must actually compact causality');
  assert.ok(checkpoints >= 3, 'must verify multiple independent recovery points');
  const result = { case: name, ...config, checkpoints, peakBytes, peakProcesses, peakProcessPressure,
    totalEntities: Object.keys(world.entities).length, births: world.population.births, deaths: world.population.deaths,
    maxGeneration: Math.max(...Object.values(world.entities).map(e => e.demographics.generation)),
    elapsedMs: Math.round(performance.now() - started), removedCauses: world.causalityArchive.removedRecords,
    finalDigest: digest(world), samples };
  console.log(`SCALE_RESULT ${JSON.stringify(result)}`);
  console.log(`engine scale ${name} completed: lifecycle, finite state, capacity and ${checkpoints} recoveries passed`);
  return result;
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { CASES, main };
