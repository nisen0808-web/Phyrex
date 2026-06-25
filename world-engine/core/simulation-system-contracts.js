'use strict';

const { attachSystemContract } = require('./system-scheduler-engine');

const ARRAY = Object.freeze({ type: 'array' });
const OBJECT = Object.freeze({ type: 'object' });
const INTEGER = Object.freeze({ type: 'integer' });
const NUMBER = Object.freeze({ type: ['integer', 'number'] });

const SIMULATION_SYSTEM_OUTPUT_SCHEMAS = {
  'population.lifecycle': objectWithArrays(['births', 'deaths']),
  'population.families': OBJECT,
  'population.legacy': {
    type: 'object',
    required: ['created', 'processed'],
    properties: {
      created: ARRAY,
      processed: OBJECT,
    },
  },
  'social.contracts': ARRAY,
  'social.organizations': ARRAY,
  'economy.production': OBJECT,
  'economy.cities': OBJECT,
  'agency.identity': objectWithArrays(['synced']),
  'agency.desire': objectWithArrays(['updated', 'generatedGoals']),
  'agency.opportunity': objectWithArrays(['generated', 'claimed', 'expired']),
  'agency.planning': ARRAY,
  'world.advance': {
    type: 'object',
    required: ['tick', 'calendar', 'actions', 'events'],
    properties: {
      tick: INTEGER,
      calendar: OBJECT,
      actions: OBJECT,
      events: OBJECT,
    },
  },
  'knowledge.information': objectWithArrays(['createdFromMemory', 'spread']),
  'knowledge.memory': objectWithArrays(['created', 'faded']),
  'knowledge.culture': objectWithArrays(['synced', 'drifted']),
  'knowledge.religion': objectWithArrays(['created', 'spread']),
  'civilization.civilization': objectWithArrays(['created', 'updated']),
  'civilization.technology': objectWithArrays(['initialized', 'researched', 'unlocked']),
  'civilization.infrastructure': objectWithArrays(['planned', 'built', 'maintained', 'degraded']),
  'civilization.governance': {
    ...objectWithArrays(['created', 'updated', 'unrest']),
    properties: {
      ...objectWithArrays(['created', 'updated', 'unrest']).properties,
      taxCollected: NUMBER,
    },
  },
  'civilization.processes': objectWithArrays(['created', 'updated', 'resolved']),
  'civilization.emergence': objectWithArrays(['detected', 'resolved']),
  'civilization.conflict': objectWithArrays(['created', 'escalated', 'battles', 'resolved']),
  'civilization.players': objectWithArrays(['changed']),
  'finalize.history': ARRAY,
  'finalize.narrative': { type: ['object', 'array'] },
  'finalize.novel': ARRAY,
  'finalize.report': {
    type: 'object',
    required: ['tickBefore', 'tickAfter'],
    properties: {
      tickBefore: INTEGER,
      tickAfter: INTEGER,
    },
  },
};

function applySimulationSystemContracts(registry) {
  const applied = [];
  for (const systemId of Object.keys(registry.systems || {}).sort()) {
    const contract = createSimulationSystemContract(systemId);
    if (!contract) continue;
    attachSystemContract(registry, systemId, contract);
    applied.push(systemId);
  }
  return applied;
}

function createSimulationSystemContract(systemId) {
  const output = SIMULATION_SYSTEM_OUTPUT_SCHEMAS[systemId];
  if (!output) return null;
  return {
    description: `Built-in simulation contract for ${systemId}`,
    input: validateSimulationContext,
    output,
    invariants: createSystemInvariants(systemId),
  };
}

function validateSimulationContext(context) {
  const issues = [];
  if (!context || typeof context !== 'object') {
    return 'Simulation system context must be an object';
  }
  if (!context.world || typeof context.world !== 'object') {
    issues.push({ path: '$context.world', code: 'world_missing', message: 'World state is required' });
  }
  if (!context.shared?.simulationFrame) {
    issues.push({ path: '$context.shared.simulationFrame', code: 'frame_missing', message: 'Simulation frame is required' });
  } else {
    const frame = context.shared.simulationFrame;
    if (!frame.config || typeof frame.config !== 'object') {
      issues.push({ path: '$context.shared.simulationFrame.config', code: 'config_missing', message: 'Simulation options are required' });
    }
    if (!frame.report || typeof frame.report !== 'object') {
      issues.push({ path: '$context.shared.simulationFrame.report', code: 'report_missing', message: 'Simulation report is required' });
    }
  }
  if (!Number.isInteger(context.tick) || context.tick < 0) {
    issues.push({ path: '$context.tick', code: 'invalid_tick', message: 'Current tick must be a non-negative integer' });
  }
  if (!Number.isInteger(context.targetTick) || context.targetTick !== context.tick + 1) {
    issues.push({ path: '$context.targetTick', code: 'invalid_target_tick', message: 'Target tick must equal current tick + 1' });
  }
  return issues.length ? { issues } : true;
}

function createSystemInvariants(systemId) {
  if (systemId === 'world.advance') {
    return [{
      id: 'world_tick_advanced_once',
      check({ world, context, result }) {
        if (world.tick !== context.targetTick) {
          return `World tick ${world.tick} does not equal target tick ${context.targetTick}`;
        }
        if (result?.tick !== world.tick) {
          return `Advance report tick ${result?.tick} does not equal world tick ${world.tick}`;
        }
        return true;
      },
    }];
  }

  if (systemId === 'finalize.report') {
    return [{
      id: 'simulation_report_finalized',
      check({ world, context }) {
        const frame = context.shared.simulationFrame;
        if (!frame.finalized) return 'Simulation frame was not finalized';
        if (frame.report.tickAfter !== world.tick) return 'Final report tick does not match world tick';
        if (frame.simulation.lastTickReport?.tickAfter !== world.tick) {
          return 'Compact simulation report does not match world tick';
        }
        return true;
      },
    }];
  }

  return [];
}

function objectWithArrays(keys) {
  return {
    type: 'object',
    required: [...keys],
    properties: Object.fromEntries(keys.map(key => [key, ARRAY])),
  };
}

module.exports = {
  SIMULATION_SYSTEM_OUTPUT_SCHEMAS,
  applySimulationSystemContracts,
  createSimulationSystemContract,
  validateSimulationContext,
};
