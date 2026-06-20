'use strict';

const { createWorld, registerLocation, connectLocations, registerEntity } = require('./world-engine');
const { assignSpecies } = require('./species-engine');
const { createOrganization, addOrganizationMember } = require('./organization-engine');
const { initializeSimulation, runSimulationTicks } = require('./simulation-engine');

const DEFAULT_TEMPLATE_SIMULATION = {
  autoNovel: false,
  autoNarrative: false,
  population: { baseBirthChance: 0, baseMortalityChance: 0 },
  information: { maxInformationItems: 1000, maxKnownItemsPerOwner: 120 },
  memory: { maxGlobalMemories: 3000, maxMemoriesPerOwner: 50 },
  process: { maxProcesses: 500, maxInactiveProcesses: 150, staleAfterTicks: 120 },
};

function createWorldTemplateRegistry(options = {}) {
  const registry = { byId: {}, order: [] };
  if (options.includeBuiltIns !== false) {
    for (const template of builtInWorldTemplates()) registerWorldTemplate(registry, template);
  }
  for (const template of options.templates || []) registerWorldTemplate(registry, template);
  return registry;
}

function registerWorldTemplate(registry, input, options = {}) {
  if (!registry?.byId || !Array.isArray(registry.order)) throw new Error('Invalid world template registry');
  if (!input?.id) throw new Error('World template requires id');
  if (!input?.name) throw new Error('World template requires name');
  if (!input?.definition) throw new Error('World template requires definition');
  if (registry.byId[input.id] && !options.replace) throw new Error(`World template already exists: ${input.id}`);

  const template = {
    id: input.id,
    name: input.name,
    description: input.description || input.name,
    version: Number(input.version || 1),
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    seedTicks: Math.max(0, Number(input.seedTicks || 0)),
    simulation: deepClone(input.simulation || {}),
    definition: deepClone(input.definition),
  };

  registry.byId[template.id] = template;
  if (!registry.order.includes(template.id)) registry.order.push(template.id);
  return template;
}

function getWorldTemplate(registry, templateId) {
  return registry?.byId?.[templateId] || null;
}

function listWorldTemplates(registry) {
  return (registry?.order || []).map(id => registry.byId[id]).filter(Boolean).map(summarizeWorldTemplate);
}

function summarizeWorldTemplate(template) {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    version: template.version,
    tags: [...(template.tags || [])],
    seedTicks: template.seedTicks,
    locations: (template.definition?.locations || []).length,
    entities: (template.definition?.entities || []).length,
    organizations: (template.definition?.organizations || []).length,
  };
}

function createWorldFromTemplate(registry, templateId, options = {}) {
  const template = getWorldTemplate(registry, templateId);
  if (!template) throw new Error(`Missing world template ${templateId}`);

  const world = buildWorldFromDefinition(template.definition, {
    worldId: options.worldId || template.definition.world?.id || template.id,
    seed: options.seed ?? template.definition.world?.seed ?? 1,
  });

  world.template = {
    id: template.id,
    name: template.name,
    version: template.version,
    createdAt: new Date().toISOString(),
  };

  const initialize = options.initialize !== false;
  const seedTicks = Math.max(0, Number(options.seedTicks ?? template.seedTicks ?? 0));
  if (initialize) {
    const simulation = mergeOptions(
      DEFAULT_TEMPLATE_SIMULATION,
      mergeOptions(template.simulation || {}, options.simulation || {}),
    );
    initializeSimulation(world, simulation);
    if (seedTicks > 0) runSimulationTicks(world, seedTicks, simulation);
  }

  return world;
}

function resetWorldFromTemplate(currentWorld, registry, templateId, options = {}) {
  const next = createWorldFromTemplate(registry, templateId, options);
  if (options.preserveAccounts !== false && currentWorld?.accounts) {
    next.accounts = deepClone(currentWorld.accounts);
    next.accounts.byPlayer = {};
    for (const account of Object.values(next.accounts.byId || {})) account.playerIds = [];
  }
  if (options.preserveAudit !== false && currentWorld?.apiAudit) {
    next.apiAudit = deepClone(currentWorld.apiAudit);
  }
  next.template.resetFromWorldId = currentWorld?.id || null;
  next.template.resetAtTick = currentWorld?.tick ?? null;
  return next;
}

