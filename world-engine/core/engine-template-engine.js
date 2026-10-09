'use strict';

const { DEFAULT_SPECIES } = require('./species-engine');
const { buildWorldFromDefinition } = require('./world-template-engine');
const { createPlayer } = require('./player-engine');
const { initializeDeterministicSimulation } = require('./deterministic-simulation-engine');
const { ENGINE_V1_PROFILE } = require('../runtime/engine-v1-profile');
const { configurePlayerActionRules } = require('./player-action-rules-engine');
const { digest } = require('../storage/postgres/codec');

const { createTemplateValidator } = require('../shared/template-validation');
const { MAX_TEMPLATE_BYTES, inspectEngineTemplate, validateEngineTemplate } = createTemplateValidator(Object.keys(DEFAULT_SPECIES));

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
