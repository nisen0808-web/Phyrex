'use strict';

const { DEFAULT_SPECIES } = require('./species-engine');
const { buildWorldFromDefinition } = require('./world-template-engine');
const { createPlayer } = require('./player-engine');
const { initializeDeterministicSimulation } = require('./deterministic-simulation-engine');
const { ENGINE_V1_PROFILE } = require('../runtime/engine-v1-profile');
const { normalizePlayerActionRules, configurePlayerActionRules } = require('./player-action-rules-engine');
const { digest } = require('../storage/postgres/codec');

const MAX_TEMPLATE_BYTES = 1024 * 1024;
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)
  && !Object.hasOwn(Object.prototype, value) && value !== 'prototype';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const messages = {
  invalid_json: '只接受有限数值与普通 JSON 数据，不能包含循环引用或特殊属性。',
  capacity: '超过此字段允许的容量。', object: '此字段必须是对象。', array: '此字段必须是数组。',
  unknown_field: '包含当前正式模板入口不支持的字段。', identifier: '编号须为 1–128 位字母、数字、下划线、点或短横线，并以字母或数字开头。',
  text: '此字段必须是长度合规的非空文本。', number: '数值类型或范围不符合要求。',
  duplicate: '编号、成员或连接重复。', reference: '引用的地点、人物或组织不存在。',
  value: '此字段的值不受支持。', selection: '请明确选择模板包中的一个模板编号。',
  rules: '行动规则不符合引擎现有的服务端约束。',
};

