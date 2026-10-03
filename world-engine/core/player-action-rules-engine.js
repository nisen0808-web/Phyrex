'use strict';
const { createEvent } = require('./schema');
const { nextWorldId } = require('./world-id-engine');

const { TYPES: ITEM_ACTIONS, planInventoryOperation, applyInventoryOperation } = require('./inventory-operations-engine');
const RULE_VERSION = 1;
const PRIORITY = Object.freeze({ equip_item: 60, unequip_item: 60, use_item: 65, buy_item: 55, sell_item: 55, give_item: 50, move: 70, gather: 50, work: 55, train: 60, rest: 65, interact: 45, transfer: 50, damage: 80 });
const DEFAULT_PLAYER_ACTION_RULES = Object.freeze({ version: RULE_VERSION,
  workResource: 'currency', workYield: 10, workEnergy: 6, gatherYield: 3, gatherEnergy: 4,
  trainingExperience: 2, trainingEnergy: 8, experiencePerPower: 10, trainingPowerCap: 1000,
  restHealth: 12, restEnergy: 20, attackEnergy: 8, moveEnergy: 2, transferEnergy: 1,
  interactEnergy: 2, interactStrength: 3, maxResourceKinds: 128 });
const own = (object, key) => object && Object.hasOwn(object, key) ? object[key] : undefined;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const keyName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200
  && !/[\u0000-\u001f]/.test(value) && !Object.hasOwn(Object.prototype, value);
