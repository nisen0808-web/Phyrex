'use strict';

const { ensureEngineState, nextEngineId } = require('./engine-state-engine');
const { hashSimulationState, createStateCheckpoint, compareCanonicalState } = require('./world-state-hash-engine');
const { validateWorldState } = require('./world-integrity-engine');

const REPLAY_VERSION = 1;

class ReplayDivergenceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ReplayDivergenceError';
    this.code = 'replay_divergence';
    this.details = details;
  }
}

function ensureReplayState(world) {
  const engine = ensureEngineState(world);
  if (!engine.replay || typeof engine.replay !== 'object') {
    engine.replay = {
      version: REPLAY_VERSION,
      tapesCreated: 0,
      operationsRecorded: 0,
      replaysRun: 0,
      divergences: 0,
      lastReplay: null,
    };
  }
  return engine.replay;
}

function createReplayTape(world, options = {}) {
  const state = ensureReplayState(world);
  state.tapesCreated = Number(state.tapesCreated || 0) + 1;
  const tape = {
    version: REPLAY_VERSION,
    id: options.id || nextEngineId(world, 'replay'),
    name: options.name || null,
    worldId: world.id || null,
    seed: clone(world.seed),
    startTick: Number(world.tick || 0),
    initialHash: null,
    initialWorld: null,
    operations: [],
    checkpoints: [],
    metadata: clone(options.metadata || {}),
    hashOptions: normalizeHashOptions(options.hashOptions),
  };
  tape.initialHash = hashSimulationState(world, tape.hashOptions);
  if (options.includeInitialWorld !== false) tape.initialWorld = clone(world);
  tape.checkpoints.push({
    index: -1,
    ...createStateCheckpoint(world, { label: 'initial' }, { ...tape.hashOptions, simulationOnly: true }),
  });
  return tape;
}

function executeAndRecord(world, tape, kind, input, handler, options = {}) {
  if (typeof handler !== 'function') throw new Error('executeAndRecord requires handler');
  const tickBefore = Number(world.tick || 0);
  const beforeHash = hashSimulationState(world, tape.hashOptions || {});
  const result = handler(world, clone(input), options);
  if (result && typeof result.then === 'function') throw new Error('Use executeAndRecordAsync for asynchronous handlers');
  const operation = recordReplayOperation(world, tape, {
    kind,
    input,
    result,
    tickBefore,
    beforeHash,
    metadata: options.metadata,
  });
  return { result, operation };
}

async function executeAndRecordAsync(world, tape, kind, input, handler, options = {}) {
  if (typeof handler !== 'function') throw new Error('executeAndRecordAsync requires handler');
  const tickBefore = Number(world.tick || 0);
  const beforeHash = hashSimulationState(world, tape.hashOptions || {});
  const result = await handler(world, clone(input), options);
  const operation = recordReplayOperation(world, tape, {
    kind,
    input,
    result,
    tickBefore,
    beforeHash,
    metadata: options.metadata,
  });
  return { result, operation };
}

function recordReplayOperation(world, tape, input = {}) {
  validateTape(tape);
  const index = tape.operations.length;
  const operation = {
    index,
    id: input.id || `${tape.id}_step_${index + 1}`,
    kind: String(input.kind || 'operation'),
    tickBefore: Number(input.tickBefore ?? world.tick ?? 0),
    tickAfter: Number(world.tick || 0),
    input: clone(input.input),
    result: clone(input.result),
    metadata: clone(input.metadata || {}),
    beforeHash: input.beforeHash || null,
    afterHash: input.afterHash || hashSimulationState(world, tape.hashOptions || {}),
  };
  tape.operations.push(operation);
  const state = ensureReplayState(world);
  state.operationsRecorded = Number(state.operationsRecorded || 0) + 1;
  return operation;
}

function addReplayCheckpoint(world, tape, label = null) {
  validateTape(tape);
  const checkpoint = {
    index: tape.operations.length - 1,
    ...createStateCheckpoint(world, { label }, { ...tape.hashOptions, simulationOnly: true }),
  };
  tape.checkpoints.push(checkpoint);
  return checkpoint;
}

function replayTape(tape, handlers, options = {}) {
  validateTape(tape);
  const world = makeReplayWorld(tape, options);
  const report = beginReport(tape, world, options);
  try {
    for (const operation of tape.operations) {
      const handler = resolveHandler(handlers, operation.kind);
      const beforeHash = verifyBefore(world, tape, operation, options);
      const result = handler(world, clone(operation.input), operation, options);
      if (result && typeof result.then === 'function') throw new Error('Use replayTapeAsync for asynchronous handlers');
      verifyAfter(world, tape, operation, beforeHash, result, options, report);
    }
    finishReport(world, tape, options, report);
    saveReplaySummary(world, tape, report, null);
    return report;
  } catch (error) {
    if (error instanceof ReplayDivergenceError) saveReplaySummary(world, tape, report, error.details);
    throw error;
  }
}

async function replayTapeAsync(tape, handlers, options = {}) {
  validateTape(tape);
  const world = tape.initialWorld ? clone(tape.initialWorld) : await requireWorldFactory(options)(clone(tape));
  const report = beginReport(tape, world, options);
  try {
    for (const operation of tape.operations) {
      const handler = resolveHandler(handlers, operation.kind);
      const beforeHash = verifyBefore(world, tape, operation, options);
      const result = await handler(world, clone(operation.input), operation, options);
      verifyAfter(world, tape, operation, beforeHash, result, options, report);
    }
    finishReport(world, tape, options, report);
    saveReplaySummary(world, tape, report, null);
    return report;
  } catch (error) {
    if (error instanceof ReplayDivergenceError) saveReplaySummary(world, tape, report, error.details);
    throw error;
  }
}

