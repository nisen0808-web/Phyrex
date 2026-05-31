'use strict';

const { changeRelationship } = require('./relationship-engine');
const { recordLifeEvent, LIFE_EVENT_TYPES } = require('./history-engine');
const { getSpecies } = require('./species-engine');

const CONTRACT_STATUS = {
  ACTIVE: 'active',
  COMPLETED: 'completed',
  BROKEN: 'broken',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
};

const CONTRACT_TYPES = {
  EMPLOYMENT: 'employment',
  APPRENTICESHIP: 'apprenticeship',
  SERVICE: 'service',
  BOND: 'bond',
  VASSALAGE: 'vassalage',
  DOMESTICATION: 'domestication',
  ALLIANCE: 'alliance',
  MARRIAGE: 'marriage',
};

const DEFAULT_CONTRACT_TEMPLATES = {
  employment: {
    title: 'Employment Contract',
    controllerRole: 'employer',
    subjectRole: 'worker',
    authority: 25,
    protection: 10,
    obligations: ['work'],
    rights: ['wage', 'shelter'],
    defaultDuration: 720,
  },
  apprenticeship: {
    title: 'Apprenticeship Contract',
    controllerRole: 'mentor',
    subjectRole: 'student',
    authority: 35,
    protection: 20,
    obligations: ['study', 'assist'],
    rights: ['training', 'shelter'],
    defaultDuration: 7200,
  },
  service: {
    title: 'Service Contract',
    controllerRole: 'patron',
    subjectRole: 'servant',
    authority: 45,
    protection: 25,
    obligations: ['serve', 'obey'],
    rights: ['shelter', 'food', 'protection'],
    defaultDuration: 3600,
  },
  bond: {
    title: 'Bond Contract',
    controllerRole: 'holder',
    subjectRole: 'bonded',
    authority: 70,
    protection: 15,
    obligations: ['obey', 'labor'],
    rights: ['survival_support'],
    defaultDuration: null,
  },
  vassalage: {
    title: 'Vassalage Contract',
    controllerRole: 'lord',
    subjectRole: 'vassal',
    authority: 55,
    protection: 45,
    obligations: ['tribute', 'service'],
    rights: ['protection', 'land_access'],
    defaultDuration: null,
  },
  domestication: {
    title: 'Domestication Bond',
    controllerRole: 'keeper',
    subjectRole: 'companion',
    authority: 60,
    protection: 35,
    obligations: ['follow', 'assist'],
    rights: ['food', 'shelter', 'protection'],
    defaultDuration: null,
  },
  alliance: {
    title: 'Alliance Pact',
    controllerRole: 'ally',
    subjectRole: 'ally',
    authority: 10,
    protection: 35,
    obligations: ['support'],
    rights: ['support'],
    defaultDuration: 7200,
  },
  marriage: {
    title: 'Marriage Contract',
    controllerRole: 'partner',
    subjectRole: 'partner',
    authority: 5,
    protection: 30,
    obligations: ['household', 'support'],
    rights: ['support', 'family_membership'],
    defaultDuration: null,
  },
};

function ensureContractState(world) {
  if (!world.contracts) {
    world.contracts = {
      byId: {},
      indexes: {
        byEntity: {},
        byController: {},
        bySubject: {},
        byType: {},
        byStatus: {},
      },
      stats: {
        created: 0,
        completed: 0,
        broken: 0,
        cancelled: 0,
        expired: 0,
      },
    };
  }
  return world.contracts;
}

function createContract(world, input = {}) {
  if (!input.type) throw new Error('Contract requires type');
  if (!input.controllerId) throw new Error('Contract requires controllerId');
  if (!input.subjectId) throw new Error('Contract requires subjectId');
  if (!world.entities[input.controllerId]) throw new Error(`Missing controller ${input.controllerId}`);
  if (!world.entities[input.subjectId]) throw new Error(`Missing subject ${input.subjectId}`);

  const template = DEFAULT_CONTRACT_TEMPLATES[input.type] || {};
  const id = input.id || `contract_${world.tick}_${Math.random().toString(16).slice(2)}`;
  const duration = input.durationTicks ?? template.defaultDuration ?? null;
  const contract = {
    id,
    type: input.type,
    title: input.title || template.title || input.type,
    status: CONTRACT_STATUS.ACTIVE,
    controllerId: input.controllerId,
    subjectId: input.subjectId,
    controllerRole: input.controllerRole || template.controllerRole || 'controller',
    subjectRole: input.subjectRole || template.subjectRole || 'subject',
    authority: Number(input.authority ?? template.authority ?? 0),
    protection: Number(input.protection ?? template.protection ?? 0),
    obligations: Array.isArray(input.obligations) ? [...input.obligations] : [...(template.obligations || [])],
    rights: Array.isArray(input.rights) ? [...input.rights] : [...(template.rights || [])],
    createdAt: world.tick,
    expiresAt: duration === null ? null : world.tick + duration,
    completedAt: null,
    brokenAt: null,
    terms: { ...(input.terms || {}) },
    metrics: {
      compliance: 100,
      satisfaction: 50,
      dependency: Number(input.dependency || 0),
    },
    history: [],
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    meta: { ...(input.meta || {}) },
  };

  ensureContractState(world).byId[id] = contract;
  ensureContractState(world).stats.created += 1;
  applyContractRelationshipEffects(world, contract, 'created');
  recordContractMemory(world, contract, 'contract.created', {});
  recordContractLifeEvents(world, contract, 'created');
  rebuildContractIndexes(world);
  return contract;
}

