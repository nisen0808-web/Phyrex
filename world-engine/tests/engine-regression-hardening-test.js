'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createWorld, registerLocation, registerEntity, enqueueAction, emitEvent } = require('../core/world-engine');
const { nextWorldId, reserveWorldSequence } = require('../core/world-id-engine');
const { ensureEcologyState } = require('../core/ecology-engine');
const { ensureSchedulerState } = require('../core/system-scheduler-engine');
const { repairWorldConsistency, auditWorldConsistency } = require('../core/world-consistency-engine');
const { createProcess, processProcessesTick, getProcessStats } = require('../core/process-engine');
const { createSettlement } = require('../core/city-engine');
const { processNaturalWorldTick } = require('../core/natural-world-engine');
const { createInformation, revealInformation, spreadInformation } = require('../core/information-engine');
const { createMemory } = require('../core/memory-engine');
const { createReligion } = require('../core/religion-engine');
const { createAction, createEvent } = require('../core/schema');
const { hashWorldState } = require('../core/state-integrity-engine');
const { scanSourceDirectory } = require('../core/source-purity-engine');

function testSharedPrefixIdsAndLegacyResume() {
  const world = createWorld({ id: 'ids', seed: 'ids' });
  const ids = ['relief', 'work', 'rations', 'security', 'tax', 'mobilize']
    .map(type => nextWorldId(world, 'gov_response', `governance.${type}`));
  assert.strictEqual(new Set(ids).size, 6);
  assert.strictEqual(ids[5], 'gov_response_0_6');
  const reloaded = JSON.parse(JSON.stringify(world));
  assert.strictEqual(nextWorldId(world, 'gov_response', 'new.type'), nextWorldId(reloaded, 'gov_response', 'new.type'));
  const legacy = { tick: 20, engineIds: { version: 1, counters: { old: 40, other: 12 } } };
  assert.strictEqual(nextWorldId(legacy, 'gov_response', 'fresh'), 'gov_response_k_15');
  assert.strictEqual(nextWorldId(legacy, 'gov_response', 'other'), 'gov_response_k_16');
  reserveWorldSequence(legacy, 'fresh', 100);
  assert.strictEqual(nextWorldId(legacy, 'gov_response', 'fresh'), 'gov_response_k_2t');
  assert.throws(() => reserveWorldSequence(legacy, 'broken', Infinity), /safe integers/);
  assert.throws(() => nextWorldId({ tick: NaN }, 'id'), /safe integers/);
  legacy.engineIds.prefixCounters.gov_response = Number.MAX_SAFE_INTEGER;
  assert.throws(() => nextWorldId(legacy, 'gov_response', 'fresh'), /safe integers/);
}

function testPartialStatesAndVersionGuards() {
  const world = createWorld({ id: 'partial' });
  const record = { locationId: 'origin', speciesId: 'human', population: 0, carryingCapacity: 0 };
  world.ecology = { populations: { byKey: { 'origin:human': record } } };
  const state = ensureEcologyState(world);
  assert.strictEqual(state.version, 1);
  assert.strictEqual(state.populations.byKey['origin:human'], record);
  assert.ok(Array.isArray(state.habitats.history));
  assert.ok(Array.isArray(state.disease.outbreaks));
  const performance = { samples: [1, 2] };
  world.kernel = { performance };
  assert.strictEqual(ensureSchedulerState(world).performance, performance);
  world.ecology.version = 99;
  world.kernel.version = 99;
  assert.throws(() => ensureEcologyState(world), /Unsupported ecology/);
  assert.throws(() => ensureSchedulerState(world), /Unsupported scheduler/);
}

function testFiniteRepairsAndIndexes() {
  const world = createWorld({ id: 'finite' });
  registerLocation(world, { id: 'origin', resources: { food: 100, water: 100 } });
  registerEntity(world, { id: 'plain', locationId: 'origin' });
  world.entities.plain.stats.health = Infinity;
  world.locations.origin.resources.food = Infinity;
  world.population = { indexes: { byAgeGroup: { wrong: ['plain'] }, byGeneration: {} } };
  world.ecology = { populations: { byKey: {
    'origin:human': { locationId: 'origin', speciesId: 'human', population: Infinity, carryingCapacity: NaN },
    'missing:wolf': { locationId: 'missing', speciesId: 'wolf', population: -1, carryingCapacity: -1 },
  }, byLocation: {} } };
  const report = repairWorldConsistency(world);
  assert.strictEqual(report.ok, true, JSON.stringify(report.issues));
  assert.strictEqual(world.locations.origin.resources.food, 0);
  assert.strictEqual(world.entities.plain.stats.health, 0);
  assert.strictEqual(world.ecology.populations.byKey['origin:human'].population, 0);
  assert.strictEqual(world.ecology.populations.byKey['missing:wolf'], undefined);
  assert.deepStrictEqual(world.ecology.populations.byLocation.origin, ['human']);
  assert.strictEqual(auditWorldConsistency(world).ok, true);
}

