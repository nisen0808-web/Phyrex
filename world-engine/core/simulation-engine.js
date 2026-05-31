'use strict';

const { advanceOneTick, enqueueAction } = require('./world-engine');
const { planAllEntityActions } = require('./goal-engine');
const { processPopulationTick, initializePopulation } = require('./population-engine');
const { syncFamiliesFromPopulation, updateFamilyStatuses } = require('./family-engine');
const { createLegacyForRecentDeaths, processPendingLegacies } = require('./legacy-engine');
const { ingestWorldMemory } = require('./history-engine');
const { calculateAllNarrativeScores } = require('./narrative-score-engine');
const { updateNovelBlueprints } = require('./novel-engine');

const DEFAULT_SIMULATION_OPTIONS = {
  autoPlanActions: true,
  autoPopulation: true,
  autoFamilies: true,
  autoLegacy: true,
  autoHistory: true,
  autoNarrative: true,
  autoNovel: true,
  narrativeEveryTicks: 24,
  novelEveryTicks: 72,
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
