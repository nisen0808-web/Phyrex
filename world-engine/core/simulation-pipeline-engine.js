'use strict';

const { advanceOneTick, enqueueAction } = require('./world-engine');
const { planAllEntityActions } = require('./goal-engine');
const { processPopulationTick } = require('./population-engine');
const { syncFamiliesFromPopulation, updateFamilyStatuses } = require('./family-engine');
const { createLegacyForRecentDeaths, processPendingLegacies } = require('./legacy-engine');
const { processContractsTick } = require('./contract-engine');
const { processOrganizationsTick } = require('./organization-engine');
const { seedIndustriesFromOrganizations, processEconomyTick } = require('./economy-engine');
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
const { processPlayersTick } = require('./player-engine');
const { ingestWorldMemory } = require('./history-engine');
const { calculateAllNarrativeScores } = require('./narrative-score-engine');
const { updateNovelBlueprints } = require('./novel-engine');
const {
  DEFAULT_SIMULATION_OPTIONS,
  ensureSimulationState,
} = require('./simulation-engine');
const {
  createSystemRegistry,
  registerSystem,
  runSystemSchedule,
  analyzeSystemRegistry,
} = require('./system-scheduler-engine');

const SIMULATION_PIPELINE_VERSION = 1;
const SIMULATION_PIPELINE_PHASES = [
  'before',
  'population',
  'social',
  'economy',
  'agency',
  'advance',
  'knowledge',
  'civilization',
  'finalize',
  'after',
];

function createSimulationPipelineRegistry(options = {}) {
  const registry = createSystemRegistry({
    phases: options.phases || SIMULATION_PIPELINE_PHASES,
  });
  for (const definition of createSimulationSystemDefinitions(options)) {
    registerSystem(registry, definition);
  }
  return registry;
}