function normalizePlayerActionRules(input = {}) {
  if (!record(input) || Object.keys(input).some(key => !Object.hasOwn(DEFAULT_PLAYER_ACTION_RULES, key))) throw invalidRules();
  const rules = { ...DEFAULT_PLAYER_ACTION_RULES, ...input };
  if (rules.version !== RULE_VERSION || !keyName(rules.workResource)) throw invalidRules();
  for (const [key, value] of Object.entries(rules)) {
    if (['version', 'workResource'].includes(key)) continue;
    const max = ['trainingPowerCap', 'experiencePerPower'].includes(key) ? 1000000 : key === 'maxResourceKinds' ? 1000 : 100;
    const min = ['restHealth', 'restEnergy'].includes(key) ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw invalidRules();
  }
  return rules;
}
function invalidRules() { return Object.assign(new Error('Invalid player action rules'), { code: 'WORLD_RUNTIME_INVALID_ACTION_RULES' }); }
function getPlayerActionRules(world) { return normalizePlayerActionRules(world.playerActionRules); }
function configurePlayerActionRules(world, input) {
  const rules = normalizePlayerActionRules(input); world.playerActionRules = rules; return { ...rules };
}
function stateOf(entity) {
  const state = entity.playerActionState;
  if (state === undefined) return { version: 1, lastTick: -1, experience: 0 };
  if (!record(state) || state.version !== 1 || !Number.isSafeInteger(state.lastTick) || state.lastTick < -1
      || !Number.isSafeInteger(state.experience) || state.experience < 0 || state.experience > 1000000000) return null;
  return { version: 1, lastTick: state.lastTick, experience: state.experience };
}
function safeNumber(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }
function resourceValue(entity, resource) { const value = own(entity.resources, resource); return value === undefined ? 0 : value; }
function canReceive(entity, resource, amount, rules) {
  if (!safeNumber(resourceValue(entity, resource)) || !safeNumber(resourceValue(entity, resource) + amount)) return false;
  return own(entity.resources, resource) !== undefined || Object.keys(entity.resources || {}).length < rules.maxResourceKinds;
}
function preparePlayerAction(world, entity, type, payload = {}, rules = getPlayerActionRules(world)) {
  if (!Object.hasOwn(PRIORITY, type)) return { reason: 'unknown_action' };
  if (!record(payload)) return { reason: 'invalid_payload' };
  if (!entity || entity.status !== 'alive') return { reason: 'actor_not_alive' };
  if (!stateOf(entity) || !['energy', 'maxEnergy', 'health', 'maxHealth', 'power', 'defense'].every(key => safeNumber(entity.stats?.[key]))) return { reason: 'invalid_actor_state' };
  if (entity.stats.health === 0 || entity.stats.maxHealth === 0) return { reason: 'invalid_actor_state' };
  if (payload.priority !== undefined && payload.priority !== PRIORITY[type]) return { reason: 'server_controlled_parameter' };
  let energyCost = { equip_item: 0, unequip_item: 0, use_item: 0, buy_item: 0, sell_item: 0, give_item: 0, work: rules.workEnergy, gather: rules.gatherEnergy, train: rules.trainingEnergy,
    damage: rules.attackEnergy, move: rules.moveEnergy, transfer: rules.transferEnergy, interact: rules.interactEnergy, rest: 0 }[type];
  if (payload.energyCost !== undefined && payload.energyCost !== energyCost) return { reason: 'server_controlled_parameter' };
  const intent = {}, terms = { energyCost };
  if (ITEM_ACTIONS.includes(type)) {
    const plan = planInventoryOperation(world, entity, type, payload);
    if (plan.reason) return { reason: plan.reason };
    Object.assign(intent, payload); terms.inventory = plan;
  }
  if (type === 'move') {
    const to = payload.locationId;
    if (!own(world.locations, to)) return { reason: 'missing_location' };
    if (!world.locations[entity.locationId]?.neighbors?.includes(to)) return { reason: 'not_neighbors' };
    intent.locationId = to;
  }
  if (['work', 'gather', 'transfer'].includes(type)) {
    const resource = payload.resource || (type === 'gather' ? 'food' : rules.workResource);
    if (!keyName(resource)) return { reason: 'invalid_resource' };
    if (type === 'work' && resource !== rules.workResource) return { reason: 'work_resource_not_allowed' };
    const maximum = type === 'work' ? rules.workYield : type === 'gather' ? rules.gatherYield : 1000000;
    const amount = payload.amount ?? (type === 'transfer' ? 1 : maximum);
    if (!safeNumber(amount) || amount <= 0 || amount > maximum) return { reason: 'invalid_quantity' };
    intent.resource = resource; intent.amount = amount;
    if (type === 'gather') {
      const stock = own(world.locations[entity.locationId]?.resources, resource);
      if (!safeNumber(stock) || stock === 0) return { reason: 'resource_unavailable' };
      terms.amount = Math.min(stock, amount);
    } else terms.amount = amount;
    if (type !== 'transfer' && !canReceive(entity, resource, terms.amount, rules)) return { reason: 'resource_capacity' };
    if (type === 'transfer' && (!safeNumber(resourceValue(entity, resource)) || resourceValue(entity, resource) < amount)) return { reason: 'insufficient_resource' };
  }
  if (['interact', 'transfer', 'damage'].includes(type)) {
    const target = own(world.entities, payload.targetId);
    if (!target) return { reason: 'missing_target' };
    if (target.id === entity.id) return { reason: 'self_target' };
    if (target.status !== 'alive') return { reason: 'target_not_alive' };
    if (!entity.locationId || target.locationId !== entity.locationId) return { reason: 'target_not_at_location' };
    intent.targetId = target.id;
    if (type === 'transfer' && !canReceive(target, intent.resource, terms.amount, rules)) return { reason: 'resource_capacity' };
    if (type === 'damage') {
      if (!['health', 'maxHealth', 'defense'].every(key => safeNumber(target.stats?.[key]))) return { reason: 'invalid_target_state' };
      if (target.stats.health === 0 || target.stats.maxHealth === 0) return { reason: 'invalid_target_state' };
      const damage = Math.max(1, Math.floor(entity.stats.power - target.stats.defense));
      if (entity.stats.power <= 0) return { reason: 'no_attack_power' };
      if (payload.amount !== undefined && (!safeNumber(payload.amount) || payload.amount <= 0 || payload.amount > damage)) return { reason: 'invalid_quantity' };
      if (payload.lethal !== undefined && typeof payload.lethal !== 'boolean') return { reason: 'invalid_boolean' };
      intent.lethal = payload.lethal !== false;
      if (payload.amount !== undefined) intent.amount = payload.amount;
      terms.damage = Math.min(payload.amount ?? damage, Math.max(0, target.stats.health - (intent.lethal ? 0 : 1)));
    }
    if (type === 'interact') {
      if (payload.effect !== undefined && payload.effect !== 'social') return { reason: 'invalid_effect' };
      const amount = payload.amount ?? rules.interactStrength;
      if (!safeNumber(amount) || amount <= 0 || amount > rules.interactStrength) return { reason: 'invalid_quantity' };
      intent.amount = amount;
    }
  }
  if (type === 'rest') {
    if ((payload.health !== undefined && payload.health !== rules.restHealth) || (payload.energy !== undefined && payload.energy !== rules.restEnergy)) return { reason: 'server_controlled_parameter' };
  }
  if (type === 'train') {
    if (payload.power !== undefined) return { reason: 'server_controlled_parameter' };
    const xp = payload.amount ?? rules.trainingExperience, previous = stateOf(entity).experience;
    if (!Number.isSafeInteger(xp) || xp <= 0 || xp > rules.trainingExperience) return { reason: 'invalid_quantity' };
    if (previous + xp > 1000000000 || entity.stats.power >= rules.trainingPowerCap) return { reason: 'training_cap' };
    intent.amount = xp; terms.experience = previous + xp;
    terms.powerGain = Math.min(rules.trainingPowerCap - entity.stats.power,
      Math.floor((previous + xp) / rules.experiencePerPower) - Math.floor(previous / rules.experiencePerPower));
  }
  if (entity.stats.energy < energyCost) return { reason: 'insufficient_energy' };
  return { action: { type, actorId: entity.id, targetId: intent.targetId || (type === 'move' ? intent.locationId : null),
    duration: 1, priority: PRIORITY[type], payload: intent }, terms };
}
function applyPlayerRuleAction(world, action, entity, options = {}) {
  const failure = reason => ({ status: 'failed', actionId: action.id, type: action.type, reason });
  if (!entity) return failure('missing_actor');
  if (action.playerActionRuleVersion !== RULE_VERSION || action.remaining !== 1) return failure('invalid_rule_action');
  const state = stateOf(entity);
  if (!state) return failure('invalid_actor_state');
  if (state.lastTick >= world.tick) return failure('action_budget_exhausted');
  const rules = getPlayerActionRules(world), prepared = preparePlayerAction(world, entity, action.type, action.payload, rules);
  if (prepared.reason) return failure(prepared.reason);
  const { terms } = prepared, p = prepared.action.payload, type = action.type;
  let value, eventType, participants = [entity.id], locationId = entity.locationId;
  if (ITEM_ACTIONS.includes(type)) {
    value = applyInventoryOperation(world, terms.inventory); eventType = `inventory.${type}`;
  } else if (type === 'move') {
    value = { moved: true, from: entity.locationId, to: p.locationId }; entity.locationId = p.locationId;
    locationId = p.locationId; eventType = 'entity.moved';
  } else if (type === 'work' || type === 'gather') {
    if (type === 'gather') world.locations[entity.locationId].resources[p.resource] -= terms.amount;
    entity.resources[p.resource] = resourceValue(entity, p.resource) + terms.amount;
    value = { resource: p.resource, amount: terms.amount }; eventType = type === 'work' ? 'entity.worked' : 'resource.gathered';
  } else if (type === 'train') {
    state.experience = terms.experience; entity.stats.power += terms.powerGain;
    value = { experience: state.experience, gainedExperience: p.amount, power: entity.stats.power, powerGain: terms.powerGain };
    eventType = 'entity.trained';
  } else if (type === 'rest') {
    const health = Math.min(rules.restHealth, Math.max(0, entity.stats.maxHealth - entity.stats.health));
    const energy = Math.min(rules.restEnergy, Math.max(0, entity.stats.maxEnergy - entity.stats.energy));
    entity.stats.health += health; entity.stats.energy += energy;
    value = { health: entity.stats.health, energy: entity.stats.energy, healthGain: health, energyGain: energy }; eventType = 'entity.rested';
  } else {
    const target = world.entities[p.targetId]; participants.push(target.id);
    if (type === 'transfer') {
      entity.resources[p.resource] -= terms.amount; target.resources[p.resource] = resourceValue(target, p.resource) + terms.amount;
      value = { targetId: target.id, resource: p.resource, amount: terms.amount }; eventType = 'resource.transferred';
    } else if (type === 'damage') {
      target.stats.health -= terms.damage;
      if (target.stats.health === 0) target.status = 'dead';
      value = { targetId: target.id, amount: terms.damage, targetStatus: target.status, targetHealth: target.stats.health };
      eventType = 'entity.damaged';
    } else {
      value = { targetId: target.id, effect: 'social', amount: p.amount }; eventType = 'entity.interacted';
    }
  }
  entity.stats.energy -= terms.energyCost;
  state.lastTick = world.tick; entity.playerActionState = state;
  action.remaining = 0;
  value.energyCost = terms.energyCost;
  const event = { type: eventType, actorIds: participants, locationId, payload: value, actionId: action.id };
  if (options.emitEvent) options.emitEvent(world, event);
  else world.events.push(createEvent({ ...event, id: nextWorldId(world, 'event', 'action.event'), tick: world.tick }));
  return { status: 'completed', actionId: action.id, type, result: value };
}
module.exports = { RULE_VERSION, PRIORITY, DEFAULT_PLAYER_ACTION_RULES, normalizePlayerActionRules,
  getPlayerActionRules, configurePlayerActionRules, preparePlayerAction, applyPlayerRuleAction, stateOf };