function buildWorldFromDefinition(definition = {}, options = {}) {
  const worldOptions = {
    id: options.worldId || definition.world?.id || 'world',
    seed: options.seed ?? definition.world?.seed ?? 1,
  };
  if (definition.world?.calendar) worldOptions.calendar = deepClone(definition.world.calendar);
  const world = createWorld(worldOptions);

  for (const location of definition.locations || []) registerLocation(world, deepClone(location));
  for (const connection of definition.connections || []) {
    const [a, b] = Array.isArray(connection) ? connection : [connection.a, connection.b];
    connectLocations(world, a, b);
  }

  for (const input of definition.entities || []) {
    const entity = registerEntity(world, deepClone(input));
    if (input.species) assignSpecies(world, entity.id, input.species);
  }

  const organizations = {};
  for (const input of definition.organizations || []) {
    const organization = createOrganization(world, deepClone(input));
    organizations[input.key || input.id || organization.id] = organization;
    for (const memberId of input.members || []) {
      if (memberId === organization.leaderId) continue;
      if (!world.entities?.[memberId]) continue;
      addOrganizationMember(world, organization.id, memberId, {
        role: input.roles?.[memberId] || 'member',
        createContract: false,
      });
    }
  }

  for (const relation of definition.organizationRelations || []) {
    const from = organizations[relation.from] || world.organizations?.byId?.[relation.from];
    const to = organizations[relation.to] || world.organizations?.byId?.[relation.to];
    if (!from || !to) continue;
    if (relation.type === 'rival') from.rivals[to.id] = Number(relation.value || 50);
    else if (relation.type === 'ally') from.allies[to.id] = Number(relation.value || 50);
  }

  world.resources = { ...(world.resources || {}), ...(deepClone(definition.resources || {})) };
  return world;
}

function builtInWorldTemplates() {
  return [
    {
      id: 'empty_sandbox',
      name: 'Empty Sandbox',
      description: 'A minimal blank world with one neutral origin location.',
      tags: ['sandbox', 'minimal'],
      seedTicks: 0,
      definition: {
        world: { id: 'empty-sandbox', seed: 1 },
        locations: [
          { id: 'origin', name: 'Origin', type: 'sanctuary', resources: { food: 100, wood: 100, stone: 100 }, danger: 0 },
        ],
        connections: [],
        entities: [],
        organizations: [],
      },
    },
    {
      id: 'cultivation_frontier',
      name: 'Cultivation Frontier',
      description: 'A compact cultivation frontier with sects, mines, forests and a river market.',
      tags: ['cultivation', 'frontier', 'playable'],
      seedTicks: 8,
      definition: cultivationFrontierDefinition(),
    },
    {
      id: 'merchant_crossroads',
      name: 'Merchant Crossroads',
      description: 'A trade-focused world centered on a port, caravan road and dangerous highlands.',
      tags: ['trade', 'city', 'playable'],
      seedTicks: 6,
      definition: merchantCrossroadsDefinition(),
    },
  ];
}

function cultivationFrontierDefinition() {
  const locations = [
    { id: 'qingyun_city', name: 'Qingyun City', type: 'city', resources: { food: 2500, wood: 1200, stone: 900, knowledge: 400 }, danger: 2 },
    { id: 'mist_forest', name: 'Mist Forest', type: 'wilds', resources: { food: 1400, wood: 2600, herbs: 900 }, danger: 18 },
    { id: 'black_iron_mine', name: 'Black Iron Mine', type: 'mine', resources: { stone: 1800, metal: 2200, fuel: 700 }, danger: 14 },
    { id: 'river_market', name: 'River Market', type: 'market', resources: { food: 1800, currency: 900, knowledge: 250 }, danger: 5 },
  ];
  const entities = makePopulation('frontier_cultivator', 18, locations.map(location => location.id), {
    currencyBase: 120,
    powerBase: 10,
  });
  return {
    world: { id: 'cultivation-frontier', seed: 11 },
    locations,
    connections: [
      ['qingyun_city', 'mist_forest'],
      ['qingyun_city', 'black_iron_mine'],
      ['qingyun_city', 'river_market'],
      ['river_market', 'mist_forest'],
    ],
    entities,
    organizations: [
      {
        key: 'qingyun_sect',
        type: 'sect',
        name: 'Qingyun Sect',
        leaderId: 'frontier_cultivator_0',
        homeLocationId: 'qingyun_city',
        currency: 5000,
        members: ids('frontier_cultivator', 0, 8),
      },
      {
        key: 'iron_guild',
        type: 'guild',
        name: 'Black Iron Guild',
        leaderId: 'frontier_cultivator_9',
        homeLocationId: 'black_iron_mine',
        currency: 3500,
        members: ids('frontier_cultivator', 9, 17),
      },
    ],
    organizationRelations: [
      { from: 'qingyun_sect', to: 'iron_guild', type: 'rival', value: 55 },
      { from: 'iron_guild', to: 'qingyun_sect', type: 'rival', value: 45 },
    ],
  };
}