function createSimulationSystemDefinitions() {
  return [
    system('population.lifecycle', 'population', {
      reads: ['entities', 'species', 'locations', 'population'],
      writes: ['entities', 'locations', 'population', 'memory'],
      enabledBy: 'autoPopulation',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = processPopulationTick(world, frame.config.population || {});
        frame.report.population = result;
        addCounter(frame.simulation, 'births', result.births.length);
        addCounter(frame.simulation, 'deaths', result.deaths.length);
        return result;
      },
    }),
    system('population.families', 'population', {
      after: ['population.lifecycle'],
      reads: ['entities', 'population', 'families'],
      writes: ['entities', 'families'],
      enabledBy: 'autoFamilies',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = syncFamiliesFromPopulation(world, { createForUnassigned: true });
        updateFamilyStatuses(world);
        frame.report.families = result;
        return result;
      },
    }),
    system('population.legacy', 'population', {
      after: ['population.families'],
      reads: ['entities', 'population', 'families', 'legacies'],
      writes: ['entities', 'families', 'legacies', 'memory'],
      enabledBy: 'autoLegacy',
      run: context => {
        const { world, frame } = frameContext(context);
        const created = createLegacyForRecentDeaths(world, frame.config.legacy || {});
        const processed = processPendingLegacies(world, frame.config.legacy || {});
        const result = { created, processed };
        frame.report.legacy = result;
        addCounter(frame.simulation, 'legaciesCreated', created.length);
        addCounter(frame.simulation, 'legaciesSettled', processed.settled.length);
        return result;
      },
    }),
    system('social.contracts', 'social', {
      reads: ['contracts', 'entities', 'organizations'],
      writes: ['contracts', 'entities', 'organizations', 'memory'],
      enabledBy: 'autoContracts',
      run: context => {
        const { world, frame } = frameContext(context);
        const active = countActiveContracts(world);
        const result = processContractsTick(world, frame.config.contract || {});
        frame.report.contractsProcessed = active;
        frame.report.contracts = result;
        addCounter(frame.simulation, 'contractsProcessed', active);
        return result;
      },
    }),
    system('social.organizations', 'social', {
      after: ['social.contracts'],
      reads: ['organizations', 'entities', 'contracts'],
      writes: ['organizations', 'entities', 'memory'],
      enabledBy: 'autoOrganizations',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = processOrganizationsTick(world, frame.config.organization || {});
        frame.report.organizations = result;
        addCounter(frame.simulation, 'organizationsProcessed', result.length);
        return result;
      },
    }),
    system('economy.production', 'economy', {
      reads: ['economy', 'organizations', 'entities', 'locations'],
      writes: ['economy', 'organizations', 'entities', 'locations', 'memory'],
      enabledBy: 'autoEconomy',
      run: context => {
        const { world, frame } = frameContext(context);
        const shouldSeed = frame.config.seedIndustriesEveryTicks === 1
          || shouldRunEvery(world.tick || 1, frame.config.seedIndustriesEveryTicks);
        const seededIndustries = shouldSeed
          ? seedIndustriesFromOrganizations(world, frame.config.economy || {})
          : [];
        const result = processEconomyTick(world, frame.config.economy || {});
        result.seededIndustries = seededIndustries;
        frame.report.economy = result;
        addCounter(frame.simulation, 'industriesSeeded', seededIndustries.length);
        addCounter(frame.simulation, 'economyTicks', 1);
        return result;
      },
    }),
    system('economy.cities', 'economy', {
      after: ['economy.production'],
      reads: ['cities', 'locations', 'entities', 'economy'],
      writes: ['cities', 'locations', 'entities', 'organizations', 'memory'],
      enabledBy: 'autoCity',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = processCityTick(world, frame.config.city || {});
        frame.report.city = result;
        addCounter(frame.simulation, 'cityTicks', 1);
        return result;
      },
    }),
    system('agency.identity', 'agency', {
      reads: ['entities', 'identities', 'cultures', 'organizations'],
      writes: ['entities', 'identities'],
      enabledBy: 'autoIdentity',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = processIdentityTick(world, frame.config.identity || {});
        frame.report.identities = result;
        addCounter(frame.simulation, 'identitiesSynced', result.synced.length);
        return result;
      },
    }),
    system('agency.desire', 'agency', {
      after: ['agency.identity'],
      reads: ['entities', 'desires', 'goals', 'identities'],
      writes: ['entities', 'desires', 'goals'],
      enabledBy: 'autoDesire',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = processDesireTick(world, frame.config.desire || {});
        frame.report.desires = result;
        addCounter(frame.simulation, 'desiresUpdated', result.updated.length);
        addCounter(frame.simulation, 'desireGoalsGenerated', result.generatedGoals.length);
        return result;
      },
    }),
    system('agency.opportunity', 'agency', {
      after: ['agency.desire'],
      reads: ['entities', 'opportunities', 'goals', 'locations'],
      writes: ['entities', 'opportunities', 'goals'],
      enabledBy: 'autoOpportunity',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = processOpportunityTick(world, frame.config.opportunity || {});
        frame.report.opportunities = result;
        addCounter(frame.simulation, 'opportunitiesGenerated', result.generated.length);
        addCounter(frame.simulation, 'opportunitiesClaimed', result.claimed.length);
        addCounter(frame.simulation, 'opportunitiesExpired', result.expired.length);
        return result;
      },
    }),
    system('agency.planning', 'agency', {
      after: ['agency.opportunity'],
      reads: ['entities', 'goals', 'opportunities', 'locations'],
      writes: ['actions'],
      enabledBy: 'autoPlanActions',
      run: context => {
        const { world, frame } = frameContext(context);
        const plans = planAllEntityActions(world, frame.config.goal || {})
          .slice(0, frame.config.maxActionPlansPerTick);
        for (const plan of plans) enqueueAction(world, plan.action);
        const compact = plans.map(plan => ({
          entityId: plan.entityId,
          goalId: plan.goal.id,
          actionType: plan.action.type,
        }));
        frame.report.plans = compact;
        addCounter(frame.simulation, 'plannedActions', compact.length);
        return compact;
      },
    }),
    system('world.advance', 'advance', {
      reads: ['actions', 'events', 'entities', 'locations'],
      writes: ['tick', 'actions', 'events', 'entities', 'locations', 'memory'],
      run: context => {
        const { world, frame } = frameContext(context);
        const result = advanceOneTick(world, frame.config.world || {});
        frame.report.world = result;
        frame.report.tickAfter = world.tick;
        return result;
      },
    }),
    system('knowledge.information', 'knowledge', {
      reads: ['information', 'memory', 'entities'],
      writes: ['information', 'entities'],
      enabledBy: 'autoInformation',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = processInformationTick(world, frame.config.information || {});
        frame.report.information = result;
        addCounter(frame.simulation, 'informationCreated', result.createdFromMemory.length);
        addCounter(frame.simulation, 'informationSpread', result.spread.length);
        return result;
      },
    }),
    system('knowledge.memory', 'knowledge', {
      after: ['knowledge.information'],
      reads: ['memories', 'memory', 'entities', 'information'],
      writes: ['memories', 'entities'],
      enabledBy: 'autoMemory',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = processMemoryTick(world, frame.config.memory || {});
        frame.report.memories = result;
        addCounter(frame.simulation, 'memoriesCreated', result.created.length);
        addCounter(frame.simulation, 'memoriesFaded', result.faded.length);
        return result;
      },
    }),
    system('knowledge.culture', 'knowledge', {
      after: ['knowledge.memory'],
      reads: ['cultures', 'entities', 'memories', 'information'],
      writes: ['cultures', 'entities'],
      enabledBy: 'autoCulture',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = processCultureTick(world, frame.config.culture || {});
        frame.report.cultures = result;
        addCounter(frame.simulation, 'culturesSynced', result.synced.length);
        addCounter(frame.simulation, 'culturesDrifted', result.drifted.length);
        return result;
      },
    }),
    system('knowledge.religion', 'knowledge', {
      after: ['knowledge.culture'],
      reads: ['religions', 'cultures', 'entities'],
      writes: ['religions', 'entities', 'organizations'],
      enabledBy: 'autoReligion',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = processReligionTick(world, frame.config.religion || {});
        frame.report.religions = result;
        addCounter(frame.simulation, 'religionsCreated', result.created.length);
        addCounter(frame.simulation, 'religionConversions', result.spread.length);
        return result;
      },
    }),
    system('civilization.civilization', 'civilization', {
      reads: ['civilizations', 'cities', 'organizations', 'cultures', 'religions'],
      writes: ['civilizations', 'entities', 'organizations'],
      enabledBy: 'autoCivilization',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = processCivilizationTick(world, frame.config.civilization || {});
        frame.report.civilizations = result;
        addCounter(frame.simulation, 'civilizationsCreated', result.created.length);
        addCounter(frame.simulation, 'civilizationsUpdated', result.updated.length);
        return result;
      },
    }),
    system('civilization.technology', 'civilization', {
      after: ['civilization.civilization'],
      reads: ['technology', 'civilizations', 'organizations', 'entities'],
      writes: ['technology', 'civilizations', 'organizations', 'entities'],
      enabledBy: 'autoTechnology',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = processTechnologyTick(world, frame.config.technology || {});
        frame.report.technologies = result;
        addCounter(frame.simulation, 'technologiesInitialized', result.initialized.length);
        addCounter(frame.simulation, 'technologiesResearched', result.researched.length);
        addCounter(frame.simulation, 'technologiesUnlocked', result.unlocked.length);
        return result;
      },
    }),
    system('civilization.infrastructure', 'civilization', {
      after: ['civilization.technology'],
      reads: ['infrastructure', 'technology', 'cities', 'organizations'],
      writes: ['infrastructure', 'cities', 'locations', 'organizations'],
      enabledBy: 'autoInfrastructure',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = processInfrastructureTick(world, frame.config.infrastructure || {});
        frame.report.infrastructure = result;
        addCounter(frame.simulation, 'infrastructurePlanned', result.planned.length);
        addCounter(frame.simulation, 'infrastructureBuilt', result.built.length);
        addCounter(frame.simulation, 'infrastructureMaintained', result.maintained.length);
        addCounter(frame.simulation, 'infrastructureDegraded', result.degraded.length);
        return result;
      },
    }),
    system('civilization.governance', 'civilization', {
      after: ['civilization.infrastructure'],
      reads: ['governance', 'civilizations', 'organizations', 'cities', 'economy'],
      writes: ['governance', 'organizations', 'cities', 'economy', 'entities'],
      enabledBy: 'autoGovernance',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = processGovernanceTick(world, frame.config.governance || {});
        frame.report.governance = result;
        addCounter(frame.simulation, 'governmentsCreated', result.created.length);
        addCounter(frame.simulation, 'governmentsUpdated', result.updated.length);
        addCounter(frame.simulation, 'unrestEvents', result.unrest.length);
        addCounter(frame.simulation, 'taxCollected', result.taxCollected);
        return result;
      },
    }),
    system('civilization.processes', 'civilization', {
      after: ['civilization.governance'],
      reads: ['processes', 'entities', 'organizations', 'civilizations'],
      writes: ['processes', 'entities', 'organizations', 'memory'],
      enabledBy: 'autoProcess',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = processProcessesTick(world, frame.config.process || {});
        frame.report.processes = result;
        addCounter(frame.simulation, 'processesCreated', result.created.length);
        addCounter(frame.simulation, 'processesUpdated', result.updated.length);
        addCounter(frame.simulation, 'processesResolved', result.resolved.length);
        return result;
      },
    }),
    system('civilization.emergence', 'civilization', {
      after: ['civilization.processes'],
      reads: ['emergences', 'processes', 'entities', 'organizations'],
      writes: ['emergences', 'processes', 'memory'],
      enabledBy: 'autoEmergence',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = processEmergenceTick(world, frame.config.emergence || {});
        frame.report.emergences = result;
        addCounter(frame.simulation, 'emergencesDetected', result.detected.length);
        addCounter(frame.simulation, 'emergencesResolved', result.resolved.length);
        return result;
      },
    }),
    system('civilization.conflict', 'civilization', {
      after: ['civilization.emergence'],
      reads: ['conflicts', 'entities', 'organizations', 'governance'],
      writes: ['conflicts', 'entities', 'organizations', 'memory'],
      enabledBy: 'autoConflict',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = processConflictTick(world, frame.config.conflict || {});
        frame.report.conflicts = result;
        addCounter(frame.simulation, 'conflictsCreated', result.created.length);
        addCounter(frame.simulation, 'conflictsEscalated', result.escalated.length);
        addCounter(frame.simulation, 'conflictEvents', result.battles.length);
        addCounter(frame.simulation, 'conflictsResolved', result.resolved.length);
        return result;
      },
    }),
    system('civilization.players', 'civilization', {
      after: ['civilization.conflict'],
      reads: ['players', 'entities'],
      writes: ['players', 'entities'],
      enabledBy: 'autoPlayers',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = processPlayersTick(world, frame.config.player || {});
        frame.report.players = result;
        addCounter(frame.simulation, 'playersChanged', result.changed.length);
        return result;
      },
    }),
    system('finalize.history', 'finalize', {
      reads: ['memory', 'history'],
      writes: ['history'],
      enabledBy: 'autoHistory',
      run: context => {
        const { world, frame } = frameContext(context);
        const result = ingestWorldMemory(world, frame.config.history || {});
        frame.report.history = result;
        addCounter(frame.simulation, 'historyEvents', result.length);
        return result;
      },
    }),
    system('finalize.narrative', 'finalize', {
      after: ['finalize.history'],
      reads: ['entities', 'history', 'narrative'],
      writes: ['narrative'],
      when: context => {
        const frame = context.shared.simulationFrame;
        return Boolean(frame?.config.autoNarrative)
          && shouldRunEvery(context.targetTick, frame.config.narrativeEveryTicks);
      },
      run: context => {
        const { world, frame } = frameContext(context);
        const result = calculateAllNarrativeScores(world, frame.config.narrative || {});
        frame.report.narrative = result;
        return result;
      },
    }),
    system('finalize.novel', 'finalize', {
      after: ['finalize.narrative'],
      reads: ['narrative', 'novels', 'history'],
      writes: ['novels'],
      when: context => {
        const frame = context.shared.simulationFrame;
        return Boolean(frame?.config.autoNovel)
          && shouldRunEvery(context.targetTick, frame.config.novelEveryTicks);
      },
      run: context => {
        const { world, frame } = frameContext(context);
        const result = updateNovelBlueprints(world, frame.config.novel || {});
        frame.report.novels = result;
        return result;
      },
    }),
    system('finalize.report', 'finalize', {
      after: ['finalize.novel'],
      reads: ['simulation', 'memory'],
      writes: ['simulation', 'memory'],
      run: context => {
        const { world, frame } = frameContext(context);
        finalizeSimulationFrame(world, frame);
        context.shared.simulationReport = frame.report;
        return compactSimulationReport(frame.report);
      },
    }),
  ];
}