function testResourceCorruptionSurvivesUntilAudit() {
  const world = createWorld({ id: 'resource' });
  registerLocation(world, { id: 'origin', name: 'Old Forest', resources: { food: -10, water: Infinity } });
  processNaturalWorldTick(world, { disasterChance: 0 });
  assert.strictEqual(world.locations.origin.resources.food, -10);
  assert.strictEqual(world.locations.origin.resources.water, Infinity);
  assert.ok(auditWorldConsistency(world).issues.some(i => i.code === 'invalid_resource_value'));
  repairWorldConsistency(world);
  assert.strictEqual(world.locations.origin.resources.food, 0);
  assert.strictEqual(world.locations.origin.resources.water, 0);
}

function testLateProcessCreationAndRetention() {
  const world = createWorld({ id: 'retention' });
  processProcessesTick(world, { maxProcesses: 3, maxInactiveProcesses: 1 });
  for (let index = 0; index < 20; index += 1) {
    // These insertions simulate conflict/emergence after the process system.
    world.tick += 1;
    const process = createProcess(world, { type: 'conflict', ownerType: 'entity', ownerId: `e${index}` });
    assert.ok(world.processes.byId[process.id]);
    assert.ok(Object.keys(world.processes.byId).length <= 3);
    assert.ok(getProcessStats(world).total <= 3);
    for (const group of Object.values(world.processes.indexes)) {
      for (const ids of Object.values(group)) assert.ok(ids.every(id => world.processes.byId[id]));
    }
  }
  assert.strictEqual(Object.keys(world.processes.byId).length, 3);
  processProcessesTick(world, { maxProcesses: 0, maxInactiveProcesses: 0 });
  createProcess(world, { type: 'conflict' });
  assert.strictEqual(Object.keys(world.processes.byId).length, 0);
}

function testZeroSettlementValues() {
  const world = createWorld({ id: 'zero-city' });
  registerLocation(world, { id: 'origin' });
  const settlement = createSettlement(world, { locationId: 'origin', infrastructure: 0, security: 0, culture: 0 });
  assert.strictEqual(settlement.infrastructure, 0);
  assert.strictEqual(settlement.security, 0);
  assert.strictEqual(settlement.culture, 0);
}

function testDirectSimulationWithoutAmbientEntropy() {
  function build() {
    const world = createWorld({ id: 'direct', seed: 'fixed-seed' });
    registerLocation(world, { id: 'origin', resources: { food: 120, water: 100 } });
    for (const id of ['a', 'b']) registerEntity(world, { id, locationId: 'origin' });
    enqueueAction(world, { type: 'rest', actorId: 'a' });
    emitEvent(world, { type: 'test.event' });
    const info = createInformation(world, { type: 'report', summary: 'shared news', spreadability: 100, secrecy: 0, confidence: 100 });
    revealInformation(world, info.id, 'entity', 'a', { confidence: 100 });
    spreadInformation(world, { rumorMutationChance: 0 });
    createMemory(world, { ownerType: 'entity', ownerId: 'a', summary: 'news' });
    createReligion(world, { name: 'Rite', originLocationId: 'origin' });
    createProcess(world, { type: 'life_arc' });
    return world;
  }
  const savedRandom = Math.random;
  const savedNow = Date.now;
  try {
    Math.random = () => { throw new Error('Ambient random used by simulation'); };
    Date.now = () => { throw new Error('Ambient clock used by simulation'); };
    assert.strictEqual(hashWorldState(build()), hashWorldState(build()));
    assert.throws(() => createAction({ type: 'rest' }), /allocated by its world/);
    assert.throws(() => createEvent({ type: 'test' }), /allocated by its world/);
  } finally {
    Math.random = savedRandom;
    Date.now = savedNow;
  }
}

function testOperationalClockBoundary() {
  const root = path.resolve(__dirname, '..', 'core');
  const wallTimeOwners = new Set(['api-audit-engine.js', 'api-server-engine.js', 'auth-security-engine.js',
    'database-engine.js', 'database-viewer-summary-engine.js', 'persistence-engine.js',
    'runtime-loop-engine.js', 'world-template-api-engine.js']);
  for (const file of fs.readdirSync(root).filter(f => f.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    if (/\bwallClock(?:Now|Iso)\b/.test(source)) assert.ok(wallTimeOwners.has(file), `${file} cannot read operational time`);
    if (source.includes('../platform/runtime-clock') && !wallTimeOwners.has(file)) {
      assert.strictEqual(file, 'world-template-engine.js');
      assert.ok(source.includes('formatTimestamp(deterministicNow('));
    }
  }
  const report = scanSourceDirectory(root, { ignoreFiles: new Set(['source-purity-engine.js', 'source-purity-baseline-engine.js']) });
  assert.strictEqual(report.findings.length, 0, JSON.stringify(report.findings));
}

for (const test of [testSharedPrefixIdsAndLegacyResume, testPartialStatesAndVersionGuards,
  testFiniteRepairsAndIndexes, testResourceCorruptionSurvivesUntilAudit,
  testLateProcessCreationAndRetention, testZeroSettlementValues,
  testDirectSimulationWithoutAmbientEntropy, testOperationalClockBoundary]) {
  test();
  console.log(`PASS ${test.name}`);
}
console.log('engine regression hardening test passed (8 scenario groups)');
