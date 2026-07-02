'use strict';

const { registerSystem } = require('./system-scheduler-engine');
const { processInfoFlowTick } = require('./info-flow-engine');

const INFO_FLOW_SYSTEM_ID = 'knowledge.info_flow';

function registerInfoFlowSystem(registry, options = {}) {
  return registerSystem(registry, {
    id: INFO_FLOW_SYSTEM_ID,
    phase: options.phase || 'knowledge',
    priority: Number(options.priority || 0),
    after: options.after || ['knowledge.religion'],
    before: options.before || ['civilization.civilization'],
    reads: ['information', 'memories', 'cultures', 'religions', 'entities', 'organizations', 'cities'],
    writes: ['infoFlow', 'information', 'memories', 'cultures', 'religions', 'entities'],
    tags: ['simulation', 'knowledge', 'info-flow'],
    when: context => {
      const frame = context.shared?.simulationFrame;
      if (!frame) return false;
      return frame.config.autoInfoFlow !== false;
    },
    run: context => {
      const frame = context.shared.simulationFrame;
      const result = processInfoFlowTick(context.world, frame.config.infoFlow || {});
      frame.report.infoFlow = result;
      addCounter(frame.simulation, 'infoFlowLinks', result.links);
      addCounter(frame.simulation, 'infoFlowShared', result.shared.length);
      addCounter(frame.simulation, 'infoFlowMemories', result.memories.length);
      addCounter(frame.simulation, 'infoFlowCulture', result.culture.length);
      addCounter(frame.simulation, 'infoFlowReligion', result.religion.length);
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
  INFO_FLOW_SYSTEM_ID,
  registerInfoFlowSystem,
};