function runSimulationPipelineTick(world, options = {}, registry = null, schedulerOptions = {}) {
  const frame = createSimulationFrame(world, options);
  const activeRegistry = registry || createSimulationPipelineRegistry();
  const shared = {
    simulationFrame: frame,
    simulationOptions: frame.config,
    simulationReport: null,
  };
  const schedule = runSystemSchedule(world, activeRegistry, {
    ...schedulerOptions,
    tick: frame.report.tickBefore,
    targetTick: frame.report.tickBefore + 1,
    shared,
  });
  if (!shared.simulationReport) throw new Error('Simulation pipeline did not finalize its report');
  return { report: shared.simulationReport, schedule, frame };
}

function createSimulationFrame(world, options = {}) {
  const simulation = ensureSimulationState(world);
  const config = { ...DEFAULT_SIMULATION_OPTIONS, ...(simulation.options || {}), ...(options || {}) };
  return {
    version: SIMULATION_PIPELINE_VERSION,
    simulation,
    config,
    report: createEmptySimulationReport(world),
    finalized: false,
  };
}

function createEmptySimulationReport(world) {
  return {
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
    players: null,
    plans: [],
    world: null,
    history: [],
    narrative: null,
    novels: null,
  };
}

function finalizeSimulationFrame(world, frame) {
  if (!frame || frame.version !== SIMULATION_PIPELINE_VERSION) {
    throw new Error('Invalid simulation pipeline frame');
  }
  if (frame.finalized) return frame.report;
  if (frame.report.tickAfter === null) frame.report.tickAfter = world.tick;
  trimWorldMemory(world, frame.config.maxWorldMemory);
  addCounter(frame.simulation, 'ticks', 1);
  frame.simulation.lastTickReport = compactSimulationReport(frame.report);
  frame.simulation.reports.push(frame.simulation.lastTickReport);
  if (frame.simulation.reports.length > 200) frame.simulation.reports.shift();
  frame.finalized = true;
  return frame.report;
}

