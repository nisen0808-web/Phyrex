'use strict';

const assert = require('assert');
const { buildDemoWorld, runDemoWorld } = require('../demo/run-demo');
const { createWorldSnapshot } = require('../core/snapshot-engine');

function main() {
  const world = buildDemoWorld();
  runDemoWorld(world, 20, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0, baseMortalityChance: 0 },
  });

  const snapshot = createWorldSnapshot(world, {
    topEntities: 5,
    topOrganizations: 5,
    topCities: 5,
    topCivilizations: 3,
    topQuests: 5,
    recentReports: 5,
  });

  assert.strictEqual(snapshot.schemaVersion, 1, 'snapshot schema version should exist');
  assert.strictEqual(snapshot.world.tick, 20, 'snapshot should preserve world tick');
  assert.ok(snapshot.population.alive >= 1, 'snapshot should include population');
  assert.ok(snapshot.players && typeof snapshot.players.total === 'number', 'snapshot should include players section');
  assert.ok(snapshot.commands && typeof snapshot.commands.total === 'number', 'snapshot should include commands section');
  assert.ok(snapshot.quests && typeof snapshot.quests.total === 'number', 'snapshot should include quests section');
  assert.ok(snapshot.tutorials && typeof snapshot.tutorials.total === 'number', 'snapshot should include tutorials section');
  assert.ok(Array.isArray(snapshot.cities), 'snapshot cities should be an array');
  assert.ok(Array.isArray(snapshot.organizations), 'snapshot organizations should be an array');
  assert.ok(Array.isArray(snapshot.civilizations), 'snapshot civilizations should be an array');
  assert.ok(snapshot.technology && typeof snapshot.technology.unlocked === 'number', 'snapshot should include technology');
  assert.ok(snapshot.infrastructure && typeof snapshot.infrastructure.total === 'number', 'snapshot should include infrastructure');
  assert.ok(snapshot.governance && typeof snapshot.governance.total === 'number', 'snapshot should include governance');
  assert.ok(snapshot.conflicts && typeof snapshot.conflicts.total === 'number', 'snapshot should include conflicts');
  assert.ok(snapshot.processes && typeof snapshot.processes.total === 'number', 'snapshot should include processes');
  assert.ok(snapshot.information.total <= snapshot.limits.information.limit, 'information should respect limit');
  assert.ok(snapshot.memories.total <= snapshot.limits.memories.limit, 'memories should respect limit');
  assert.ok(snapshot.quests.total <= snapshot.limits.quests.limit, 'quests should respect limit');
  assert.ok(snapshot.limits.worldMemory.current <= snapshot.limits.worldMemory.limit, 'world memory should respect limit');
  assert.ok(snapshot.limits.reports.current <= snapshot.limits.reports.limit, 'reports should respect limit');

  const json = JSON.stringify(snapshot);
  assert.ok(json.length > 100, 'snapshot should be serializable and non-empty');

  console.log('snapshot integration test passed');
}

main();
