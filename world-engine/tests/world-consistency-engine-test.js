'use strict';

const assert = require('assert');
const { createWorld, registerLocation, registerEntity } = require('../core/world-engine');
const {
  auditWorldConsistency,
  repairWorldConsistency,
  runWorldConsistencyCheck,
  getWorldConsistencySummary,
} = require('../core/world-consistency-engine');

function main() {
  testAuditAndRepair();
  testDryRunRecordsReport();
  console.log('world consistency engine test passed');
}

function testAuditAndRepair() {
  const world = buildBrokenWorld();
  const audit = auditWorldConsistency(world);
  assert.strictEqual(audit.ok, false);
  assert.ok(audit.issueCount >= 8, `expected several issues, got ${audit.issueCount}`);
  assert.ok(audit.issues.some(issue => issue.code === 'missing_entity_location'));
  assert.ok(audit.issues.some(issue => issue.code === 'invalid_resource_value'));
  assert.ok(audit.issues.some(issue => issue.code === 'stale_population_age_index'));
  assert.strictEqual(world.entities.alice.locationId, 'missing');

  const repaired = repairWorldConsistency(world);
  assert.ok(repaired.repairedCount >= 8, `expected repairs, got ${repaired.repairedCount}`);
  assert.strictEqual(world.entities.alice.locationId, 'origin');
  assert.strictEqual(world.locations.origin.id, 'origin');
  assert.strictEqual(world.locations.origin.resources.food, 0);
  assert.deepStrictEqual(world.locations.origin.neighbors, []);
  assert.ok(!world.natural.weather.byLocation.missing);
  assert.ok(!world.ecology.populations.byKey['missing:human']);
  assert.deepStrictEqual(world.ecology.populations.byLocation.origin, ['human']);
  assert.ok(world.memory.length <= 1000);
  assert.ok(world.consistency.lastReport);
  assert.strictEqual(getWorldConsistencySummary(world).stats.checks, 1);

  const finalAudit = auditWorldConsistency(world);
  assert.strictEqual(finalAudit.ok, true, JSON.stringify(finalAudit.issues, null, 2));
}

function testDryRunRecordsReport() {
  const world = buildBrokenWorld('dry-run-world');
  const report = runWorldConsistencyCheck(world, { repair: false });
  assert.strictEqual(report.dryRun, true);
  assert.strictEqual(world.entities.alice.locationId, 'missing');
  const summary = getWorldConsistencySummary(world);
  assert.strictEqual(summary.stats.checks, 1);
  assert.strictEqual(summary.lastReport.ok, false);
}

function buildBrokenWorld(id = 'broken-world') {
  const world = createWorld({ id, seed: 'consistency-seed' });
  registerLocation(world, {
    id: 'origin',
    name: 'Origin',
    resources: { food: 100, water: 100 },
  });
  world.locations.origin.id = 'wrong_origin';
  world.locations.origin.resources.food = -10;
  world.locations.origin.neighbors = ['missing'];
  const entity = registerEntity(world, {
    id: 'alice',
    name: 'Alice',
    locationId: 'origin',
    stats: { health: 100, energy: 100 },
    demographics: { ageGroup: 'adult', generation: 1 },
  });
  entity.locationId = 'missing';
  delete entity.status;
  entity.stats.energy = Number.NaN;
  world.population = {
    indexes: { byAgeGroup: { child: ['nobody'] }, byGeneration: {} },
    births: 0,
    deaths: 0,
  };
  world.natural = {
    weather: { byLocation: { missing: { type: 'storm', severity: 1 } }, history: Array.from({ length: 130 }, (_, tick) => ({ tick })) },
    disasters: { active: { d1: { locationId: 'missing', severity: 1 } }, history: Array.from({ length: 110 }, (_, tick) => ({ tick })) },
  };
  world.ecology = {
    habitats: { byLocation: { missing: { suitability: {} } } },
    populations: {
      byKey: {
        'missing:human': { locationId: 'missing', speciesId: 'human', population: 10, carryingCapacity: 10 },
        'origin:human': { locationId: 'origin', speciesId: 'human', population: -5, carryingCapacity: -1 },
      },
      byLocation: { wrong: ['human'] },
    },
  };
  world.memory = Array.from({ length: 1010 }, (_, tick) => ({ tick }));
  world.simulation = { reports: Array.from({ length: 210 }, (_, tick) => ({ tick })) };
  world.kernel = { history: Array.from({ length: 120 }, (_, tick) => ({ tick })), contracts: { recentViolations: Array.from({ length: 120 }, (_, tick) => ({ tick })) } };
  return world;
}

main();