function compactSimulationReport(report) {
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
    playersChanged: report.players?.changed?.length || 0,
    plannedActions: report.plans?.length || 0,
    completedActions: report.world?.actions?.completed?.length || 0,
    processedEvents: report.world?.events?.processed?.length || 0,
    historyEvents: report.history?.length || 0,
    narrativeUpdated: Boolean(report.narrative),
    novelsUpdated: Array.isArray(report.novels) ? report.novels.length : 0,
  };
}

function getSimulationPipelineSummary(registry) {
  const analysis = analyzeSystemRegistry(registry || createSimulationPipelineRegistry());
  return {
    version: SIMULATION_PIPELINE_VERSION,
    phases: [...analysis.phases],
    order: [...analysis.order],
    warnings: analysis.warnings,
    systems: analysis.order.length,
  };
}

function system(id, phase, definition) {
  const enabledBy = definition.enabledBy || null;
  const customWhen = definition.when || null;
  return {
    id,
    phase,
    priority: Number(definition.priority || 0),
    after: definition.after || [],
    before: definition.before || [],
    reads: definition.reads || [],
    writes: definition.writes || [],
    tags: ['simulation', phase, ...(definition.tags || [])],
    when: context => {
      const frame = context.shared.simulationFrame;
      if (!frame) return false;
      if (enabledBy && !frame.config[enabledBy]) return false;
      return customWhen ? customWhen(context) : true;
    },
    run: definition.run,
  };
}

