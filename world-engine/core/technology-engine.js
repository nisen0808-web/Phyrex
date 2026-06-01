'use strict';

const TECHNOLOGY_STATUS = {
  LOCKED: 'locked',
  RESEARCHING: 'researching',
  UNLOCKED: 'unlocked',
};

const TECHNOLOGY_DOMAINS = {
  AGRICULTURE: 'agriculture',
  MINING: 'mining',
  CRAFT: 'craft',
  TRADE: 'trade',
  GOVERNANCE: 'governance',
  MILITARY: 'military',
  MEDICINE: 'medicine',
  KNOWLEDGE: 'knowledge',
  RELIGION: 'religion',
  INFRASTRUCTURE: 'infrastructure',
};

const DEFAULT_TECHNOLOGIES = {
  irrigation: { domain: 'agriculture', tier: 1, cost: 120, effects: { foodProduction: 0.08 }, prerequisites: [] },
  granary_storage: { domain: 'agriculture', tier: 1, cost: 100, effects: { foodStorage: 0.12 }, prerequisites: [] },
  bronze_working: { domain: 'craft', tier: 1, cost: 160, effects: { craftOutput: 0.08, militaryPower: 0.04 }, prerequisites: [] },
  written_records: { domain: 'knowledge', tier: 1, cost: 140, effects: { research: 0.08, governance: 0.05 }, prerequisites: [] },
  road_building: { domain: 'infrastructure', tier: 1, cost: 120, effects: { trade: 0.08, migration: 0.04 }, prerequisites: [] },
  formal_law: { domain: 'governance', tier: 2, cost: 260, effects: { legitimacy: 0.08, unrestReduction: 0.05 }, prerequisites: ['written_records'] },
  iron_tools: { domain: 'craft', tier: 2, cost: 320, effects: { miningOutput: 0.1, agricultureOutput: 0.08 }, prerequisites: ['bronze_working'] },
  organized_medicine: { domain: 'medicine', tier: 2, cost: 260, effects: { mortalityReduction: 0.08 }, prerequisites: ['written_records'] },
  military_drill: { domain: 'military', tier: 2, cost: 280, effects: { militaryPower: 0.12 }, prerequisites: ['formal_law'] },
  accounting: { domain: 'trade', tier: 2, cost: 240, effects: { taxEfficiency: 0.08, trade: 0.08 }, prerequisites: ['written_records'] },
};

const DEFAULT_TECHNOLOGY_OPTIONS = {
  passiveResearch: 1,
  knowledgeMultiplier: 0.04,
  cultureKnowledgeMultiplier: 0.03,
  organizationResearchMultiplier: 0.5,
  maxResearchPerTick: 80,
};

function ensureTechnologyState(world) {
  if (!world.technologies) {
    world.technologies = {
      definitions: {},
      byCivilization: {},
      indexes: { byDomain: {}, byStatus: {}, byCivilization: {} },
      stats: { registered: 0, unlocked: 0, researchTicks: 0 },
    };
    seedDefaultTechnologies(world);
  }
  return world.technologies;
}

function seedDefaultTechnologies(world) {
  const state = ensureTechnologyState(world);
  if (Object.keys(state.definitions).length) return [];
  return Object.entries(DEFAULT_TECHNOLOGIES).map(([id, input]) => registerTechnology(world, { id, ...input }));
}

function registerTechnology(world, input = {}) {
  if (!input.id) throw new Error('Technology requires id');
  const state = ensureTechnologyState(world);
  const tech = {
    id: input.id,
    name: input.name || humanize(input.id),
    domain: input.domain || TECHNOLOGY_DOMAINS.KNOWLEDGE,
    tier: Number(input.tier || 1),
    cost: Number(input.cost || 100),
    prerequisites: Array.isArray(input.prerequisites) ? [...input.prerequisites] : [],
    effects: { ...(input.effects || {}) },
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
  };
  state.definitions[tech.id] = tech;
  state.stats.registered += 1;
  rebuildTechnologyIndexes(world);
  return tech;
}

function processTechnologyTick(world, options = {}) {
  const config = { ...DEFAULT_TECHNOLOGY_OPTIONS, ...(options || {}) };
  ensureTechnologyState(world);
  const initialized = syncCivilizationTechnologyStates(world);
  const researched = [];
  const unlocked = [];

  for (const civilization of Object.values(world.civilizations?.byId || {})) {
    if (civilization.status === 'collapsed') continue;
    const result = advanceCivilizationResearch(world, civilization.id, config);
    researched.push(...result.researched);
    unlocked.push(...result.unlocked);
  }

  ensureTechnologyState(world).stats.researchTicks += 1;
  rebuildTechnologyIndexes(world);
  return { initialized, researched, unlocked, stats: getTechnologyStats(world) };
}

