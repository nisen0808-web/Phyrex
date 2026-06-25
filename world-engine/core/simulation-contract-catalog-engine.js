'use strict';

const {
  normalizeSystemContract,
  objectSchema,
  arraySchema,
} = require('./system-contract-engine');

const SIMULATION_CONTRACT_CATALOG_VERSION = 1;
const ARRAY = arraySchema('any');
const OBJECT = { type: 'object' };

const OUTPUT_SCHEMAS = {
  'population.lifecycle': objectWithArrays(['births', 'deaths']),
  'population.families': OBJECT,
  'population.legacy': objectSchema(
    ['created', 'processed'],
    {
      created: ARRAY,
      processed: objectSchema(['settled'], { settled: ARRAY }),
    },
  ),
  'social.contracts': 'any',
  'social.organizations': ARRAY,
  'economy.production': OBJECT,
  'economy.cities': 'any',
  'agency.identity': objectWithArrays(['synced']),
  'agency.desire': objectWithArrays(['updated', 'generatedGoals']),
  'agency.opportunity': objectWithArrays(['generated', 'claimed', 'expired']),
  'agency.planning': ARRAY,
  'world.advance': OBJECT,
  'knowledge.information': objectWithArrays(['createdFromMemory', 'spread']),
  'knowledge.memory': objectWithArrays(['created', 'faded']),
  'knowledge.culture': objectWithArrays(['synced', 'drifted']),
  'knowledge.religion': objectWithArrays(['created', 'spread']),
  'civilization.civilization': objectWithArrays(['created', 'updated']),
  'civilization.technology': objectWithArrays(['initialized', 'researched', 'unlocked']),
  'civilization.infrastructure': objectWithArrays(['planned', 'built', 'maintained', 'degraded']),
  'civilization.governance': objectSchema(
    ['created', 'updated', 'unrest', 'taxCollected'],
    {
      created: ARRAY,
      updated: ARRAY,
      unrest: ARRAY,
      taxCollected: 'number',
    },
  ),
  'civilization.processes': objectWithArrays(['created', 'updated', 'resolved']),
  'civilization.emergence': objectWithArrays(['detected', 'resolved']),
  'civilization.conflict': objectWithArrays(['created', 'escalated', 'battles', 'resolved']),
  'civilization.players': objectWithArrays(['changed']),
  'finalize.history': ARRAY,
  'finalize.narrative': 'any',
  'finalize.novel': 'any',
  'finalize.report': objectSchema(
    ['tickBefore', 'tickAfter'],
    {
      tickBefore: 'number',
      tickAfter: 'number',
    },
  ),
};

function createSimulationSystemContract(systemId) {
  const output = OUTPUT_SCHEMAS[systemId];
  if (output === undefined) return null;
  return normalizeSystemContract({
    version: SIMULATION_CONTRACT_CATALOG_VERSION,
    name: `simulation:${systemId}`,
    input: {
      paths: [
        { path: 'world', schema: 'object' },
        { path: 'world.tick', schema: 'number' },
        {
          path: 'shared.simulationFrame',
          schema: objectSchema(
            ['version', 'simulation', 'config', 'report'],
            {
              version: 'integer',
              simulation: 'object',
              config: 'object',
              report: 'object',
            },
          ),
        },
      ],
    },
    output,
    post: {
      paths: [
        { path: 'world.tick', schema: 'number' },
        { path: 'shared.simulationFrame.report', schema: 'object' },
      ],
    },
  });
}

function applySimulationContracts(registry, options = {}) {
  if (!registry?.systems || typeof registry.systems !== 'object') {
    throw new Error('applySimulationContracts requires a system registry');
  }
  const overwrite = Boolean(options.overwrite);
  const applied = [];
  const missing = [];
  for (const system of Object.values(registry.systems)) {
    const contract = createSimulationSystemContract(system.id);
    if (!contract) {
      if ((system.tags || []).includes('simulation')) missing.push(system.id);
      continue;
    }
    if (!system.contract || overwrite) {
      system.contract = contract;
      if (!system.contractPolicy && options.contractPolicy) {
        system.contractPolicy = options.contractPolicy;
      }
      applied.push(system.id);
    }
  }
  return { applied, missing };
}

function getSimulationContractCatalogSummary(registry = null) {
  const ids = Object.keys(OUTPUT_SCHEMAS).sort();
  const summary = {
    version: SIMULATION_CONTRACT_CATALOG_VERSION,
    contracts: ids.length,
    systemIds: ids,
    missing: [],
    declared: [],
  };
  if (registry?.systems) {
    summary.missing = Object.values(registry.systems)
      .filter(system => (system.tags || []).includes('simulation') && !OUTPUT_SCHEMAS[system.id])
      .map(system => system.id)
      .sort();
    summary.declared = Object.values(registry.systems)
      .filter(system => Boolean(system.contract))
      .map(system => system.id)
      .sort();
  }
  return summary;
}

function objectWithArrays(keys) {
  return objectSchema(
    keys,
    Object.fromEntries(keys.map(key => [key, ARRAY])),
  );
}

module.exports = {
  SIMULATION_CONTRACT_CATALOG_VERSION,
  OUTPUT_SCHEMAS,
  createSimulationSystemContract,
  applySimulationContracts,
  getSimulationContractCatalogSummary,
};