// This strict entry point is separate from the historical, trusted-host template
// builder. Validate the entire pack before constructing any candidate world.
function inspectEngineTemplate(input, options = {}) {
  const issues = [];
  const issue = (path, code) => { if (issues.length < 64) issues.push({ path, code, message: messages[code] }); };
  let nodes = 0;
  const ancestors = new Set();
  function json(value, depth = 0) {
    if (++nodes > 100000 || depth > 16) return false;
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || ancestors.has(value)) return false;
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value) && (Object.keys(descriptors).length !== value.length + 1
        || Object.keys(descriptors).some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) return false;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = descriptors[key];
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)
          || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || !json(descriptor.value, depth + 1)) return false;
    }
    ancestors.delete(value);
    return true;
  }
  if (!json(input)) return { valid: false, issues: [{ path: '$', code: 'invalid_json', message: messages.invalid_json }] };
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_TEMPLATE_BYTES) {
    return { valid: false, issues: [{ path: '$', code: 'capacity', message: messages.capacity }] };
  }
  function object(value, path, keys) {
    if (!record(value)) { issue(path, 'object'); return false; }
    if (Object.keys(value).some(key => !keys.includes(key))) issue(path, 'unknown_field');
    return true;
  }
  function array(value, path, limit, min = 0) {
    if (!Array.isArray(value)) { issue(path, 'array'); return []; }
    if (value.length < min || value.length > limit) { issue(path, 'capacity'); return value.slice(0, limit); }
    return value;
  }
  const id = (value, path) => { if (!identifier(value)) issue(path, 'identifier'); };
  const text = (value, path, max = 256) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) issue(path, 'text'); };
  const number = (value, path, min = 0, max = 1000000, integer = false) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) issue(path, 'number');
  };
  const optional = (value, path, fn) => { if (value !== undefined) fn(value, path); };
  function strings(value, path, max = 32) { array(value, path, max).forEach((row, i) => text(row, `${path}[${i}]`, 128)); }
  function numbers(value, path, max = 1000000, allowed) {
    if (!record(value)) { issue(path, 'object'); return; }
    const entries = Object.entries(value);
    if (entries.length > 128) issue(path, 'capacity');
    entries.slice(0, 128).forEach(([key, val], i) => {
      id(key, `${path}[${i}]`); number(val, `${path}[${i}]`, 0, max);
      if (allowed && !allowed.includes(key)) issue(path, 'unknown_field');
    });
  }
  function uniqueIds(rows, path, getId = row => row.id) {
    const ids = new Set();
    rows.forEach((row, i) => { const value = record(row) ? getId(row) : undefined; id(value, `${path}[${i}].id`);
      if (ids.has(value)) issue(`${path}[${i}].id`, 'duplicate'); ids.add(value); });
    return ids;
  }
  const reference = (value, path, ids) => { id(value, path); if (!ids.has(value)) issue(path, 'reference'); };
  const pack = record(input) && Object.hasOwn(input, 'templates');
  let templates;
  if (pack) {
    object(input, '$', ['schemaVersion', 'packId', 'packName', 'description', 'author', 'tags', 'templates']);
    if (input.schemaVersion !== 1) issue('$.schemaVersion', 'value');
    optional(input.packId, '$.packId', id); optional(input.packName, '$.packName', text);
    optional(input.description, '$.description', (v,p) => text(v,p,2000)); optional(input.author, '$.author', text);
    optional(input.tags, '$.tags', strings);
    templates = array(input.templates, '$.templates', 16, 1);
  } else templates = [input];
  const templateIds = uniqueIds(templates, '$.templates');
  templates.forEach((template, ti) => {
    const p = pack ? `$.templates[${ti}]` : '$';
    if (!object(template, p, ['id','name','description','version','tags','seedTicks','definition','playerRules','starterShops','observerLocationId'])) return;
    text(template.name, `${p}.name`);
    optional(template.description, `${p}.description`, (v,q) => text(v,q,2000)); optional(template.tags, `${p}.tags`, strings);
    optional(template.version, `${p}.version`, (v,q) => number(v,q,1,1000000,true));
    optional(template.seedTicks, `${p}.seedTicks`, (v,q) => number(v,q,0,100,true));
    const d = template.definition, q = `${p}.definition`;
    if (!object(d, q, ['world','locations','connections','entities','organizations','organizationRelations','resources'])) return;
    if (d.world !== undefined && object(d.world, `${q}.world`, ['id','seed','calendar'])) {
      optional(d.world.id, `${q}.world.id`, id);
      optional(d.world.seed, `${q}.world.seed`, (v,r) => typeof v === 'string' ? text(v,r) : number(v,r,0,Number.MAX_SAFE_INTEGER,true));
      const c = d.world.calendar;
      if (c !== undefined && object(c, `${q}.world.calendar`, ['year','season','day','phase','daysPerSeason','seasonsPerYear'])) {
        for (const key of ['year','day','daysPerSeason','seasonsPerYear']) optional(c[key], `${q}.world.calendar.${key}`, (v,r) => number(v,r,1,1000000,true));
        optional(c.season, `${q}.world.calendar.season`, (v,r) => number(v,r,0,1000000,true));
        if (c.phase !== undefined && !['day','night'].includes(c.phase)) issue(`${q}.world.calendar.phase`, 'value');
        if ((c.day ?? 1) > (c.daysPerSeason ?? 90) || (c.season ?? 0) >= (c.seasonsPerYear ?? 4)) issue(`${q}.world.calendar`, 'value');
      }
    }
    const locations = array(d.locations, `${q}.locations`, 128, 1), locationIds = uniqueIds(locations, `${q}.locations`);
    locations.forEach((row,i) => { const r = `${q}.locations[${i}]`;
      if (!object(row,r,['id','name','type','resources','danger','tags'])) return;
      optional(row.name, `${r}.name`, text); optional(row.type, `${r}.type`, id);
      optional(row.resources, `${r}.resources`, numbers); optional(row.danger, `${r}.danger`, (v,s) => number(v,s,0,100)); optional(row.tags, `${r}.tags`, strings);
    });
    const edges = new Set();
    array(d.connections ?? [], `${q}.connections`, 2048).forEach((row,i) => { const r = `${q}.connections[${i}]`;
      const pair = array(row, r, 2, 2); if (pair.length !== 2) return;
      pair.forEach((v,j) => reference(v, `${r}[${j}]`, locationIds));
      const key = JSON.stringify([...pair].sort()); if (pair[0] === pair[1] || edges.has(key)) issue(r, 'duplicate'); edges.add(key);
    });
    const entities = array(d.entities ?? [], `${q}.entities`, 1000), entityIds = uniqueIds(entities, `${q}.entities`);
    entities.forEach((row,i) => { const r = `${q}.entities[${i}]`;
      if (!object(row,r,['id','name','species','locationId','traits','stats','resources','demographics','tags'])) return;
      reference(row.locationId, `${r}.locationId`, locationIds); optional(row.name, `${r}.name`, text);
      if (row.species !== undefined && !Object.hasOwn(DEFAULT_SPECIES,row.species)) issue(`${r}.species`, 'reference');
      optional(row.traits, `${r}.traits`, (v,s) => numbers(v,s,100)); optional(row.resources, `${r}.resources`, numbers);
      optional(row.stats, `${r}.stats`, (v,s) => numbers(v,s,1000000,['health','maxHealth','energy','maxEnergy','power','defense','speed','intelligence','social']));
      const stats = row.stats;
      if (record(stats) && ((stats.health ?? 100) > (stats.maxHealth ?? 100) || (stats.energy ?? 100) > (stats.maxEnergy ?? 100)
          || (stats.health ?? 100) <= 0 || (stats.maxEnergy ?? 100) <= 0)) issue(`${r}.stats`, 'value');
      optional(row.tags, `${r}.tags`, strings);
      if (row.demographics !== undefined && object(row.demographics, `${r}.demographics`, ['age','sex','generation'])) {
        optional(row.demographics.age, `${r}.demographics.age`, (v,s) => number(v,s,0,10000));
        optional(row.demographics.generation, `${r}.demographics.generation`, (v,s) => number(v,s,1,10000,true));
        if (row.demographics.sex !== undefined && !['female','male'].includes(row.demographics.sex)) issue(`${r}.demographics.sex`, 'value');
      }
    });
    const organizations = array(d.organizations ?? [], `${q}.organizations`, 128);
    uniqueIds(organizations, `${q}.organizations`, row => row.id ?? row.key);
    const organizationIds = new Set(), organizationAliases = new Map();
    organizations.forEach((row,i) => { const r = `${q}.organizations[${i}]`;
      if (!object(row,r,['id','key','type','name','leaderId','homeLocationId','currency','members','roles'])) return;
      for (const alias of new Set([row.id,row.key].filter(v => v !== undefined))) {
        id(alias,r); if (organizationIds.has(alias)) issue(r,'duplicate'); organizationIds.add(alias);
        organizationAliases.set(alias,row.id ?? row.key);
      }
      id(row.type, `${r}.type`); optional(row.name, `${r}.name`, text);
      reference(row.leaderId, `${r}.leaderId`, entityIds); reference(row.homeLocationId, `${r}.homeLocationId`, locationIds);
      optional(row.currency, `${r}.currency`, number);
      const members = array(row.members ?? [], `${r}.members`, 1000), seen = new Set();
      members.forEach((member,j) => { reference(member, `${r}.members[${j}]`, entityIds); if (seen.has(member)) issue(`${r}.members[${j}]`,'duplicate'); seen.add(member); });
      seen.add(row.leaderId);
      if (row.roles !== undefined && record(row.roles)) Object.entries(row.roles).forEach(([member,role],j) => {
        if (!seen.has(member)) issue(`${r}.roles[${j}]`,'reference');
        if (member === row.leaderId ? role !== 'leader' : !['member','student'].includes(role)) issue(`${r}.roles[${j}]`,'value');
      }); else if (row.roles !== undefined) issue(`${r}.roles`,'object');
    });
    const relations = new Set();
    array(d.organizationRelations ?? [], `${q}.organizationRelations`, 512).forEach((row,i) => { const r = `${q}.organizationRelations[${i}]`;
      if (!object(row,r,['from','to','type','value'])) return;
      reference(row.from,`${r}.from`,organizationIds); reference(row.to,`${r}.to`,organizationIds);
      if (!['ally','rival'].includes(row.type)) issue(`${r}.type`,'value');
      optional(row.value, `${r}.value`, (v,s) => number(v,s,1,100));
      const from = organizationAliases.get(row.from), to = organizationAliases.get(row.to);
      const key = JSON.stringify([from,to,row.type]); if (from === to || relations.has(key)) issue(r,'duplicate'); relations.add(key);
    });
    optional(d.resources, `${q}.resources`, numbers);
    optional(template.observerLocationId, `${p}.observerLocationId`, (v,r) => reference(v,r,locationIds));
    const shops = new Set();
    array(template.starterShops ?? [], `${p}.starterShops`, 8).forEach((v,i) => {
      reference(v, `${p}.starterShops[${i}]`, locationIds); if (shops.has(v)) issue(`${p}.starterShops[${i}]`,'duplicate'); shops.add(v);
    });
    if (template.playerRules !== undefined) {
      try { normalizePlayerActionRules(template.playerRules); } catch { issue(`${p}.playerRules`,'rules'); }
    }
  });
  if (options.templateId !== undefined && (!identifier(options.templateId) || !templateIds.has(options.templateId))) issue('$.selection','selection');
  if (templates.length !== 1 && options.templateId === undefined) issue('$.selection','selection');
  optional(options.worldId, '$.options.worldId', id);
  optional(options.seed, '$.options.seed', (v,p) => typeof v === 'string' ? text(v,p) : number(v,p,0,Number.MAX_SAFE_INTEGER,true));
  if (issues.length) return { valid: false, issues };
  const template = JSON.parse(JSON.stringify(templates.find(t => t.id === options.templateId) || templates[0]));
  const d = template.definition;
  return { valid: true, issues: [], template, summary: { id: template.id, name: template.name, version: template.version ?? 1,
    worldId: options.worldId ?? d.world?.id ?? template.id, seedTicks: template.seedTicks ?? 0,
    locations: d.locations.length, connections: (d.connections ?? []).length, population: (d.entities ?? []).length,
    organizations: (d.organizations ?? []).length, starterShopLocations: (template.starterShops ?? []).length } };
}

