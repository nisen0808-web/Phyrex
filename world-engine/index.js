'use strict';

// Stable v1 entry point. Constructors are trusted host APIs; submitPlayerIntent
// always enforces the public character contract, including for local callers.
const { executePlayerCommand } = require('./core/command-engine');
module.exports = Object.freeze({
  version: require('./package.json').version,
  createWorld: require('./core/world-engine').createWorld,
  registerLocation: require('./core/world-engine').registerLocation,
  registerEntity: require('./core/world-engine').registerEntity,
  connectLocations: require('./core/world-engine').connectLocations,
  createSampleWorld: require('./demo/engine-v1-world').createEngineWorld,
  validateEngineTemplate: require('./core/engine-template-engine').validateEngineTemplate,
  createEngineWorldFromTemplate: require('./core/engine-template-engine').createEngineWorldFromTemplate,
  createPlayer: require('./core/player-engine').createPlayer,
  createPlayerCharacter: require('./core/player-engine').createPlayerCharacter,
  configurePlayerActionRules: require('./core/player-action-rules-engine').configurePlayerActionRules,
  defineItem: require('./core/item-engine').defineItem,
  createShop: require('./core/shop-engine').createShop,
  submitPlayerIntent: (world, playerId, input) => executePlayerCommand(world, playerId, input, { publicPlayer: true }),
  getPlayerCommandResult: (world, playerId, id) => {
    const command = Object.hasOwn(world.commands?.byId || {}, id) ? world.commands.byId[id] : null;
    return command?.playerId === playerId ? JSON.parse(JSON.stringify({ id: command.id, status: command.status, result: command.result, updatedAt: command.updatedAt })) : null;
  },
  advanceDeterministicBatch: require('./runtime/durable-world-runtime').advanceDeterministicBatch,
  createDurableWorldRuntime: require('./runtime/durable-world-runtime').createDurableWorldRuntime,
  createPostgresDatabaseStore: require('./storage/postgres/store').createPostgresDatabaseStore,
  createDurableCommandApiServer: require('./core/durable-command-api-engine').createDurableCommandApiServer,
  playerStateView: require('./core/durable-state-view-engine').playerStateView,
});
