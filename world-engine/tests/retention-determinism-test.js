'use strict';
const assert = require('assert');
const { createEnduranceWorld } = require('./fixtures/engine-endurance-world');
const { createOpportunity } = require('../core/opportunity-engine');
const { createConflict } = require('../core/conflict-engine');
const { advanceDeterministicBatch } = require('../runtime/durable-world-runtime');
const { repairLoadedWorld } = require('../core/persistence-engine');
const { digest } = require('../storage/postgres/codec');

function behavior(world) {
  // Runtime reports/snapshots describe retained history and intentionally differ.
  const keys = ['entities', 'relationships', 'population', 'families', 'organizations',
    'economy', 'cities', 'governance', 'random', 'engineIds', 'goals', 'processes',
    'culture', 'religion', 'civilization', 'technology', 'infrastructure', 'emergence',
    'natural', 'ecology', 'information', 'memories', 'memory', 'infoFlow', 'cultureBeliefFlow'];
  const value = Object.fromEntries(keys.filter(key => world[key] !== undefined).map(key => [key, world[key]]));
  value.opportunityStats = world.opportunities.stats;
  value.conflictStats = world.conflicts.stats;
  value.liveOpportunities = Object.values(world.opportunities.byId).filter(record => record.status === 'active');
  value.liveConflicts = Object.values(world.conflicts.byId).filter(record => record.status !== 'resolved');
  return digest(value);
}

for (const seed of ['retention-alpha', 'retention-beta', 'retention-gamma']) {
  const retained = createEnduranceWorld(seed);
  retained.simulation.options.opportunity = { maxTerminalOpportunities: 3 };
  retained.simulation.options.conflict = { maxResolvedConflicts: 3 };
  for (let n = 0; n < 12; n++) {
    createOpportunity(retained, { status: 'expired', expiresAt: 0 });
    createConflict(retained, { status: 'resolved' });
  }
  for (const process of Object.values(retained.processes.byId)) process.status = 'resolved';
  const full = JSON.parse(JSON.stringify(retained));
  full.simulation.options.opportunity = {};
  full.simulation.options.conflict = {};
  let restored;
  for (let batch = 0; batch < 4; batch++) {
    advanceDeterministicBatch(full, 20);
    advanceDeterministicBatch(retained, 20);
    assert.strictEqual(behavior(retained), behavior(full), `${seed}: pruning changed ongoing world behavior`);
    if (restored) {
      advanceDeterministicBatch(restored, 20);
      assert.strictEqual(digest(restored), digest(retained), `${seed}: restored retention diverged`);
    }
    if (batch === 1) restored = repairLoadedWorld(JSON.parse(JSON.stringify(retained)));
  }
  assert.ok(retained.opportunities.retention.removed >= 9);
  assert.ok(retained.conflicts.retention.removed >= 9);
  console.log(`PASS retention seed ${seed}: 80 ticks, unchanged ongoing behavior, full-state restore equality`);
}
console.log('retention determinism passed: 3 seeds, lifecycle behavior and checkpoint continuation');