function validateEngineTemplate(input, options) {
  const { template, ...result } = inspectEngineTemplate(input, options);
  return result;
}
function createEngineWorldFromTemplate(input, options = {}) {
  const result = inspectEngineTemplate(input, options);
  if (!result.valid) throw Object.assign(new Error('Invalid engine world template'), { code: 'ENGINE_TEMPLATE_INVALID', issues: result.issues });
  const t = result.template;
  // Resolve all organization IDs before the permissive historical builder, so
  // generated IDs cannot collide with another declared organization.
  for (const org of t.definition.organizations || []) org.id ??= org.key;
  const world = buildWorldFromDefinition(t.definition, { worldId: result.summary.worldId, seed: options.seed ?? t.definition.world?.seed ?? 1 });
  world.template = { id: t.id, name: t.name, version: t.version ?? 1, format: 'engine-template-v1', sourceDigest: digest(t) };
  createPlayer(world, { id: 'observer', controlMode: 'observer', observerLocationId: t.observerLocationId ?? t.definition.locations[0].id });
  initializeDeterministicSimulation(world, JSON.parse(JSON.stringify(ENGINE_V1_PROFILE)));
  if (t.playerRules !== undefined) configurePlayerActionRules(world,t.playerRules);
  for (const locationId of t.starterShops || []) require('./shop-engine').seedLocationShops(world,locationId);
  if (t.seedTicks) require('../runtime/durable-world-runtime').advanceDeterministicBatch(world,t.seedTicks);
  return world;
}
module.exports = { MAX_TEMPLATE_BYTES, validateEngineTemplate, createEngineWorldFromTemplate };