function processContractsTick(world, options = {}) {
  const state = ensureContractState(world);
  const changed = [];
  for (const contract of Object.values(state.byId)) {
    if (contract.status !== CONTRACT_STATUS.ACTIVE) continue;
    updateContractMetrics(world, contract, options);
    if (contract.expiresAt !== null && world.tick >= contract.expiresAt) {
      expireContract(world, contract.id, 'duration_elapsed');
      changed.push(contract);
      continue;
    }
    if (contract.metrics.compliance <= 0) {
      breakContract(world, contract.id, 'compliance_failed');
      changed.push(contract);
      continue;
    }
    if (contract.metrics.satisfaction <= -50) {
      breakContract(world, contract.id, 'subject_revolt');
      changed.push(contract);
    }
  }
  rebuildContractIndexes(world);
  return changed;
}

function updateContractMetrics(world, contract, options = {}) {
  const controller = world.entities[contract.controllerId];
  const subject = world.entities[contract.subjectId];
  if (!controller || !subject || controller.status !== 'alive' || subject.status !== 'alive') {
    contract.metrics.compliance -= 30;
    return contract.metrics;
  }

  const relationKey = `${contract.subjectId}->${contract.controllerId}`;
  const relation = world.relationships[relationKey] || {};
  const loyalty = Number(relation.loyalty || 0);
  const fear = Number(relation.fear || 0);
  const hatred = Number(relation.hatred || 0);
  const trust = Number(relation.trust || 0);

  contract.metrics.compliance = clamp(contract.metrics.compliance + (loyalty + fear + trust - hatred) * 0.01, 0, 100);
  contract.metrics.satisfaction = clamp(contract.metrics.satisfaction + (trust + contract.protection - contract.authority - hatred) * 0.01, -100, 100);
  contract.metrics.dependency = clamp(contract.metrics.dependency + contract.protection * 0.002, 0, 100);
  return contract.metrics;
}

function completeContract(world, contractId, reason = 'completed') {
  const contract = getContract(world, contractId);
  if (!contract) throw new Error(`Missing contract ${contractId}`);
  contract.status = CONTRACT_STATUS.COMPLETED;
  contract.completedAt = world.tick;
  ensureContractState(world).stats.completed += 1;
  applyContractRelationshipEffects(world, contract, 'completed');
  recordContractMemory(world, contract, 'contract.completed', { reason });
  rebuildContractIndexes(world);
  return contract;
}

function breakContract(world, contractId, reason = 'broken') {
  const contract = getContract(world, contractId);
  if (!contract) throw new Error(`Missing contract ${contractId}`);
  contract.status = CONTRACT_STATUS.BROKEN;
  contract.brokenAt = world.tick;
  ensureContractState(world).stats.broken += 1;
  applyContractRelationshipEffects(world, contract, 'broken');
  recordContractMemory(world, contract, 'contract.broken', { reason });
  recordContractLifeEvents(world, contract, 'broken');
  rebuildContractIndexes(world);
  return contract;
}

function cancelContract(world, contractId, reason = 'cancelled') {
  const contract = getContract(world, contractId);
  if (!contract) throw new Error(`Missing contract ${contractId}`);
  contract.status = CONTRACT_STATUS.CANCELLED;
  contract.completedAt = world.tick;
  ensureContractState(world).stats.cancelled += 1;
  recordContractMemory(world, contract, 'contract.cancelled', { reason });
  rebuildContractIndexes(world);
  return contract;
}

function expireContract(world, contractId, reason = 'expired') {
  const contract = getContract(world, contractId);
  if (!contract) throw new Error(`Missing contract ${contractId}`);
  contract.status = CONTRACT_STATUS.EXPIRED;
  contract.completedAt = world.tick;
  ensureContractState(world).stats.expired += 1;
  applyContractRelationshipEffects(world, contract, 'expired');
  recordContractMemory(world, contract, 'contract.expired', { reason });
  rebuildContractIndexes(world);
  return contract;
}

