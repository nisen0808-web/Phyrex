'use strict';

const { advanceOneTick, enqueueAction } = require('./world-engine');
const { planAllEntityActions } = require('./goal-engine');
const { processPopulationTick, initializePopulation } = require('./population-engine');
const { syncFamiliesFromPopulation, updateFamilyStatuses } = require('./family-engine');
const { createLegacyForRecentDeaths, processPendingLegacies } = require('./legacy-engine');
const { processContractsTick } = require('./contract-engine');
const { processOrganizationsTick } = require('./organization-engine');
const { ensureEconomyState, seedIndustriesFromOrganizations, processEconomyTick } = require('./economy-engine');
const { processCityTick } = require('./city-engine');
const { ingestWorldMemory } = require('./history-engine');
const { calculateAllNarrativeScores } = require('./narrative-score-engine');
const { updateNovelBlueprints } = require('./novel-engine');

const DEFAULT_SIMULATION_OPTIONS = {
  autoPlanActions: true,
  autoPopulation: true,
  autoFamilies: true,
  autoLegacy: true,
  autoContracts: true,
  autoOrganizations: true,
  autoEconomy: true,
  autoCity: true,
  autoHistory: true,
  autoNarrative: true,
  autoNovel: true,
  narrativeEveryTicks: 24,
  novelEveryTicks: 72,
  seedIndustriesEveryTicks: 24,
  maxActionPlansPerTick: 500,
};

function ensureSimulationState(world) {
  if (!world.simulation) {
    world.simulation = {
      options: { ...DEFAULT_SIMULATION_OPTIONS },
      startedAtTick: world.tick || 0,
      lastTickReport: null,
      reports: [],
      counters: {
        ticks: 0,
        plannedActions: 0,
        births: 0,
        deaths: 0,
        legaciesCreated: 0,
        legaciesSettled: 0,
        contractsProcessed: 0,
        organizationsProcessed: 0,
        industriesSeeded: 0,
        economyTicks: 0,
        cityTicks: 0,
        historyEvents: 0,
      },
    };
  }
  return world.simulation;
}

function initializeSimulation(world, options = {}) {
  const simulation = ensureSimulationState(world);
  simulation.options = { ...DEFAULT_SIMULATION_OPTIONS, ...(options || {}) };
  initializePopulation(world, options.population || {});
  syncFamiliesFromPopulation(world, { createForUnassigned: true });
  ensureEconomyState(world);
  if (options.seedIndustries !== false) {
    const seeded = seedIndustriesFromOrganizations(world, options.economy || {});
    simulation.counters.industriesSeeded += seeded.length;
  }
  return simulation;
}

function runSimulationTicks(world, ticks = 1, options = {}) {
  const reports = [];
  for (let i = 0; i < ticks; i += 1) {
    reports.push(runSimulationTick(world, options));
  }
  return reports;
}

