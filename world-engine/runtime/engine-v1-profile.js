'use strict';
// Capacity limits govern retained history. Live entities, relationships and
// protected processes are world scale and are never silently cancelled here.
const ENGINE_V1_PROFILE = {
  population: { ticksPerYear: 720, baseBirthChance: 0.0015, baseMortalityChance: 0.0001, environmentMortalityWeight: 0.1 },
  city: { minPopulationForSettlement: 1 },
  maxWorldMemory: 200,
  information: { maxInformationItems: 200, maxKnownItemsPerOwner: 30 },
  memory: { maxGlobalMemories: 500, maxMemoriesPerOwner: 30 },
  history: { maxEventsPerEntity: 100, maxTimelineEvents: 1000 },
  retention: { maxCausalityRecords: 500, maxTerminalGoalsPerEntity: 50 },
  contract: { maxTerminalContracts: 100 },
  opportunity: { maxTerminalOpportunities: 100 },
  conflict: { maxResolvedConflicts: 100 },
  process: { maxProcesses: 200, maxInactiveProcesses: 50, staleAfterTicks: 120, preserveActive: true },
  infoFlow: { eventLimit: 200, maxLinksPerTick: 30 },
  cultureBeliefFlow: { eventLimit: 200, maxLinksPerTick: 30 },
};
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
module.exports = { ENGINE_V1_PROFILE: freeze(ENGINE_V1_PROFILE) };