function syncCivilizationTechnologyStates(world) {
  const state = ensureTechnologyState(world);
  const initialized = [];
  for (const civilization of Object.values(world.civilizations?.byId || {})) {
    if (!state.byCivilization[civilization.id]) {
      state.byCivilization[civilization.id] = {
        civilizationId: civilization.id,
        techs: {},
        activeResearchId: null,
        researchPool: 0,
        modifiers: {},
      };
      initialized.push(civilization.id);
    }
    for (const techId of Object.keys(state.definitions)) {
      if (!state.byCivilization[civilization.id].techs[techId]) {
        state.byCivilization[civilization.id].techs[techId] = {
          technologyId: techId,
          status: TECHNOLOGY_STATUS.LOCKED,
          progress: 0,
          unlockedAt: null,
        };
      }
    }
  }
  return initialized;
}

function advanceCivilizationResearch(world, civilizationId, options = {}) {
  const state = ensureTechnologyState(world);
  const civState = state.byCivilization[civilizationId];
  const civilization = world.civilizations?.byId?.[civilizationId];
  if (!civState || !civilization) return { researched: [], unlocked: [] };
  const researched = [];
  const unlocked = [];
  const researchGain = Math.min(options.maxResearchPerTick, calculateResearchGain(world, civilizationId, options));
  civState.researchPool += researchGain;

  let activeId = civState.activeResearchId;
  if (!activeId || !canResearch(world, civilizationId, activeId)) {
    activeId = chooseNextResearch(world, civilizationId);
    civState.activeResearchId = activeId;
  }
  if (!activeId) return { researched, unlocked };

  const techState = civState.techs[activeId];
  const tech = state.definitions[activeId];
  techState.status = TECHNOLOGY_STATUS.RESEARCHING;
  const used = Math.min(civState.researchPool, tech.cost - techState.progress);
  techState.progress += used;
  civState.researchPool -= used;
  researched.push({ civilizationId, technologyId: activeId, amount: used, progress: techState.progress, cost: tech.cost });

  if (techState.progress >= tech.cost) {
    techState.status = TECHNOLOGY_STATUS.UNLOCKED;
    techState.unlockedAt = world.tick;
    civState.activeResearchId = null;
    state.stats.unlocked += 1;
    applyTechnologyEffects(world, civilizationId, activeId);
    unlocked.push({ civilizationId, technologyId: activeId });
  }
  return { researched, unlocked };
}

function calculateResearchGain(world, civilizationId, options = {}) {
  const civilization = world.civilizations?.byId?.[civilizationId];
  if (!civilization) return 0;
  const cultureKnowledge = civilization.cultureIds
    .map(id => world.cultures?.byId?.[id])
    .filter(Boolean)
    .reduce((sum, culture) => sum + Number(culture.traits?.knowledge || 0), 0);
  const knowledgeSupply = Number(world.economy?.markets?.global?.resources?.knowledge?.supply || 0);
  const researchOrgs = civilization.organizationIds
    .map(id => world.organizations?.byId?.[id])
    .filter(org => ['school', 'sect', 'church', 'company'].includes(org?.type))
    .length;
  return (options.passiveResearch || 1)
    + Number(civilization.metrics?.knowledge || 0) * 0.2
    + cultureKnowledge * (options.cultureKnowledgeMultiplier || 0.03)
    + knowledgeSupply * (options.knowledgeMultiplier || 0.04)
    + researchOrgs * (options.organizationResearchMultiplier || 0.5);
}

function chooseNextResearch(world, civilizationId) {
  const state = ensureTechnologyState(world);
  const civState = state.byCivilization[civilizationId];
  const civilization = world.civilizations?.byId?.[civilizationId];
  if (!civState || !civilization) return null;
  const candidates = Object.values(state.definitions)
    .filter(tech => canResearch(world, civilizationId, tech.id))
    .sort((a, b) => scoreTechnology(world, civilizationId, b) - scoreTechnology(world, civilizationId, a));
  return candidates[0]?.id || null;
}

