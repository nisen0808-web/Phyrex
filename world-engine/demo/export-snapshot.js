'use strict';

const fs = require('fs');
const path = require('path');
const { buildDemoWorld, runDemoWorld } = require('./run-demo');
const { createWorldSnapshot } = require('../core/snapshot-engine');

const ticks = Number(process.argv[2] || 100);
const outPath = process.argv[3] || path.join(__dirname, '..', 'output', 'demo-snapshot.json');

function main() {
  const world = buildDemoWorld();
  runDemoWorld(world, ticks);
  const snapshot = createWorldSnapshot(world, {
    topEntities: 15,
    topOrganizations: 10,
    topCities: 10,
    topCivilizations: 5,
    recentReports: 30,
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`Snapshot exported: ${outPath}`);
  console.log(`World tick: ${snapshot.world.tick}`);
  console.log(`Population alive: ${snapshot.population.alive}`);
  console.log(`Cities: ${snapshot.cities.length}`);
  console.log(`Information items: ${snapshot.limits.information.current}/${snapshot.limits.information.limit}`);
  console.log(`Structured memories: ${snapshot.limits.memories.current}/${snapshot.limits.memories.limit}`);
}

if (require.main === module) main();
