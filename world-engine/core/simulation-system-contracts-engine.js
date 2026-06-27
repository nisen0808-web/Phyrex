'use strict';

const {
  createSystemContract,
  attachRegistryContracts,
  analyzeContractCoverage,
} = require('./system-contract-engine');

const SIMULATION_CONTRACT_SET_VERSION = 1;

function createSimulationSystemContracts() {
  const contracts = {
    'natural.world': outputObject({
      calendar: objectSchema(),
      climate: objectSchema(),
      weather: objectSchema(),
      resources: objectSchema(),
      disasters: objectSchema(),
    }, ['calendar', 'climate', 'weather', 'resources', 'disasters']),
    'ecology.world': outputObject({
      habitats: objectSchema(),
      seeded: arraySchema(),
      populations: objectSchema(),
      foodWeb: objectSchema(),
      disease: objectSchema(),
      migration: objectSchema(),
    }, ['habitats', 'seeded', 'populations', 'foodWeb', 'disease', 'migration']),
    'population.lifecycle': outputObject({ births: arraySchema(), deaths: arraySchema() }, ['births', 'deaths']),
    'population.families': outputObject({ created: arraySchema() }, ['created']),
    'population.legacy': outputObject({ created: arraySchema(), processed: objectSchema() }, ['created', 'processed']),
    'social.contracts': outputArray(),
    'social.organizations': outputArray(),
    'economy.production': outputObject({ seededIndustries: arraySchema() }, ['seededIndustries']),
    'economy.cities': outputObject(),
    'agency.identity': outputObject({ synced: arraySchema() }, ['synced']),
    'agency.desire': outputObject({ updated: arraySchema(), generatedGoals: arraySchema() }, ['updated', 'generatedGoals']),
    'agency.opportunity': outputObject({ generated: arraySchema(), claimed: arraySchema(), expired: arraySchema() }, ['generated', 'claimed', 'expired']),
    'agency.planning': outputArray({
      type: 'object',
      required: ['entityId', 'goalId', 'actionType'],
      properties: { entityId: nonEmptyStringSchema(), goalId: nonEmptyStringSchema(), actionType: nonEmptyStringSchema() },
    }),
    'world.advance': createSystemContract({
      description: 'Advance the canonical world clock and process queued actions and events.',
      inputs: baseInputs(),
      output: objectSchema(),
      postconditions: [pathRule('world.tick', integerSchema({ minimum: 0 }))],
      validateOutput(_result, metadata) {
        if (metadata.context.world.tick !== metadata.context.targetTick) {
          return { path: 'world.tick', code: 'target_tick_mismatch', message: 'World advance must leave world.tick at targetTick', expected: metadata.context.targetTick, actual: metadata.context.world.tick };
        }
        return true;
      },
    }),
    'knowledge.information': outputObject({ createdFromMemory: arraySchema(), spread: arraySchema() }, ['createdFromMemory', 'spread']),
    'knowledge.memory': outputObject({ created: arraySchema(), faded: arraySchema() }, ['created', 'faded']),
    'knowledge.culture': outputObject({ synced: arraySchema(), drifted: arraySchema() }, ['synced', 'drifted']),
    'knowledge.religion': outputObject({ created: arraySchema(), spread: arraySchema() }, ['created', 'spread']),
    'civilization.civilization': outputObject({ created: arraySchema(), updated: arraySchema() }, ['created', 'updated']),
    'civilization.technology': outputObject({ initialized: arraySchema(), researched: arraySchema(), unlocked: arraySchema() }, ['initialized', 'researched', 'unlocked']),
    'civilization.infrastructure': outputObject({ planned: arraySchema(), built: arraySchema(), maintained: arraySchema(), degraded: arraySchema() }, ['planned', 'built', 'maintained', 'degraded']),
    'civilization.governance': outputObject({ created: arraySchema(), updated: arraySchema(), unrest: arraySchema(), taxCollected: numberSchema({ minimum: 0 }) }, ['created', 'updated', 'unrest', 'taxCollected']),
    'civilization.processes': outputObject({ created: arraySchema(), updated: arraySchema(), resolved: arraySchema() }, ['created', 'updated', 'resolved']),
    'civilization.emergence': outputObject({ detected: arraySchema(), resolved: arraySchema() }, ['detected', 'resolved']),
    'civilization.conflict': outputObject({ created: arraySchema(), escalated: arraySchema(), battles: arraySchema(), resolved: arraySchema() }, ['created', 'escalated', 'battles', 'resolved']),
    'civilization.players': outputObject({ changed: arraySchema() }, ['changed']),
    'finalize.history': outputArray(),
    'finalize.narrative': outputAnyOf(['array', 'object']),
    'finalize.novel': outputAnyOf(['array', 'object']),
    'world.consistency': createSystemContract({
      description: 'Audit and optionally repair core world state consistency before the final tick report is persisted.',
      inputs: baseInputs(),
      output: {
        type: 'object',
        required: ['version', 'tick', 'ok', 'issueCount', 'repairedCount', 'issues', 'repairs'],
        properties: {
          version: integerSchema({ const: 1 }),
          tick: integerSchema({ minimum: 0 }),
          ok: { type: 'boolean' },
          issueCount: integerSchema({ minimum: 0 }),
          repairedCount: integerSchema({ minimum: 0 }),
          issues: arraySchema(),
          repairs: arraySchema(),
        },
      },
      postconditions: [pathRule('world.consistency.lastReport', objectSchema())],
    }),
    'finalize.report': createSystemContract({
      description: 'Finalize simulation counters and persist the compact tick report.',
      inputs: baseInputs(),
      output: {
        type: 'object',
        required: ['tickBefore', 'tickAfter', 'completedActions', 'processedEvents'],
        properties: { tickBefore: integerSchema({ minimum: 0 }), tickAfter: integerSchema({ minimum: 0 }), completedActions: integerSchema({ minimum: 0 }), processedEvents: integerSchema({ minimum: 0 }) },
      },
      postconditions: [pathRule('shared.simulationFrame.finalized', { type: 'boolean', const: true }), pathRule('world.simulation.lastTickReport', objectSchema())],
    }),
  };
  return contracts;
}

