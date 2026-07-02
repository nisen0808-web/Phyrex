'use strict';

const {
  createInfoFlowDeterministicKernel,
  runDeterministicSimulationTickWithInfoFlow,
} = require('./info-flow-runtime-engine');
const {
  CULTURE_BELIEF_FLOW_SYSTEM_ID,
  registerCultureBeliefFlowSystem,
} = require('./culture-belief-flow-system-engine');

function createCultureBeliefFlowDeterministicKernel(options = {}) {
  const kernel = createInfoFlowDeterministicKernel(options.kernel || options);
  attachCultureBeliefFlowSystemToKernel(kernel, options.cultureBeliefFlowSystem || {});
  return kernel;
}

function attachCultureBeliefFlowSystemToKernel(kernel, options = {}) {
  if (!kernel || !kernel.registry) throw new Error('attachCultureBeliefFlowSystemToKernel requires deterministic kernel');
  if (kernel.registry.systems?.[CULTURE_BELIEF_FLOW_SYSTEM_ID]) return kernel.registry.systems[CULTURE_BELIEF_FLOW_SYSTEM_ID];
  return registerCultureBeliefFlowSystem(kernel.registry, options);
}

function runDeterministicSimulationTickWithCultureBeliefFlow(world, options = {}, kernel = null) {
  const activeKernel = kernel || createCultureBeliefFlowDeterministicKernel(options.kernel || {});
  return runDeterministicSimulationTickWithInfoFlow(world, options, activeKernel);
}

module.exports = {
  createCultureBeliefFlowDeterministicKernel,
  attachCultureBeliefFlowSystemToKernel,
  runDeterministicSimulationTickWithCultureBeliefFlow,
};
