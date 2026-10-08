'use strict';
const assert = require('node:assert/strict');
const engine = require('..');
const { digest } = require('../storage/postgres/codec');
const { createSaveEnvelope, repairLoadedWorld } = require('../core/persistence-engine');
const { builtInWorldTemplates } = require('../core/world-template-engine');
const sample = require('../templates/river-valley.json');
const clone = value => JSON.parse(JSON.stringify(value));
function invalid(change, code) {
  const input = clone(sample); change(input.templates[0],input);
  const report = engine.validateEngineTemplate(input);
  assert.equal(report.valid,false); assert(report.issues.some(i => i.code === code),JSON.stringify(report));
  assert.throws(() => engine.createEngineWorldFromTemplate(input),{ code:'ENGINE_TEMPLATE_INVALID' });
}
const original = JSON.stringify(sample);
assert.equal(engine.validateEngineTemplate(sample).valid,true);
for (const template of builtInWorldTemplates()) assert.equal(engine.validateEngineTemplate(template).valid,true);
invalid(t => t.definition.locations.push(clone(t.definition.locations[0])),'duplicate');
invalid(t => t.definition.connections.push(['river-village','missing']),'reference');
invalid(t => t.definition.connections.push(['pine-forest','river-village']),'duplicate');
invalid(t => t.definition.entities[0].locationId = 'missing','reference');
invalid(t => t.definition.entities[0].species = 'unknown','reference');
for (const suffix of [1,2,100]) invalid(t => {
  const previous = t.definition.entities[0].id, reserved = `observer_character_${suffix}`;
  t.definition.entities[0].id = reserved;
  for (const org of t.definition.organizations) {
    if (org.leaderId === previous) org.leaderId = reserved;
    org.members = org.members.map(id => id === previous ? reserved : id);
  }
},'reserved');
invalid(t => t.definition.entities[0].stats.health = '100','number');
invalid(t => t.definition.entities[0].stats.maxHealth = 10,'value');
invalid(t => t.definition.entities[0].resources.food = -1,'number');
invalid(t => t.definition.organizations[0].members.push('missing'),'reference');
invalid(t => t.definition.organizations[0].leaderId = 'missing','reference');
invalid(t => t.definition.organizations[0].roles = { 'valley-elder':'member' },'value');
invalid(t => t.definition.organizations[1].id = 'valley-council','duplicate');
invalid(t => t.definition.organizationRelations[0].from = 'missing','reference');
invalid(t => { t.definition.organizations[0].id = 'council-id'; t.definition.organizationRelations[0].to = 'council-id'; },'duplicate');
invalid(t => { t.definition.organizations[0].id = 'council-id'; t.definition.organizationRelations.push({from:'council-id',to:'valley-guild',type:'ally',value:30}); },'duplicate');
invalid(t => t.observerLocationId = 'missing','reference');
invalid(t => t.starterShops.push('missing'),'reference');
invalid(t => t.playerRules.workYield = 0,'rules');
invalid(t => t.simulation = { process:{preserveActive:false} },'unknown_field');
invalid(t => t.definition.accounts = { secret:'must-not-persist' },'unknown_field');
invalid(t => t.definition.entities[0].meta = { playerId:'observer' },'unknown_field');
invalid(t => t.seedTicks = 101,'number');
invalid(t => t.definition.world.calendar = { day:100,daysPerSeason:90 },'value');
invalid((t,p) => p.schemaVersion = 2,'value');
invalid(t => t.definition.locations = Array.from({length:129},(_,i)=>({id:'l'+i})),'capacity');
for (const value of [Infinity, NaN, () => 1, new Date(), undefined]) {
  const input = clone(sample); input.templates[0].definition.resources = { food:value };
  assert.equal(engine.validateEngineTemplate(input).valid,false);
}
const cyclic = {}; cyclic.self = cyclic; assert.equal(engine.validateEngineTemplate(cyclic).valid,false);
const accessor = {}; Object.defineProperty(accessor,'id',{enumerable:true,get(){throw Error('must not run');}});
assert.equal(engine.validateEngineTemplate(accessor).valid,false);
const sparse = clone(sample); sparse.templates = new Array(1); assert.equal(engine.validateEngineTemplate(sparse).valid,false);
for (const field of ['__proto__','constructor','prototype']) {
  const input = clone(sample); input.templates[0].definition.resources = JSON.parse(`{"${field}": 1}`);
  assert.equal(engine.validateEngineTemplate(input).valid,false);
}
const secret = 'do-not-print-private-input';
const bad = clone(sample); bad.templates[0].definition[secret] = secret;
assert(!JSON.stringify(engine.validateEngineTemplate(bad)).includes(secret));
const many = clone(sample); many.templates.push({...clone(many.templates[0]),id:'another'});
assert.equal(engine.validateEngineTemplate(many).valid,false);
assert.equal(engine.validateEngineTemplate(many,{templateId:'another'}).valid,true);
assert.equal(engine.validateEngineTemplate(many,{templateId:'missing'}).valid,false);
assert.equal(engine.validateEngineTemplate(sample,{worldId:'constructor'}).valid,false);
const world = engine.createEngineWorldFromTemplate(sample), again = engine.createEngineWorldFromTemplate(sample);
assert.equal(JSON.stringify(sample),original,'construction cannot mutate template input');
assert.equal(digest(world),digest(again));
assert.equal(world.players.byId.observer.observerLocationId,'river-village');
assert.equal(world.simulation.options.process.preserveActive,true);
assert.equal(world.locations['river-village'].name,'河畔村庄');
assert.equal(engine.playerStateView(world,1,'observer').actionRules.workYield,12);
assert(world.shops.byId['shop_river-village_general']);
assert.equal(world.organizations.byId['valley-council'].allies['valley-guild'],60);
assert.equal(world.organizations.byId['valley-council'].roles['valley-elder'],'leader');
assert(world.entities['forest-scout'].organizationIds.includes('valley-council'));
const seeded = clone(sample); seeded.templates[0].seedTicks = 2;
const initial = engine.createEngineWorldFromTemplate(seeded);
assert.equal(initial.tick,2); assert.equal(digest(initial),digest(engine.createEngineWorldFromTemplate(seeded)));
const restored = clone(createSaveEnvelope(initial).world); repairLoadedWorld(restored);
engine.advanceDeterministicBatch(initial,2); engine.advanceDeterministicBatch(restored,2);
assert.equal(digest(initial),digest(restored));
assert.equal(engine.validateEngineTemplate(require('../templates/tiny-island.json')).valid,true);
console.log('engine template passed: strict content validation, safe diagnostics, deterministic construction and recovery');
