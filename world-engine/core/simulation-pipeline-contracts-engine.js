'use strict';

const {
  attachRegistryContracts,
  analyzeContractCoverage,
} = require('./system-contract-engine');

const SIMULATION_PIPELINE_CONTRACT_VERSION = 1;

const SYSTEM_OUTPUT_SCHEMAS = {
  'population.lifecycle': objectSchema({ births: arraySchema(), deaths: arraySchema() }, ['births', 'deaths']),
  'population.families': objectSchema(),
  'population.legacy': objectSchema({ created: arraySchema(), processed: objectSchema() }, ['created', 'processed']),
  'social.contracts': { anyOf: [arraySchema(), objectSchema()] },
  'social.organizations': arraySchema(),
  'economy.production': objectSchema(),
  'economy.cities': objectSchema(),
  'agency.identity': objectSchema({ synced: arraySchema() }, ['synced']),
  'agency.desire': objectSchema({ updated: arraySchema(), generatedGoals: arraySchema() }, ['updated', 'generatedGoals']),
  'agency.opportunity': objectSchema({ generated: arraySchema(), claimed: arraySchema(), expired: arraySchema() }, ['generated', 'claimed', 'expired']),
  'agency.planning': arraySchema(),
  'world.advance': objectSchema(),
  'knowledge.information': objectSchema({ createdFromMemory: arraySchema(), spread: arraySchema() }, ['createdFromMemory', 'spread']),
  'knowledge.memory': objectSchema({ created: arraySchema(), faded: arraySchema() }, ['created', 'faded']),
  'knowledge.culture': objectSchema({ synced: arraySchema(), drifted: arraySchema() }, ['synced', 'drifted']),
  'knowledge.religion': objectSchema({ created: arraySchema(), spread: arraySchema() }, ['created', 'spread']),
  'civilization.civilization': objectSchema({ created: arraySchema(), updated: arraySchema() }, ['created', 'updated']),
  'civilization.technology': objectSchema({ initialized: arraySchema(), researched: arraySchema(), unlocked: arraySchema() }, ['initialized', 'researched', 'unlocked']),
  'civilization.infrastructure': objectSchema({ planned: arraySchema(), built: arraySchema(), maintained: arraySchema(), degraded: arraySchema() }, ['planned', 'built', 'maintained', 'degraded']),
  'civilization.governance': objectSchema({ created: arraySchema(), updated: arraySchema(), unrest: arraySchema(), taxCollected: 'number' }, ['created', 'updated', 'unrest', 'taxCollected']),
  'civilization.processes': objectSchema({ created: arraySchema(), updated: arraySchema(), resolved: arraySchema() }, ['created', 'updated', 'resolved']),
  'civilization.emergence': objectSchema({ detected: arraySchema(), resolved: arraySchema() }, ['detected', 'resolved']),
  'civilization.conflict': objectSchema({ created: arraySchema(), escalated: arraySchema(), battles: arraySchema(), resolved: arraySchema() }, ['created', 'escalated', 'battles', 'resolved']),
  'civilization.players': objectSchema({ changed: arraySchema() }, ['changed']),
  'finalize.history': arraySchema(),
  'finalize.narrative': objectSchema(),
  'finalize.novel': arraySchema(),
  'finalize.report': objectSchema({ tickBefore: 'number', tickAfter: 'number' }, ['tickBefore', 'tickAfter']),
};

function createSimulationPipelineContracts(registry, options = {}) {
  const contracts = {};
  const systems = Object.values(registry?.systems || {});
  for (const system of systems) {
    contracts[system.id] = createContractForSystem(system, options);
  }
  return contracts;
}

function attachSimulationPipelineContracts(registry, options = {}) {
  const contracts = options.contracts || createSimulationPipelineContracts(registry, options);
  const attachment = attachRegistryContracts(registry, contracts, {
    policy: options.policy || 'error',
    maxViolations: options.maxViolations || 50,
    recordValues: Boolean(options.recordValues),
  });
  return {
    version: SIMULATION_PIPELINE_CONTRACT_VERSION,
    ...attachment,
    summary: analyzeContractCoverage(registry),
  };
}

function createContractForSystem(system, options = {}) {
  const inputRules = [
    { path: 'world', schema: 'object' },
    { path: 'shared.simulationFrame', schema: 'object' },
    { path: 'tick', schema: 'number' },
    { path: 'targetTick', schema: 'number' },
    ...statePathRules(system.reads, options),
  ];
  const postconditions = [
    { path: 'shared.simulationFrame.report', schema: 'object' },
    ...statePathRules(system.writes, options),
  ];
  return {
    description: `Contract for ${system.id}`,
    inputs: inputRules,
    output: SYSTEM_OUTPUT_SCHEMAS[system.id] || 'any',
    postconditions,
    metadata: {
      systemId: system.id,
      phase: system.phase,
      reads: [...(system.reads || [])],
      writes: [...(system.writes || [])],
    },
  };
}

function statePathRules(paths, options = {}) {
  const requireDeclaredState = Boolean(options.requireDeclaredState);
  return (paths || [])
    .filter(path => path && path !== '*')
    .map(path => ({
      path: `world.${path}`,
      optional: !requireDeclaredState,
      schema: 'any',
    }));
}

function objectSchema(properties = {}, required = []) {
  return {
    type: 'object',
    properties,
    required,
  };
}

function arraySchema(items = 'any') {
  return {
    type: 'array',
    items,
  };
}

module.exports = {
  SIMULATION_PIPELINE_CONTRACT_VERSION,
  SYSTEM_OUTPUT_SCHEMAS,
  createSimulationPipelineContracts,
  attachSimulationPipelineContracts,
  createContractForSystem,
};