function runSimulationTick(world, options = {}) {
  const simulation = ensureSimulationState(world);
  const config = { ...simulation.options, ...(options || {}) };
  const report = {
    tickBefore: world.tick,
    tickAfter: null,
    population: null,
    families: null,
    legacy: null,
    contracts: null,
    organizations: null,
    economy: null,
    city: null,
    plans: [],
    world: null,
    history: [],
    narrative: null,
    novels: null,
  };

  if (config.autoPopulation) {
    report.population = processPopulationTick(world, config.population || {});
    simulation.counters.births += report.population.births.length;
    simulation.counters.deaths += report.population.deaths.length;
  }

  if (config.autoFamilies) {
    report.families = syncFamiliesFromPopulation(world, { createForUnassigned: true });
    updateFamilyStatuses(world);
  }

  if (config.autoLegacy) {
    const created = createLegacyForRecentDeaths(world, config.legacy || {});
    const processed = processPendingLegacies(world, config.legacy || {});
    report.legacy = { created, processed };
    simulation.counters.legaciesCreated += created.length;
    simulation.counters.legaciesSettled += processed.settled.length;
  }

  if (config.autoContracts) {
    report.contracts = processContractsTick(world, config.contract || {});
    simulation.counters.contractsProcessed += report.contracts.length;
  }

  if (config.autoOrganizations) {
    report.organizations = processOrganizationsTick(world, config.organization || {});
    simulation.counters.organizationsProcessed += report.organizations.length;
  }

  if (config.autoEconomy) {
    const shouldSeedIndustries = config.seedIndustriesEveryTicks === 1 || shouldRunEvery(world.tick || 1, config.seedIndustriesEveryTicks);
    const seededIndustries = shouldSeedIndustries ? seedIndustriesFromOrganizations(world, config.economy || {}) : [];
    report.economy = processEconomyTick(world, config.economy || {});
    report.economy.seededIndustries = seededIndustries;
    simulation.counters.industriesSeeded += seededIndustries.length;
    simulation.counters.economyTicks += 1;
  }

  if (config.autoCity) {
    report.city = processCityTick(world, config.city || {});
    simulation.counters.cityTicks += 1;
  }

  if (config.autoPlanActions) {
    const plans = planAllEntityActions(world, config.goal || {}).slice(0, config.maxActionPlansPerTick);
    for (const plan of plans) enqueueAction(world, plan.action);
    report.plans = plans.map(plan => ({ entityId: plan.entityId, goalId: plan.goal.id, actionType: plan.action.type }));
    simulation.counters.plannedActions += report.plans.length;
  }

  report.world = advanceOneTick(world, config.world || {});
  report.tickAfter = world.tick;

  if (config.autoHistory) {
    report.history = ingestWorldMemory(world, config.history || {});
    simulation.counters.historyEvents += report.history.length;
  }

  if (config.autoNarrative && shouldRunEvery(world.tick, config.narrativeEveryTicks)) {
    report.narrative = calculateAllNarrativeScores(world, config.narrative || {});
  }

  if (config.autoNovel && shouldRunEvery(world.tick, config.novelEveryTicks)) {
    report.novels = updateNovelBlueprints(world, config.novel || {});
  }

  simulation.counters.ticks += 1;
  simulation.lastTickReport = compactReport(report);
  simulation.reports.push(simulation.lastTickReport);
  if (simulation.reports.length > 200) simulation.reports.shift();
  return report;
}

function compactReport(report) {
  return {
    tickBefore: report.tickBefore,
    tickAfter: report.tickAfter,
    births: report.population?.births?.length || 0,
    deaths: report.population?.deaths?.length || 0,
    familyCreated: report.families?.created?.length || 0,
    legacyCreated: report.legacy?.created?.length || 0,
    legacySettled: report.legacy?.processed?.settled?.length || 0,
    contractsProcessed: report.contracts?.length || 0,
    organizationsProcessed: report.organizations?.length || 0,
    industriesSeeded: report.economy?.seededIndustries?.length || 0,
    economyProcessed: Boolean(report.economy),
    cityProcessed: Boolean(report.city),
    plannedActions: report.plans?.length || 0,
    completedActions: report.world?.actions?.completed?.length || 0,
    processedEvents: report.world?.events?.processed?.length || 0,
    historyEvents: report.history?.length || 0,
    narrativeUpdated: Boolean(report.narrative),
    novelsUpdated: Array.isArray(report.novels) ? report.novels.length : 0,
  };
}

function shouldRunEvery(tick, every) {
  if (!every || every <= 0) return false;
  return tick % every === 0;
}

function getSimulationSummary(world) {
  const simulation = ensureSimulationState(world);
  return {
    startedAtTick: simulation.startedAtTick,
    currentTick: world.tick,
    counters: { ...simulation.counters },
    lastTickReport: simulation.lastTickReport,
  };
}

module.exports = {
  DEFAULT_SIMULATION_OPTIONS,
  ensureSimulationState,
  initializeSimulation,
  runSimulationTick,
  runSimulationTicks,
  getSimulationSummary,
};