function frameContext(context) {
  const frame = context.shared.simulationFrame;
  if (!frame || frame.version !== SIMULATION_PIPELINE_VERSION) {
    throw new Error(`System ${context.system.id} requires a simulation pipeline frame`);
  }
  return { world: context.world, frame };
}

function addCounter(simulation, key, amount) {
  if (simulation.counters[key] === undefined) simulation.counters[key] = 0;
  simulation.counters[key] += Number(amount || 0);
}

function trimWorldMemory(world, limit = 1000) {
  if (!Array.isArray(world.memory)) world.memory = [];
  while (world.memory.length > limit) world.memory.shift();
  return world.memory.length;
}

function countActiveContracts(world) {
  return Object.values(world.contracts?.byId || {})
    .filter(contract => contract.status === 'active')
    .length;
}

function shouldRunEvery(tick, every) {
  if (!every || every <= 0) return false;
  return Number(tick || 0) % Number(every) === 0;
}

module.exports = {
  SIMULATION_PIPELINE_VERSION,
  SIMULATION_PIPELINE_PHASES,
  createSimulationPipelineRegistry,
  createSimulationSystemDefinitions,
  runSimulationPipelineTick,
  createSimulationFrame,
  createEmptySimulationReport,
  finalizeSimulationFrame,
  compactSimulationReport,
  getSimulationPipelineSummary,
};
