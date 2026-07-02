'use strict';

const {
  createDeterministicSimulationKernel,
  runDeterministicSimulationTick,
} = require('./deterministic-simulation-engine');
const {
  INFO_FLOW_SYSTEM_ID,
  registerInfoFlowSystem,
} = require('./info-flow-system-engine');

function createInfoFlowDeterministicKernel(options = {}) {
  const kernel = createDeterministicSimulationKernel(options.kernel || options);
  attachInfoFlowSystemToKernel(kernel, options.infoFlowSystem || {});
  return kernel;
}

function attachInfoFlowSystemToKernel(kernel, options = {}) {
  if (!kernel || !kernel.registry) throw new Error('attachInfoFlowSystemToKernel requires deterministic kernel');
  if (kernel.registry.systems?.[INFO_FLOW_SYSTEM_ID]) return kernel.registry.systems[INFO_FLOW_SYSTEM_ID];
  return registerInfoFlowSystem(kernel.registry, options);
}

function runDeterministicSimulationTickWithInfoFlow(world, options = {}, kernel = null) {
  const activeKernel = kernel || createInfoFlowDeterministicKernel(options.kernel || {});
  return runDeterministicSimulationTick(world, options, activeKernel);
}

module.exports = {
  createInfoFlowDeterministicKernel,
  attachInfoFlowSystemToKernel,
  runDeterministicSimulationTickWithInfoFlow,
};
