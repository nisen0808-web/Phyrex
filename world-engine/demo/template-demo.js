'use strict';

const {
  createWorldTemplateRegistry,
  listWorldTemplates,
  createWorldFromTemplate,
} = require('../core/world-template-engine');
const { createWorldSnapshot } = require('../core/snapshot-engine');

function main() {
  const templateId = process.argv[2] || 'cultivation_frontier';
  const seedTicks = Number(process.argv[3] || 5);
  const registry = createWorldTemplateRegistry();
  const templates = listWorldTemplates(registry);
  const world = createWorldFromTemplate(registry, templateId, {
    worldId: `template-demo-${templateId}`,
    seedTicks,
  });
  const snapshot = createWorldSnapshot(world, {
    topEntities: 5,
    topOrganizations: 5,
    topCities: 5,
    recentReports: 5,
  });

  const output = {
    templates,
    selected: world.template,
    world: snapshot.world,
    population: snapshot.population,
    locations: Object.keys(world.locations || {}).length,
    organizations: snapshot.organizations,
    limits: snapshot.limits,
  };

  console.log(JSON.stringify(output, null, 2));
  return output;
}

if (require.main === module) main();

module.exports = { main };
