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
const { processIdentityTick } = require('./identity-engine');
const { processDesireTick } = require('./desire-engine');
const { processOpportunityTick } = require('./opportunity-engine');
const { processInformationTick } = require('./information-engine');
const { processMemoryTick } = require('./memory-engine');
const { processCultureTick } = require('./culture-engine');
const { processReligionTick } = require('./religion-engine');
const { processCivilizationTick } = require('./civilization-engine');
const { processTechnologyTick } = require('./technology-engine');
const { processInfrastructureTick } = require('./infrastructure-engine');
const { processGovernanceTick } = require('./governance-engine');
const { processProcessesTick } = require('./process-engine');
const { processEmergenceTick } = require('./emergence-engine');
const { processConflictTick } = require('./conflict-engine');
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
  autoIdentity: true,
  autoDesire: true,
  autoOpportunity: true,
  autoInformation: true,
  autoMemory: true,
  autoCulture: true,
  autoReligion: true,
  autoCivilization: true,
  autoTechnology: true,
  autoInfrastructure: true,
  autoGovernance: true,
  autoProcess: true,
  autoEmergence: true,
  autoConflict: true,
  autoHistory: true,
  autoNarrative: true,
  autoNovel: true,
  narrativeEveryTicks: 24,
  novelEveryTicks: 72,
  seedIndustriesEveryTicks: 24,
  maxActionPlansPerTick: 500,
  maxWorldMemory: 1000,
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
        identitiesSynced: 0,
        desiresUpdated: 0,
        desireGoalsGenerated: 0,
        opportunitiesGenerated: 0,
        opportunitiesClaimed: 0,
        opportunitiesExpired: 0,
        informationCreated: 0,
        informationSpread: 0,
        memoriesCreated: 0,
        memoriesFaded: 0,
        culturesSynced: 0,
        culturesDrifted: 0,
        religionsCreated: 0,
        religionConversions: 0,
        civilizationsCreated: 0,
        civilizationsUpdated: 0,
        technologiesInitialized: 0,
        technologiesResearched: 0,
        technologiesUnlocked: 0,
        infrastructurePlanned: 0,
        infrastructureBuilt: 0,
        infrastructureMaintained: 0,
        infrastructureDegraded: 0,
        governmentsCreated: 0,
        governmentsUpdated: 0,
        unrestEvents: 0,
        taxCollected: 0,
        processesCreated: 0,
        processesUpdated: 0,
        processesResolved: 0,
        emergencesDetected: 0,
        emergencesResolved: 0,
        conflictsCreated: 0,
        conflictsEscalated: 0,
        conflictEvents: 0,
        conflictsResolved: 0,
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
    contractsProcessed: 0,
    organizations: null,
    economy: null,
    city: null,
    identities: null,
    desires: null,
    opportunities: null,
    information: null,
    memories: null,
    cultures: null,
    religions: null,
    civilizations: null,
    technologies: null,
    infrastructure: null,
    governance: null,
    processes: null,
    emergences: null,
    conflicts: null,
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
    report.contractsProcessed = countActiveContracts(world);
    report.contracts = processContractsTick(world, config.contract || {});
    simulation.counters.contractsProcessed += report.contractsProcessed;
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

  if (config.autoIdentity) {
    report.identities = processIdentityTick(world, config.identity || {});
    simulation.counters.identitiesSynced += report.identities.synced.length;
  }

  if (config.autoDesire) {
    report.desires = processDesireTick(world, config.desire || {});
    simulation.counters.desiresUpdated += report.desires.updated.length;
    simulation.counters.desireGoalsGenerated += report.desires.generatedGoals.length;
  }

  if (config.autoOpportunity) {
    report.opportunities = processOpportunityTick(world, config.opportunity || {});
    simulation.counters.opportunitiesGenerated += report.opportunities.generated.length;
    simulation.counters.opportunitiesClaimed += report.opportunities.claimed.length;
    simulation.counters.opportunitiesExpired += report.opportunities.expired.length;
  }

  if (config.autoPlanActions) {
    const plans = planAllEntityActions(world, config.goal || {}).slice(0, config.maxActionPlansPerTick);
    for (const plan of plans) enqueueAction(world, plan.action);
    report.plans = plans.map(plan => ({ entityId: plan.entityId, goalId: plan.goal.id, actionType: plan.action.type }));
    simulation.counters.plannedActions += report.plans.length;
  }

  report.world = advanceOneTick(world, config.world || {});
  report.tickAfter = world.tick;

  if (config.autoInformation) {
    report.information = processInformationTick(world, config.information || {});
    simulation.counters.informationCreated += report.information.createdFromMemory.length;
    simulation.counters.informationSpread += report.information.spread.length;
  }

  if (config.autoMemory) {
    report.memories = processMemoryTick(world, config.memory || {});
    simulation.counters.memoriesCreated += report.memories.created.length;
    simulation.counters.memoriesFaded += report.memories.faded.length;
  }

  if (config.autoCulture) {
    report.cultures = processCultureTick(world, config.culture || {});
    simulation.counters.culturesSynced += report.cultures.synced.length;
    simulation.counters.culturesDrifted += report.cultures.drifted.length;
  }

  if (config.autoReligion) {
    report.religions = processReligionTick(world, config.religion || {});
    simulation.counters.religionsCreated += report.religions.created.length;
    simulation.counters.religionConversions += report.religions.spread.length;
  }

  if (config.autoCivilization) {
    report.civilizations = processCivilizationTick(world, config.civilization || {});
    simulation.counters.civilizationsCreated += report.civilizations.created.length;
    simulation.counters.civilizationsUpdated += report.civilizations.updated.length;
  }

  if (config.autoTechnology) {
    report.technologies = processTechnologyTick(world, config.technology || {});
    simulation.counters.technologiesInitialized += report.technologies.initialized.length;
    simulation.counters.technologiesResearched += report.technologies.researched.length;
    simulation.counters.technologiesUnlocked += report.technologies.unlocked.length;
  }

  if (config.autoInfrastructure) {
    report.infrastructure = processInfrastructureTick(world, config.infrastructure || {});
    simulation.counters.infrastructurePlanned += report.infrastructure.planned.length;
    simulation.counters.infrastructureBuilt += report.infrastructure.built.length;
    simulation.counters.infrastructureMaintained += report.infrastructure.maintained.length;
    simulation.counters.infrastructureDegraded += report.infrastructure.degraded.length;
  }

  if (config.autoGovernance) {
    report.governance = processGovernanceTick(world, config.governance || {});
    simulation.counters.governmentsCreated += report.governance.created.length;
    simulation.counters.governmentsUpdated += report.governance.updated.length;
    simulation.counters.unrestEvents += report.governance.unrest.length;
    simulation.counters.taxCollected += report.governance.taxCollected;
  }

  if (config.autoProcess) {
    report.processes = processProcessesTick(world, config.process || {});
    simulation.counters.processesCreated += report.processes.created.length;
    simulation.counters.processesUpdated += report.processes.updated.length;
    simulation.counters.processesResolved += report.processes.resolved.length;
  }

  if (config.autoEmergence) {
    report.emergences = processEmergenceTick(world, config.emergence || {});
    simulation.counters.emergencesDetected += report.emergences.detected.length;
    simulation.counters.emergencesResolved += report.emergences.resolved.length;
  }

  if (config.autoConflict) {
    report.conflicts = processConflictTick(world, config.conflict || {});
    simulation.counters.conflictsCreated += report.conflicts.created.length;
    simulation.counters.conflictsEscalated += report.conflicts.escalated.length;
    simulation.counters.conflictEvents += report.conflicts.battles.length;
    simulation.counters.conflictsResolved += report.conflicts.resolved.length;
  }

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

  trimWorldMemory(world, config.maxWorldMemory);
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
    contractsProcessed: report.contractsProcessed || report.contracts?.length || 0,
    organizationsProcessed: report.organizations?.length || 0,
    industriesSeeded: report.economy?.seededIndustries?.length || 0,
    economyProcessed: Boolean(report.economy),
    cityProcessed: Boolean(report.city),
    identitiesSynced: report.identities?.synced?.length || 0,
    desiresUpdated: report.desires?.updated?.length || 0,
    desireGoalsGenerated: report.desires?.generatedGoals?.length || 0,
    opportunitiesGenerated: report.opportunities?.generated?.length || 0,
    opportunitiesClaimed: report.opportunities?.claimed?.length || 0,
    opportunitiesExpired: report.opportunities?.expired?.length || 0,
    informationCreated: report.information?.createdFromMemory?.length || 0,
    informationSpread: report.information?.spread?.length || 0,
    memoriesCreated: report.memories?.created?.length || 0,
    memoriesFaded: report.memories?.faded?.length || 0,
    culturesSynced: report.cultures?.synced?.length || 0,
    culturesDrifted: report.cultures?.drifted?.length || 0,
    religionsCreated: report.religions?.created?.length || 0,
    religionConversions: report.religions?.spread?.length || 0,
    civilizationsCreated: report.civilizations?.created?.length || 0,
    civilizationsUpdated: report.civilizations?.updated?.length || 0,
    technologiesInitialized: report.technologies?.initialized?.length || 0,
    technologiesResearched: report.technologies?.researched?.length || 0,
    technologiesUnlocked: report.technologies?.unlocked?.length || 0,
    infrastructurePlanned: report.infrastructure?.planned?.length || 0,
    infrastructureBuilt: report.infrastructure?.built?.length || 0,
    infrastructureMaintained: report.infrastructure?.maintained?.length || 0,
    infrastructureDegraded: report.infrastructure?.degraded?.length || 0,
    governmentsCreated: report.governance?.created?.length || 0,
    governmentsUpdated: report.governance?.updated?.length || 0,
    unrestEvents: report.governance?.unrest?.length || 0,
    taxCollected: report.governance?.taxCollected || 0,
    processesCreated: report.processes?.created?.length || 0,
    processesUpdated: report.processes?.updated?.length || 0,
    processesResolved: report.processes?.resolved?.length || 0,
    emergencesDetected: report.emergences?.detected?.length || 0,
    emergencesResolved: report.emergences?.resolved?.length || 0,
    conflictsCreated: report.conflicts?.created?.length || 0,
    conflictsEscalated: report.conflicts?.escalated?.length || 0,
    conflictEvents: report.conflicts?.battles?.length || 0,
    conflictsResolved: report.conflicts?.resolved?.length || 0,
    plannedActions: report.plans?.length || 0,
    completedActions: report.world?.actions?.completed?.length || 0,
    processedEvents: report.world?.events?.processed?.length || 0,
    historyEvents: report.history?.length || 0,
    narrativeUpdated: Boolean(report.narrative),
    novelsUpdated: Array.isArray(report.novels) ? report.novels.length : 0,
  };
}

function trimWorldMemory(world, limit = 1000) {
  if (!Array.isArray(world.memory)) world.memory = [];
  while (world.memory.length > limit) world.memory.shift();
  return world.memory.length;
}

function countActiveContracts(world) {
  return Object.values(world.contracts?.byId || {}).filter(contract => contract.status === 'active').length;
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