function attachSimulationSystemContracts(registry, options = {}) {
  const contracts = createSimulationSystemContracts();
  const result = attachRegistryContracts(registry, contracts, options);
  return { version: SIMULATION_CONTRACT_SET_VERSION, ...result };
}

function getSimulationContractCoverage(registry) { return { version: SIMULATION_CONTRACT_SET_VERSION, ...analyzeContractCoverage(registry) }; }
function outputObject(properties = {}, required = []) { return createSystemContract({ inputs: baseInputs(), output: objectSchema(properties, required) }); }
function outputArray(items = null) { return createSystemContract({ inputs: baseInputs(), output: arraySchema(items) }); }
function outputAnyOf(types) { return createSystemContract({ inputs: baseInputs(), output: { anyOf: (types || []).map(type => ({ type })) } }); }
function baseInputs() { return [pathRule('world', objectSchema()), pathRule('world.tick', integerSchema({ minimum: 0 })), pathRule('shared.simulationFrame', objectSchema()), pathRule('shared.simulationFrame.version', integerSchema({ const: 1 })), pathRule('shared.simulationFrame.config', objectSchema()), pathRule('shared.simulationFrame.report', objectSchema()), pathRule('targetTick', integerSchema({ minimum: 1 }))]; }
function pathRule(path, schema, optional = false) { return { path, schema, optional }; }
function objectSchema(properties = {}, required = []) { return { type: 'object', required, properties }; }
function arraySchema(items = null) { return items ? { type: 'array', items } : { type: 'array' }; }
function integerSchema(patch = {}) { return { type: 'integer', ...patch }; }
function numberSchema(patch = {}) { return { type: 'number', ...patch }; }
function nonEmptyStringSchema() { return { type: 'string', minLength: 1 }; }

module.exports = {
  SIMULATION_CONTRACT_SET_VERSION,
  createSimulationSystemContracts,
  attachSimulationSystemContracts,
  getSimulationContractCoverage,
  baseInputs,
  objectSchema,
  arraySchema,
  integerSchema,
  numberSchema,
  nonEmptyStringSchema,
};
