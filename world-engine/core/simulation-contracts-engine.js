'use strict';

const { normalizeSystemContracts } = require('./system-contract-engine');
const {
  instrumentSystemContracts,
} = require('./system-contract-runtime-engine');

const SIMULATION_CONTRACTS_VERSION = 1;

const ARRAY_RESULT_SYSTEMS = new Set([
  'social.contracts',
  'social.organizations',
  'agency.planning',
  'finalize.history',
  'finalize.novel',
]);

function attachSimulationSystemContracts(registry, options = {}) {
  if (!registry || !registry.systems || typeof registry.systems !== 'object') {
    throw new Error('attachSimulationSystemContracts requires simulation registry');
  }
  for (const system of Object.values(registry.systems)) {
    system.contracts = mergeContracts(system.contracts, contractsForSimulationSystem(system));
  }
  instrumentSystemContracts(registry, options);
  Object.defineProperty(registry, 'simulationContractsVersion', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: SIMULATION_CONTRACTS_VERSION,
  });
  return registry;
}

function contractsForSimulationSystem(system) {
  const resultType = ARRAY_RESULT_SYSTEMS.has(system.id) ? 'array' : 'object';
  const contracts = {
    before: [
      {
        id: 'simulation.world.id',
        target: 'world',
        path: 'id',
        type: 'string',
        minLength: 1,
      },
      {
        id: 'simulation.world.tick',
        target: 'world',
        path: 'tick',
        type: 'integer',
        integer: true,
        min: 0,
      },
      {
        id: 'simulation.world.entities',
        target: 'world',
        path: 'entities',
        type: 'object',
      },
      {
        id: 'simulation.world.locations',
        target: 'world',
        path: 'locations',
        type: 'object',
      },
      {
        id: 'simulation.frame',
        target: 'context',
        path: 'shared.simulationFrame',
        type: 'object',
      },
    ],
    result: [
      {
        id: 'simulation.result.type',
        target: 'result',
        path: '',
        type: resultType,
      },
    ],
    after: [],
  };

  addSpecificContracts(system.id, contracts);
  return contracts;
}

