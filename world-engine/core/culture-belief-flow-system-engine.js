'use strict';

const { registerSystem } = require('./system-scheduler-engine');
const { processCultureBeliefFlowTick } = require('./culture-belief-flow-engine');

const CULTURE_BELIEF_FLOW_SYSTEM_ID = 'knowledge.culture_belief_flow';

function registerCultureBeliefFlowSystem(registry, options = {}) {
  return registerSystem(registry, {
    id: CULTURE_BELIEF_FLOW_SYSTEM_ID,
    phase: options.phase || 'knowledge',
    priority: Number(options.priority || 10),
    after: options.after || ['knowledge.religion'],
    before: options.before || ['civilization.civilization'],
    reads: ['cultures', 'religions', 'entities', 'organizations', 'cities'],
    writes: ['cultureBeliefFlow', 'cultures', 'religions', 'organizations'],
    tags: ['simulation', 'knowledge', 'culture-belief-flow'],
    when: context => {
      const frame = context.shared?.simulationFrame;
      if (!frame) return false;
      return frame.config.autoCultureBeliefFlow !== false;
    },
    run: context => {
      const frame = context.shared.simulationFrame;
      const result = processCultureBeliefFlowTick(context.world, frame.config.cultureBeliefFlow || {});
      frame.report.cultureBeliefFlow = result;
      addCounter(frame.simulation, 'cultureBeliefFlowLinks', result.links);
      addCounter(frame.simulation, 'cultureBeliefTransfers', result.transfers.length);
      addCounter(frame.simulation, 'beliefCultureInfluences', result.beliefCulture.length);
      addCounter(frame.simulation, 'beliefOrganizationLinks', result.organizationLinks.length);
      return result;
    },
  });
}

function addCounter(simulation, key, amount) {
  if (!simulation.counters) simulation.counters = {};
  if (simulation.counters[key] === undefined) simulation.counters[key] = 0;
  simulation.counters[key] += Number(amount || 0);
}

module.exports = {
  CULTURE_BELIEF_FLOW_SYSTEM_ID,
  registerCultureBeliefFlowSystem,
};