function beginReport(tape, world, options) {
  const initialHash = hashSimulationState(world, tape.hashOptions || {});
  if (options.verifyInitial !== false && initialHash !== tape.initialHash) {
    throw divergence('Initial replay state does not match tape', {
      index: -1,
      expectedHash: tape.initialHash,
      actualHash: initialHash,
    });
  }
  return {
    tapeId: tape.id,
    world,
    initialHash,
    finalHash: null,
    operations: [],
    checkpoints: [],
    integrity: null,
  };
}

function verifyBefore(world, tape, operation, options) {
  const actualHash = hashSimulationState(world, tape.hashOptions || {});
  if (options.verifyBefore !== false && operation.beforeHash && actualHash !== operation.beforeHash) {
    throw divergence(`Replay diverged before operation ${operation.index}`, {
      index: operation.index,
      operationId: operation.id,
      kind: operation.kind,
      phase: 'before',
      expectedHash: operation.beforeHash,
      actualHash,
    });
  }
  return actualHash;
}

function verifyAfter(world, tape, operation, beforeHash, result, options, report) {
  const actualHash = hashSimulationState(world, tape.hashOptions || {});
  const item = {
    index: operation.index,
    id: operation.id,
    kind: operation.kind,
    beforeHash,
    afterHash: actualHash,
    expectedHash: operation.afterHash,
    result: clone(result),
    matched: actualHash === operation.afterHash,
  };
  report.operations.push(item);
  if (options.verifyAfter !== false && !item.matched) {
    throw divergence(`Replay diverged after operation ${operation.index}`, {
      index: operation.index,
      operationId: operation.id,
      kind: operation.kind,
      phase: 'after',
      expectedHash: operation.afterHash,
      actualHash,
    });
  }
  return item;
}

function finishReport(world, tape, options, report) {
  report.finalHash = hashSimulationState(world, tape.hashOptions || {});
  report.integrity = validateWorldState(world, options.integrityOptions || {});
  if (options.requireIntegrity !== false && !report.integrity.ok) {
    throw divergence('Replay completed with invalid world state', {
      errors: report.integrity.errors.slice(0, 20),
    });
  }
  for (const checkpoint of tape.checkpoints || []) {
    if (checkpoint.index < 0) continue;
    const operation = report.operations.find(item => item.index === checkpoint.index);
    if (!operation) continue;
    report.checkpoints.push({
      index: checkpoint.index,
      expectedHash: checkpoint.hash,
      actualHash: operation.afterHash,
      matched: checkpoint.hash === operation.afterHash,
    });
  }
  return report;
}

function compareReplayWorlds(expectedWorld, actualWorld, options = {}) {
  return compareCanonicalState(expectedWorld, actualWorld, {
    excludePaths: options.excludePaths || ['accounts', 'apiAudit', 'runtime', 'runtimeLoop', 'engine.replay'],
  });
}

function exportReplayTape(tape, options = {}) {
  validateTape(tape);
  return options.pretty === false ? JSON.stringify(tape) : JSON.stringify(tape, null, 2);
}

function importReplayTape(value) {
  const tape = typeof value === 'string' ? JSON.parse(value) : clone(value);
  validateTape(tape);
  return tape;
}

function getReplaySummary(world) {
  return clone(ensureReplayState(world));
}

function makeReplayWorld(tape, options) {
  return tape.initialWorld ? clone(tape.initialWorld) : requireWorldFactory(options)(clone(tape));
}

function requireWorldFactory(options) {
  if (typeof options.createWorld !== 'function') throw new Error('Replay tape has no initial world; createWorld option is required');
  return options.createWorld;
}

function resolveHandler(handlers, kind) {
  if (typeof handlers === 'function') return handlers;
  const handler = handlers?.[kind] || handlers?.default;
  if (typeof handler !== 'function') throw new Error(`Missing replay handler for ${kind}`);
  return handler;
}

function saveReplaySummary(world, tape, report, details) {
  const state = ensureReplayState(world);
  state.replaysRun = Number(state.replaysRun || 0) + 1;
  if (details) state.divergences = Number(state.divergences || 0) + 1;
  state.lastReplay = {
    tapeId: tape.id,
    operations: report.operations.length,
    finalHash: report.finalHash,
    divergence: clone(details),
  };
}

function validateTape(tape) {
  if (!tape || typeof tape !== 'object') throw new Error('Invalid replay tape');
  if (Number(tape.version) !== REPLAY_VERSION) throw new Error(`Unsupported replay tape version ${tape.version}`);
  if (!Array.isArray(tape.operations)) throw new Error('Replay tape operations must be an array');
  if (!Array.isArray(tape.checkpoints)) tape.checkpoints = [];
  return tape;
}

function normalizeHashOptions(options = {}) {
  return {
    algorithm: options.algorithm || 'sha256',
    excludePaths: Array.isArray(options.excludePaths) ? clone(options.excludePaths) : [],
  };
}

function divergence(message, details) {
  return new ReplayDivergenceError(message, clone(details));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

module.exports = {
  REPLAY_VERSION,
  ReplayDivergenceError,
  ensureReplayState,
  createReplayTape,
  executeAndRecord,
  executeAndRecordAsync,
  recordReplayOperation,
  addReplayCheckpoint,
  replayTape,
  replayTapeAsync,
  compareReplayWorlds,
  exportReplayTape,
  importReplayTape,
  getReplaySummary,
};