function addSpecificContracts(systemId, contracts) {
  if (systemId === 'population.lifecycle') {
    contracts.result.push(
      pathContract('population.births', 'result', 'births', 'array'),
      pathContract('population.deaths', 'result', 'deaths', 'array'),
    );
  }
  if (systemId === 'population.families') {
    contracts.result.push(pathContract('families.created', 'result', 'created', 'array'));
  }
  if (systemId === 'population.legacy') {
    contracts.result.push(
      pathContract('legacy.created', 'result', 'created', 'array'),
      pathContract('legacy.settled', 'result', 'processed.settled', 'array'),
    );
  }
  if (systemId === 'economy.production') {
    contracts.result.push(pathContract('economy.seeded', 'result', 'seededIndustries', 'array'));
  }
  if (systemId === 'agency.identity') {
    contracts.result.push(pathContract('identity.synced', 'result', 'synced', 'array'));
  }
  if (systemId === 'agency.desire') {
    contracts.result.push(
      pathContract('desire.updated', 'result', 'updated', 'array'),
      pathContract('desire.generatedGoals', 'result', 'generatedGoals', 'array'),
    );
  }
  if (systemId === 'agency.opportunity') {
    contracts.result.push(
      pathContract('opportunity.generated', 'result', 'generated', 'array'),
      pathContract('opportunity.claimed', 'result', 'claimed', 'array'),
      pathContract('opportunity.expired', 'result', 'expired', 'array'),
    );
  }
  if (systemId === 'world.advance') {
    contracts.after.push({
      id: 'world.advance.tick',
      severity: 'error',
      target: 'world',
      path: 'tick',
      type: 'integer',
      integer: true,
      predicate(value, contractContext) {
        const expected = Number(contractContext.context?.targetTick);
        return value === expected || {
          ok: false,
          code: 'world_tick_not_advanced',
          message: `World tick ${value} does not match target tick ${expected}`,
          expected,
          actual: value,
        };
      },
    });
  }
  if (systemId === 'knowledge.information') {
    contracts.result.push(
      pathContract('information.created', 'result', 'createdFromMemory', 'array'),
      pathContract('information.spread', 'result', 'spread', 'array'),
    );
  }
  if (systemId === 'knowledge.memory') {
    contracts.result.push(
      pathContract('memory.created', 'result', 'created', 'array'),
      pathContract('memory.faded', 'result', 'faded', 'array'),
    );
  }
  if (systemId === 'knowledge.culture') {
    contracts.result.push(
      pathContract('culture.synced', 'result', 'synced', 'array'),
      pathContract('culture.drifted', 'result', 'drifted', 'array'),
    );
  }
  if (systemId === 'knowledge.religion') {
    contracts.result.push(
      pathContract('religion.created', 'result', 'created', 'array'),
      pathContract('religion.spread', 'result', 'spread', 'array'),
    );
  }
  if (systemId === 'civilization.civilization') {
    contracts.result.push(
      pathContract('civilization.created', 'result', 'created', 'array'),
      pathContract('civilization.updated', 'result', 'updated', 'array'),
    );
  }
  if (systemId === 'civilization.technology') {
    contracts.result.push(
      pathContract('technology.initialized', 'result', 'initialized', 'array'),
      pathContract('technology.researched', 'result', 'researched', 'array'),
      pathContract('technology.unlocked', 'result', 'unlocked', 'array'),
    );
  }
  if (systemId === 'civilization.infrastructure') {
    contracts.result.push(
      pathContract('infrastructure.planned', 'result', 'planned', 'array'),
      pathContract('infrastructure.built', 'result', 'built', 'array'),
      pathContract('infrastructure.maintained', 'result', 'maintained', 'array'),
      pathContract('infrastructure.degraded', 'result', 'degraded', 'array'),
    );
  }
  if (systemId === 'civilization.governance') {
    contracts.result.push(
      pathContract('governance.created', 'result', 'created', 'array'),
      pathContract('governance.updated', 'result', 'updated', 'array'),
      pathContract('governance.unrest', 'result', 'unrest', 'array'),
      {
        id: 'governance.taxCollected',
        target: 'result',
        path: 'taxCollected',
        type: ['number', 'integer'],
        min: 0,
      },
    );
  }
  if (systemId === 'civilization.processes') {
    contracts.result.push(
      pathContract('process.created', 'result', 'created', 'array'),
      pathContract('process.updated', 'result', 'updated', 'array'),
      pathContract('process.resolved', 'result', 'resolved', 'array'),
    );
  }
  if (systemId === 'civilization.emergence') {
    contracts.result.push(
      pathContract('emergence.detected', 'result', 'detected', 'array'),
      pathContract('emergence.resolved', 'result', 'resolved', 'array'),
    );
  }
  if (systemId === 'civilization.conflict') {
    contracts.result.push(
      pathContract('conflict.created', 'result', 'created', 'array'),
      pathContract('conflict.escalated', 'result', 'escalated', 'array'),
      pathContract('conflict.battles', 'result', 'battles', 'array'),
      pathContract('conflict.resolved', 'result', 'resolved', 'array'),
    );
  }
  if (systemId === 'civilization.players') {
    contracts.result.push(pathContract('players.changed', 'result', 'changed', 'array'));
  }
  if (systemId === 'finalize.report') {
    contracts.after.push(
      {
        id: 'simulation.frame.finalized',
        target: 'context',
        path: 'shared.simulationFrame.finalized',
        type: 'boolean',
        enum: [true],
      },
      {
        id: 'simulation.report.tick',
        target: 'world',
        path: 'simulation.lastTickReport.tickAfter',
        type: 'integer',
        integer: true,
        predicate(value, contractContext) {
          const expected = Number(contractContext.world?.tick);
          return value === expected || {
            ok: false,
            code: 'simulation_report_tick_mismatch',
            message: `Simulation report tick ${value} does not match world tick ${expected}`,
            expected,
            actual: value,
          };
        },
      },
    );
  }
}

function pathContract(id, target, path, type) {
  return { id, target, path, type };
}

function mergeContracts(existing, additions) {
  const left = normalizeSystemContracts(existing || {});
  const right = normalizeSystemContracts(additions || {});
  return {
    before: [...left.before, ...right.before],
    result: [...left.result, ...right.result],
    after: [...left.after, ...right.after],
  };
}

function getSimulationContractSummary(registry) {
  const systems = Object.values(registry?.systems || {});
  const byStage = { before: 0, result: 0, after: 0 };
  let contracts = 0;
  for (const system of systems) {
    const normalized = normalizeSystemContracts(system.contracts || {});
    for (const stage of Object.keys(byStage)) {
      byStage[stage] += normalized[stage].length;
      contracts += normalized[stage].length;
    }
  }
  return {
    version: SIMULATION_CONTRACTS_VERSION,
    systems: systems.filter(system => (
      Object.values(normalizeSystemContracts(system.contracts || {}))
        .some(entries => entries.length > 0)
    )).length,
    contracts,
    byStage,
  };
}

module.exports = {
  SIMULATION_CONTRACTS_VERSION,
  ARRAY_RESULT_SYSTEMS,
  attachSimulationSystemContracts,
  contractsForSimulationSystem,
  getSimulationContractSummary,
};
