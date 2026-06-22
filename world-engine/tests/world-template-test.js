'use strict';

const assert = require('assert');
const {
  createWorldTemplateRegistry,
  registerWorldTemplate,
  listWorldTemplates,
  createWorldFromTemplate,
  resetWorldFromTemplate,
} = require('../core/world-template-engine');
const { createAccount, createSession, validateSession, linkPlayerToAccount } = require('../core/account-session-engine');
const { createPlayerWithCharacter } = require('../core/player-engine');
const { recordApiRequest } = require('../core/api-audit-engine');
const { createWorldSnapshot } = require('../core/snapshot-engine');

function main() {
  const registry = createWorldTemplateRegistry();
  const templates = listWorldTemplates(registry);
  assert.ok(templates.length >= 3, 'built-in registry should include at least three templates');
  assert.ok(templates.some(template => template.id === 'empty_sandbox'), 'empty sandbox template should exist');
  assert.ok(templates.some(template => template.id === 'cultivation_frontier'), 'cultivation frontier template should exist');
  assert.ok(templates.some(template => template.id === 'merchant_crossroads'), 'merchant crossroads template should exist');

  const empty = createWorldFromTemplate(registry, 'empty_sandbox', {
    worldId: 'empty_test_world',
    initialize: false,
  });
  assert.strictEqual(empty.id, 'empty_test_world', 'custom world id should be applied');
  assert.strictEqual(empty.template.id, 'empty_sandbox', 'world should record template id');
  assert.strictEqual(Object.keys(empty.locations).length, 1, 'empty sandbox should have one location');
  assert.strictEqual(Object.keys(empty.entities).length, 0, 'empty sandbox should have no entities');
  assert.strictEqual(empty.calendar.phase, 'day', 'default calendar should remain intact');

  const frontier = createWorldFromTemplate(registry, 'cultivation_frontier', {
    worldId: 'frontier_test_world',
    seedTicks: 3,
  });
  assert.strictEqual(frontier.id, 'frontier_test_world', 'frontier custom world id should be applied');
  assert.ok(frontier.tick >= 3, 'frontier should run seed ticks');
  assert.ok(Object.keys(frontier.locations).length >= 4, 'frontier should include locations');
  assert.ok(Object.keys(frontier.entities).length >= 18, 'frontier should include population');
  assert.ok(Object.keys(frontier.organizations?.byId || {}).length >= 2, 'frontier should include organizations');

  const frontierOrganizations = Object.values(frontier.organizations.byId);
  const sect = frontierOrganizations.find(org => org.name === 'Qingyun Sect');
  assert.ok(sect, 'Qingyun Sect should exist');
  assert.ok(sect.members.length >= 8, 'sect membership should be populated');
  assert.ok(frontier.entities.frontier_cultivator_1.organizationIds.includes(sect.id), 'entity membership index should be populated');
  assert.strictEqual(sect.roles.frontier_cultivator_0, 'leader', 'leader role should not be overwritten');

  const crossroads = createWorldFromTemplate(registry, 'merchant_crossroads', { sedTicks: 1 });
  assert.ok(Object.keys(crossroads.locations).length >= 4, 'crossroads should include locations');
  assert.ok(Object.keys(crossroads.entities).length >= 14, 'crossroads should include population');
  assert.notStrictEqual(crossroads.locations.jade_harbor.resources.food, frontier.locations.qingyun_city.resources.food, 'templates should create independent data');

  registerWorldTemplate(registry, {
    id: 'custom_tiny',
    name: 'Custom Tiny',
    description: 'Custom registry template',
    definition: {
      world: { id: 'tiny' },
      locations: [
        { id: 'tiny_origin', name: 'Tiny Origin', resources: { food: 10 } },
      ],
      entities: [
        { id: 'tiny_agent', name: 'Tiny Agent', species: 'human', locationId: 'tiny_origin' },
      ],
    },
  });
  const custom = createWorldFromTemplate(registry, 'custom_tiny', { initialize: false });
  assert.ok(custom.entities.tiny_agent, 'custom template should create entity');
  assert.strictEqual(custom.entities.tiny_agent.species, 'human', 'custom template should assign species');
  assert.throws(() => registerWorldTemplate(registry, {
    id: 'custom_tiny',
    name: 'Duplicate',
    definition: { locations: [] },
  }), /already exists/, 'duplicate template ids should be rejected');
  assert.throws(() => createWorldFromTemplate(registry, 'missing_template'), /Missing world template/, 'missing template should throw');

  createAccount(frontier, { id: 'template_admin', name: 'Template Admin', roles: ['gm'] });
  const session = createSession(frontier, 'template_admin', { sessionTtlTicks: 10000 });
  const player = createPlayerWithCharacter(frontier, {
    player: { id: 'old_player', name: 'Old Player' },
    character: { id: 'old_hero', name: 'Old Hero', locationId: 'qingyun_city' },
  });
  linkPlayerToAccount(frontier, 'template_admin', player.player.id);
  recordApiRequest(frontier, { method: 'GET', path: '/before-reset', statusCode: 200, durationMs: 1 });

  const reset = resetWorldFromTemplate(frontier, registry, 'merchant_crossroads', {
    worldId: 'reset_crossroads',
    seedTicks: 2,
    preserveAccounts: true,
    preserveAudit: true,
  });
  assert.strictEqual(reset.id, 'reset_crossroads', 'reset should create requested world id');
  assert.strictEqual(reset.template.id, 'merchant_crossroads', 'reset should record new template');
  assert.strictEqual(reset.template.resetFromWorldId, 'frontier_test_world', 'reset should record source world');
  assert.ok(reset.accounts.byId.template_admin, 'reset should preserve account');
  assert.deepStrictEqual(reset.accounts.byId.template_admin.playerIds, [], 'reset should clear old player links');
  assert.strictEqual(Object.keys(reset.accounts.byPlayer).length, 0, 'reset should clear reverse player links');
  assert.ok(validateSession(reset, session.token), 'preserved session should remain valid');
  assert.ok(reset.apiAudit.log.length >= 1, 'reset should preserve API audit log');
  assert.strictEqual(reset.players, undefined, 'old players should not leak into reset world');
  assert.strictEqual(reset.entities.old_hero, undefined, 'old entities should not leak into reset world');

  const snapshot = createWorldSnapshot(reset);
  assert.strictEqual(snapshot.world.id, 'reset_crossroads', 'snapshot should represent reset world');
  assert.ok(JSON.stringify(snapshot).length > 100, 'reset world snapshot should serialize');

  console.log('world template engine integration test passed');
}

main();
