'use strict';

const assert = require('assert');
const {
  createWorldTemplateRegistry,
  registerWorldTemplate,
  listWorldTemplates,
  createWorldFromTemplate,
  resetWorldFromTemplate,
} = require('../core/world-template-engine');
const {
  createAccount,
  createSession,
  validateSession,
  linkPlayerToAccount,
} = require('../core/account-session-engine');
const { createPlayerWithCharacter } = require('../core/player-engine');
const { recordApiRequest } = require('../core/api-audit-engine');
const { createWorldSnapshot } = require('../core/snapshot-engine');

function main() {
  const registry = createWorldTemplateRegistry();
  const templateIds = listWorldTemplates(registry).map(template => template.id);
  for (const id of ['empty_sandbox', 'cultivation_frontier', 'merchant_crossroads']) {
    assert.ok(templateIds.includes(id), `built-in template should exist: ${id}`);
  }

  const empty = createWorldFromTemplate(registry, 'empty_sandbox', {
    worldId: 'empty_test_world',
    initialize: false,
  });
  assert.strictEqual(empty.id, 'empty_test_world');
  assert.strictEqual(empty.template.id, 'empty_sandbox');
  assert.strictEqual(Object.keys(empty.locations).length, 1);
  assert.strictEqual(Object.keys(empty.entities).length, 0);
  assert.strictEqual(empty.calendar.phase, 'day');

  const frontier = createWorldFromTemplate(registry, 'cultivation_frontier', {
    worldId: 'frontier_test_world',
    seedTicks: 3,
  });
  assert.ok(frontier.tick >= 3);
  assert.ok(Object.keys(frontier.locations).length >= 4);
  assert.ok(Object.keys(frontier.entities).length >= 18);
  const sect = Object.values(frontier.organizations?.byId || {})
    .find(organization => organization.name === 'Qingyun Sect');
  assert.ok(sect);
  assert.ok(sect.members.length >= 8);
  assert.ok(frontier.entities.frontier_cultivator_1.organizationIds.includes(sect.id));
  assert.strictEqual(sect.roles.frontier_cultivator_0, 'leader');

  const crossroads = createWorldFromTemplate(registry, 'merchant_crossroads', { seedTicks: 1 });
  assert.ok(Object.keys(crossroads.locations).length >= 4);
  assert.ok(Object.keys(crossroads.entities).length >= 14);
  assert.notStrictEqual(
    crossroads.locations.jade_harbor.resources.food,
    frontier.locations.qingyun_city.resources.food,
  );

  registerWorldTemplate(registry, {
    id: 'custom_tiny',
    name: 'Custom Tiny',
    definition: {
      world: { id: 'tiny' },
      locations: [{ id: 'tiny_origin', name: 'Tiny Origin', resources: { food: 10 } }],
      entities: [{
        id: 'tiny_agent',
        name: 'Tiny Agent',
        species: 'human',
        locationId: 'tiny_origin',
      }],
    },
  });
  const custom = createWorldFromTemplate(registry, 'custom_tiny', { initialize: false });
  assert.strictEqual(custom.entities.tiny_agent.species, 'human');
  assert.throws(
    () => registerWorldTemplate(registry, {
      id: 'custom_tiny',
      name: 'Duplicate',
      definition: { locations: [] },
    }),
    /already exists/,
  );
  assert.throws(
    () => createWorldFromTemplate(registry, 'missing_template'),
    /Missing world template/,
  );

  createAccount(frontier, {
    id: 'template_admin',
    name: 'Template Admin',
    roles: ['gm'],
  });
  const session = createSession(frontier, 'template_admin', { sessionTtlTicks: 10000 });
  const player = createPlayerWithCharacter(frontier, {
    player: { id: 'old_player', name: 'Old Player' },
    character: { id: 'old_hero', name: 'Old Hero', locationId: 'qingyun_city' },
  });
  linkPlayerToAccount(frontier, 'template_admin', player.player.id);
  recordApiRequest(frontier, {
    method: 'GET',
    path: '/before-reset',
    statusCode: 200,
    durationMs: 1,
  });

  const reset = resetWorldFromTemplate(frontier, registry, 'merchant_crossroads', {
    worldId: 'reset_crossroads',
    seedTicks: 2,
    preserveAccounts: true,
    preserveAudit: true,
  });
  assert.strictEqual(reset.id, 'reset_crossroads');
  assert.strictEqual(reset.template.id, 'merchant_crossroads');
  assert.strictEqual(reset.template.resetFromWorldId, 'frontier_test_world');
  assert.ok(reset.accounts.byId.template_admin);
  assert.deepStrictEqual(reset.accounts.byId.template_admin.playerIds, []);
  assert.strictEqual(Object.keys(reset.accounts.byPlayer).length, 0);
  assert.ok(validateSession(reset, session.token));
  assert.ok(reset.apiAudit.log.some(entry => entry.path === '/before-reset'));
  assert.strictEqual(reset.players?.byId?.old_player, undefined);
  assert.strictEqual(Object.keys(reset.players?.byId || {}).length, 0);
  assert.strictEqual(reset.entities.old_hero, undefined);

  const snapshot = createWorldSnapshot(reset);
  assert.strictEqual(snapshot.world.id, 'reset_crossroads');
  assert.ok(JSON.stringify(snapshot).length > 100);

  console.log('world template engine integration test passed');
}

main();