function merchantCrossroadsDefinition() {
  const locations = [
    { id: 'jade_harbor', name: 'Jade Harbor', type: 'port', resources: { food: 2200, currency: 1600, wood: 700 }, danger: 4 },
    { id: 'crossroads_market', name: 'Crossroads Market', type: 'market', resources: { food: 1800, currency: 2200, knowledge: 350 }, danger: 3 },
    { id: 'red_cliff_road', name: 'Red Cliff Road', type: 'road', resources: { stone: 900, herbs: 500 }, danger: 22 },
    { id: 'wind_highlands', name: 'Wind Highlands', type: 'wilds', resources: { food: 800, herbs: 1000, metal: 500 }, danger: 28 },
  ];
  const entities = makePopulation('crossroads_traveler', 14, locations.map(location => location.id), {
    currencyBase: 180,
    powerBase: 8,
  });
  return {
    world: { id: 'merchant-crossroads', seed: 23 },
    locations,
    connections: [
      ['jade_harbor', 'crossroads_market'],
      ['crossroads_market', 'red_cliff_road'],
      ['red_cliff_road', 'wind_highlands'],
    ],
    entities,
    organizations: [
      {
        key: 'caravan_union',
        type: 'guild',
        name: 'Caravan Union',
        leaderId: 'crossroads_traveler_0',
        homeLocationId: 'crossroads_market',
        currency: 6000,
        members: ids('crossroads_traveler', 0, 6),
      },
      {
        key: 'harbor_watch',
        type: 'guard',
        name: 'Jade Harbor Watch',
        leaderId: 'crossroads_traveler_7',
        homeLocationId: 'jade_harbor',
        currency: 3200,
        members: ids('crossroads_traveler', 7, 13),
      },
    ],
    organizationRelations: [
      { from: 'caravan_union', to: 'harbor_watch', type: 'ally', value: 65 },
      { from: 'harbor_watch', to: 'caravan_union', type: 'ally', value: 60 },
    ],
  };
}

function makePopulation(prefix, count, locationIds, options = {}) {
  const out = [];
  for (let index = 0; index < count; index += 1) {
    out.push({
      id: `${prefix}_${index}`,
      name: `${titleCase(prefix)} ${index}`,
      species: 'human',
      locationId: locationIds[index % locationIds.length],
      traits: { ambition: 30 + (index % 55), social: 25 + (index % 45) },
      stats: {
        health: 100,
        maxHealth: 100,
        energy: 100,
        maxEnergy: 100,
        power: Number(options.powerBase || 10) + (index % 18),
        defense: 5 + (index % 7),
        speed: 10,
        intelligence: 20 + (index % 45),
        social: 25 + (index % 45),
      },
      resources: { currency: Number(options.currencyBase || 100) + index * 7, food: 10 },
      demographics: { age: 18 + (index % 38), generation: 1, sex: index % 2 === 0 ? 'female' : 'male' },
    });
  }
  return out;
}

function ids(prefix, start, end) {
  const out = [];
  for (let index = start; index <= end; index += 1) out.push(`${prefix}_${index}`);
  return out;
}

function titleCase(value) {
  return String(value).split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function mergeOptions(base, patch) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base?.[key] && typeof base[key] === 'object') {
      out[key] = mergeOptions(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

module.exports = {
  DEFAULT_TEMPLATE_SIMULATION,
  createWorldTemplateRegistry,
  registerWorldTemplate,
  getWorldTemplate,
  listWorldTemplates,
  summarizeWorldTemplate,
  createWorldFromTemplate,
  resetWorldFromTemplate,
  buildWorldFromDefinition,
  builtInWorldTemplates,
};