function applyContractRelationshipEffects(world, contract, phase) {
  if (phase === 'created') {
    changeRelationship(world, contract.subjectId, contract.controllerId, {
      loyalty: contract.protection * 0.15,
      fear: contract.authority * 0.08,
      trust: contract.protection * 0.08,
    }, { reason: 'contract.created' });
    changeRelationship(world, contract.controllerId, contract.subjectId, {
      loyalty: contract.authority * 0.05,
      trust: contract.protection * 0.05,
    }, { reason: 'contract.created' });
  }

  if (phase === 'completed' || phase === 'expired') {
    changeRelationship(world, contract.subjectId, contract.controllerId, {
      trust: 8,
      loyalty: 5,
      debt: -5,
    }, { reason: `contract.${phase}` });
  }

  if (phase === 'broken') {
    changeRelationship(world, contract.subjectId, contract.controllerId, {
      trust: -20,
      hatred: 15,
      loyalty: -15,
    }, { reason: 'contract.broken' });
    changeRelationship(world, contract.controllerId, contract.subjectId, {
      trust: -12,
      hatred: 8,
    }, { reason: 'contract.broken' });
  }
}

function createDomesticationContract(world, controllerId, subjectId, input = {}) {
  const controller = world.entities[controllerId];
  const subject = world.entities[subjectId];
  if (!controller || !subject) throw new Error('Missing domestication participant');
  const controllerSpecies = getSpecies(world, controller.species || 'human');
  const subjectSpecies = getSpecies(world, subject.species || 'human');
  if (!controllerSpecies.domestication.canDomesticate && input.force !== true) {
    throw new Error(`${controllerSpecies.id} cannot create domestication contracts`);
  }
  if (!subjectSpecies.domestication.canBeDomesticated && input.force !== true) {
    throw new Error(`${subjectSpecies.id} cannot be domesticated by default`);
  }
  return createContract(world, {
    ...input,
    type: CONTRACT_TYPES.DOMESTICATION,
    controllerId,
    subjectId,
    tags: [...(input.tags || []), 'domestication'],
  });
}

function getContract(world, contractId) {
  return ensureContractState(world).byId[contractId] || null;
}

function getEntityContracts(world, entityId, options = {}) {
  const state = ensureContractState(world);
  const ids = state.indexes.byEntity[entityId] || [];
  return ids
    .map(id => state.byId[id])
    .filter(Boolean)
    .filter(contract => !options.status || contract.status === options.status);
}

function getPowerScore(world, entityId) {
  const contracts = getEntityContracts(world, entityId, { status: CONTRACT_STATUS.ACTIVE });
  let controlled = 0;
  let obligated = 0;
  let protection = 0;
  for (const contract of contracts) {
    if (contract.controllerId === entityId) {
      controlled += contract.authority;
      protection += contract.protection * 0.4;
    }
    if (contract.subjectId === entityId) {
      obligated += contract.authority;
      protection += contract.protection;
    }
  }
  return { entityId, controlled, obligated, protection, netPower: controlled + protection - obligated };
}

function recordContractMemory(world, contract, type, payload = {}) {
  const memory = {
    id: `contract_memory_${world.tick}_${contract.history.length + 1}`,
    tick: world.tick,
    type,
    payload: { contractId: contract.id, controllerId: contract.controllerId, subjectId: contract.subjectId, ...payload },
  };
  contract.history.push(memory);
  if (contract.history.length > 200) contract.history.shift();
  return memory;
}

function recordContractLifeEvents(world, contract, phase) {
  const controller = world.entities[contract.controllerId];
  const subject = world.entities[contract.subjectId];
  const title = phase === 'created' ? `entered ${contract.type} contract` : `${contract.type} contract ${phase}`;
  for (const entity of [controller, subject]) {
    if (!entity) continue;
    recordLifeEvent(world, {
      entityId: entity.id,
      type: LIFE_EVENT_TYPES.WORLD_EVENT,
      title,
      summary: `${entity.name || entity.id} was part of ${contract.title}.`,
      importance: Math.max(20, contract.authority + contract.protection),
      participants: [contract.controllerId, contract.subjectId],
      locationId: entity.locationId,
      tags: ['contract', contract.type, phase],
      payload: { contractId: contract.id, role: entity.id === contract.controllerId ? contract.controllerRole : contract.subjectRole },
    });
  }
}

function rebuildContractIndexes(world) {
  const state = ensureContractState(world);
  state.indexes = { byEntity: {}, byController: {}, bySubject: {}, byType: {}, byStatus: {} };
  for (const contract of Object.values(state.byId)) {
    addIndex(state.indexes.byEntity, contract.controllerId, contract.id);
    addIndex(state.indexes.byEntity, contract.subjectId, contract.id);
    addIndex(state.indexes.byController, contract.controllerId, contract.id);
    addIndex(state.indexes.bySubject, contract.subjectId, contract.id);
    addIndex(state.indexes.byType, contract.type, contract.id);
    addIndex(state.indexes.byStatus, contract.status, contract.id);
  }
}

function addIndex(index, key, value) {
  if (!index[key]) index[key] = [];
  if (!index[key].includes(value)) index[key].push(value);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

module.exports = {
  CONTRACT_STATUS,
  CONTRACT_TYPES,
  DEFAULT_CONTRACT_TEMPLATES,
  ensureContractState,
  createContract,
  createDomesticationContract,
  processContractsTick,
  completeContract,
  breakContract,
  cancelContract,
  expireContract,
  getContract,
  getEntityContracts,
  getPowerScore,
  rebuildContractIndexes,
};