function canResearch(world, civilizationId, technologyId) {
  const state = ensureTechnologyState(world);
  const civState = state.byCivilization[civilizationId];
  const tech = state.definitions[technologyId];
  const current = civState?.techs?.[technologyId];
  if (!tech || !current || current.status === TECHNOLOGY_STATUS.UNLOCKED) return false;
  return tech.prerequisites.every(id => civState.techs[id]?.status === TECHNOLOGY_STATUS.UNLOCKED);
}

function scoreTechnology(world, civilizationId, tech) {
  const civilization = world.civilizations?.byId?.[civilizationId];
  let score = 100 - tech.cost * 0.05 - tech.tier * 5;
  const values = civilization?.values || [];
  if (values.includes('trade') && tech.domain === 'trade') score += 20;
  if (values.includes('order') && tech.domain === 'governance') score += 20;
  if (values.includes('martial') && tech.domain === 'military') score += 20;
  if (values.includes('knowledge') && tech.domain === 'knowledge') score += 20;
  if (civilization?.metrics?.trade > 100 && tech.domain === 'trade') score += 10;
  if (civilization?.metrics?.military > 100 && tech.domain === 'military') score += 10;
  return score;
}

function applyTechnologyEffects(world, civilizationId, technologyId) {
  const state = ensureTechnologyState(world);
  const tech = state.definitions[technologyId];
  const civilization = world.civilizations?.byId?.[civilizationId];
  if (!tech || !civilization) return null;
  civilization.meta = { ...(civilization.meta || {}) };
  civilization.meta.technologyEffects = civilization.meta.technologyEffects || {};
  for (const [key, value] of Object.entries(tech.effects || {})) {
    civilization.meta.technologyEffects[key] = Number(civilization.meta.technologyEffects[key] || 0) + Number(value || 0);
  }
  for (const cityId of civilization.cityIds || []) {
    const city = world.cities?.byId?.[cityId];
    if (!city) continue;
    city.meta = { ...(city.meta || {}) };
    city.meta.technologyEffects = { ...(city.meta.technologyEffects || {}), ...civilization.meta.technologyEffects };
  }
  return tech;
}

function getCivilizationTechnologies(world, civilizationId) {
  const state = ensureTechnologyState(world);
  const civState = state.byCivilization[civilizationId];
  if (!civState) return [];
  return Object.values(civState.techs).map(item => ({ ...item, definition: state.definitions[item.technologyId] })).sort((a, b) => a.definition.tier - b.definition.tier);
}

function getTechnologyStats(world) {
  const state = ensureTechnologyState(world);
  const civStates = Object.values(state.byCivilization);
  return {
    definitions: Object.keys(state.definitions).length,
    civilizations: civStates.length,
    unlocked: civStates.reduce((sum, civ) => sum + Object.values(civ.techs).filter(t => t.status === TECHNOLOGY_STATUS.UNLOCKED).length, 0),
    researching: civStates.reduce((sum, civ) => sum + Object.values(civ.techs).filter(t => t.status === TECHNOLOGY_STATUS.RESEARCHING).length, 0),
    byDomain: countIndex(state.indexes.byDomain),
  };
}

function rebuildTechnologyIndexes(world) {
  const state = ensureTechnologyState(world);
  state.indexes = { byDomain: {}, byStatus: {}, byCivilization: {} };
  for (const tech of Object.values(state.definitions)) addIndex(state.indexes.byDomain, tech.domain, tech.id);
  for (const [civId, civState] of Object.entries(state.byCivilization)) {
    for (const techState of Object.values(civState.techs || {})) {
      addIndex(state.indexes.byStatus, techState.status, techState.technologyId);
      addIndex(state.indexes.byCivilization, civId, techState.technologyId);
    }
  }
}

function humanize(value) {
  return String(value || '').split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}
function countIndex(index) {
  const out = {};
  for (const [key, value] of Object.entries(index || {})) out[key] = value.length;
  return out;
}
function addIndex(index, key, value) {
  if (!index[key]) index[key] = [];
  if (!index[key].includes(value)) index[key].push(value);
}

module.exports = {
  TECHNOLOGY_STATUS,
  TECHNOLOGY_DOMAINS,
  DEFAULT_TECHNOLOGIES,
  DEFAULT_TECHNOLOGY_OPTIONS,
  ensureTechnologyState,
  seedDefaultTechnologies,
  registerTechnology,
  processTechnologyTick,
  syncCivilizationTechnologyStates,
  advanceCivilizationResearch,
  chooseNextResearch,
  canResearch,
  getCivilizationTechnologies,
  getTechnologyStats,
  rebuildTechnologyIndexes,
};
