'use strict';

const { registerSystem } = require('./system-scheduler-engine');
const { runWorldConsistencyCheck } = require('./world-consistency-engine');

const WORLD_CONSISTENCY_SYSTEM_ID = 'world.consistency';

function registerWorldConsistencySystem(registry, options = {}) {
  if (!registry || !registry.systems) throw new Error('registerWorldConsistencySystem requires a system registry');
  if (registry.systems[WORLD_CONSISTENCY_SYSTEM_ID]) return registry.systems[WORLD_CONSISTENCY_SYSTEM_ID];
  return registerSystem(registry, {
    id: WORLD_CONSISTENCY_SYSTEM_ID,
    phase: options.phase || 'finalize',
    priority: Number(options.priority ?? 100),
    before: ['finalize.report'],
    reads: ['*'],
    writes: ['consistency', 'entities', 'locations', 'population', 'natural', 'ecology', 'memory', 'simulation', 'kernel'],
    tags: ['simulation', 'consistency', 'repair'],
    when: context => {
      const frame = context.shared?.simulationFrame;
      if (!frame) return false;
      return frame.config.autoConsistency !== false;
    },
    run: context => {
      const frame = context.shared.simulationFrame;
      const optionsForRun = {
        ...(frame.config.consistency || {}),
        repair: frame.config.autoRepairConsistency !== false,
      };
      const result = runWorldConsistencyCheck(context.world, optionsForRun);
      frame.report.consistency = result;
      addCounter(frame.simulation, 'consistencyChecks', 1);
      addCounter(frame.simulation, 'consistencyIssues', result.issueCount);
      addCounter(frame.simulation, 'consistencyRepairs', result.repairedCount);
      return result;
    },
  });
}

function addCounter(simulation, key, amount) {
  if (!simulation?.counters) return;
  if (simulation.counters[key] === undefined) simulation.counters[key] = 0;
  simulation.counters[key] += Number(amount || 0);
}

module.exports = {
  WORLD_CONSISTENCY_SYSTEM_ID,
  registerWorldConsistencySystem,
};
