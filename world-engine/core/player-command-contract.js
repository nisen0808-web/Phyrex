'use strict';

// Public command values are data, never coercible numbers or dictionary prototypes.
const { DEFAULT_GOAL_TEMPLATES } = require('./goal-engine');
const { DEFAULT_SPECIES } = require('./species-engine');
const RESERVED = new Set(Object.getOwnPropertyNames(Object.prototype));
const COMMAND_FIELDS = Object.freeze({
  wait: ['ticks'], move: ['locationId', 'priority'], gather: ['resource', 'amount', 'priority'],
  work: ['resource', 'amount', 'energyCost', 'priority'], train: ['amount', 'energyCost', 'power', 'priority'],
  rest: ['health', 'energy', 'priority'], interact: ['targetId', 'effect', 'amount', 'priority'],
  transfer: ['targetId', 'resource', 'amount', 'priority'], damage: ['targetId', 'amount', 'lethal', 'priority'],
  join_organization: ['organizationId', 'role', 'createContract'],
  set_goal: ['goalType', 'type', 'priority', 'payload'],
  create_character: ['name', 'species', 'locationId', 'sex', 'active'],
  switch_character: ['entityId'], observe: ['locationId'], inspect: ['targetType', 'targetId'],
});
const MAX_PLAYER_CHARACTERS = 100;
const MAX_ACTIVE_PLAYER_GOALS = 100;
const MAX_PENDING_PLAYER_ACTIONS = 100;
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function identifier(value, max = 256) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !/[\u0000-\u001f]/.test(value) && !RESERVED.has(value);
}
function own(map, key) { return map && Object.hasOwn(map, key) ? map[key] : undefined; }
function finiteData(value, depth = 0, budget = { left: 10000 }, seen = new Set()) {
  if (--budget.left < 0 || depth > 20) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  seen.add(value);
  const ok = Object.keys(value).every(key => !RESERVED.has(key)
    && ((!Array.isArray(value) && value[key] === undefined) || finiteData(value[key], depth + 1, budget, seen)));
  seen.delete(value);
  return ok;
}
function numeric(value, min, max, integer = false) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    && (!integer || Number.isSafeInteger(value));
}
function validateCommand(command, world, options = {}) {
  if (!identifier(command.playerId) || !identifier(command.id)) return 'invalid_identifier';
  const fields = own(COMMAND_FIELDS, command.type);
  if (!fields) return 'unknown_command';
  const p = command.payload;
  if (!record(p) || !finiteData(p)) return 'invalid_payload';
  if (options.publicPlayer && Object.keys(p).some(key => !fields.includes(key))) return 'unsupported_field';
  for (const key of ['locationId', 'targetId', 'organizationId', 'entityId', 'resource', 'effect', 'role', 'goalType', 'species']) {
    if (p[key] !== undefined && !(command.type === 'observe' && key === 'locationId' && p[key] === null)
        && !identifier(p[key], 200)) return 'invalid_identifier';
  }
  for (const key of ['active', 'lethal', 'createContract']) if (p[key] !== undefined && typeof p[key] !== 'boolean') return 'invalid_boolean';
  if (p.priority !== undefined && !numeric(p.priority, 0, 100)) return 'invalid_number';
  const bounds = { amount: [0, command.type === 'transfer' ? 1000000 : 100], energyCost: [0, 100],
    health: [0, 100], energy: [0, 100], power: [0, 1000000], ticks: [1, 1000] };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (p[key] !== undefined && !numeric(p[key], min, options.publicPlayer ? max : Number.MAX_SAFE_INTEGER, key === 'ticks')) return 'invalid_number';
  }
  if (p.name !== undefined && !identifier(p.name, 100)) return 'invalid_name';
  if (p.sex !== undefined && !['male', 'female', 'unknown'].includes(p.sex)) return 'invalid_sex';
  if (p.targetType !== undefined && !['world', 'entity', 'location', 'player', 'organization'].includes(p.targetType)) return 'invalid_target_type';
  if (command.type === 'create_character') {
    const species = p.species || options.player?.defaultSpecies || 'human';
    if (!own(world.species?.byId || DEFAULT_SPECIES, species)) return 'missing_species';
    const location = p.locationId || options.player?.defaultLocationId || Object.keys(world.locations || {})[0];
    if (location && !own(world.locations, location)) return 'missing_location';
    if (options.publicPlayer && !location) return 'missing_location';
    if (options.publicPlayer && (own(world.players?.byId, command.playerId)?.controlledEntityIds.length || 0) >= MAX_PLAYER_CHARACTERS) return 'character_limit';
  }
  if (command.type === 'join_organization' && options.publicPlayer && p.role !== undefined && !['member', 'student'].includes(p.role)) return 'invalid_role';
  if (command.type === 'set_goal') {
    const type = p.goalType || p.type || 'gain_resources';
    if (!own(DEFAULT_GOAL_TEMPLATES, type)) return 'invalid_goal';
    const g = p.payload || {};
    if (!record(g)) return 'invalid_goal';
    if (options.publicPlayer && Object.keys(g).some(key => !['resource', 'amount', 'power', 'targetLocationId', 'cityId', 'targetRisk'].includes(key))) return 'invalid_goal';
    for (const key of ['amount', 'power']) if (g[key] !== undefined && !numeric(g[key], 0, 1000000)) return 'invalid_goal';
    if (g.targetRisk !== undefined && !numeric(g.targetRisk, 0, 1)) return 'invalid_goal';
    for (const key of ['resource', 'targetLocationId', 'cityId']) if (g[key] !== undefined && !identifier(g[key])) return 'invalid_goal';
    if (g.targetLocationId !== undefined && !own(world.locations, g.targetLocationId)) return 'missing_location';
    if (g.cityId !== undefined && !own(world.cities?.byId, g.cityId)) return 'missing_city';
  }
  return null;
}
module.exports = { COMMAND_FIELDS, MAX_PLAYER_CHARACTERS, MAX_ACTIVE_PLAYER_GOALS, MAX_PENDING_PLAYER_ACTIONS,
  record, identifier, own, finiteData, numeric, validateCommand };
