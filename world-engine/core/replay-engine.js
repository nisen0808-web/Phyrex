'use strict';

const { ensureEngineState, nextEngineId } = require('./engine-state-engine');
const {
  hashSimulationState,
  createStateCheckpoint,
  compareCanonicalState,
} = require('./world-state-hash-engine');
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
  if (!world || typeof world !== 'object') throw new Error('createReplayTape requires world');
  const state = ensureReplayState(world);
  state.tapesCreated = Number(state.tapesCreated || 0) + 1;
  const includeInitialWorld = options.includeInitialWorld !== false;
  const tape = {
    version: REPLAY_VERSION,
    id: options.id || nextEngineId(world, 'replay'),
    name: options.name || null,
    worldId: world.id || null,
    seed: cloneValue(world.seed),
    startTick: Number(world.tick || 0),
    initialHash: hashSimulationState(world, options.hashOptions || {}),
    initialWorld: includeInitialWorld ? cloneValue(world) : null,
    operations: [],
    checkpoints: [],
    metadata: cloneValue(options.metadata || {}),
    hashOptions: sanitizeHashOptions(options.hashOptions || {}),
  };
  tape.checkpoints.push({
    index: -1,
    ...createStateCheckpoint(world, { label: 'initial' }, { ...tape.hashOptions, simulationOnly: true }),
  });
  return tape;
}

function executeAndRecord(world, tape, kind, input, handler, options = {}) {
  if (typeof handler !== 'function') throw new Error('executeAndRecord requires handler');
  const beforeHash = hashSimulationState(world, tape.hashOptions || {});
  const result = handler(world, cloneValue(input), options);
  if (result && typeof result.then === 'function') {
    throw new Error('executeAndRecord received Promise; use executeAndRecordAsync');
  }
  const operation = recordReplayOperation(world, tape, {
    kind,
    input,
    beforeHash,
    result,
    metadata: options.metadata,
  });
  return { result, operation };
}

async function executeAndRecordAsync(world, tape, kind, input, handler, options = {}) {
  if (typeof handler !== 'function') throw new Error('executeAndRecordAsync requires handler');
  const beforeHash = hashSimulationState(world, tape.hashOptions || {});
  const result = await handler(world, cloneValue(input), options);
  const operation = recordReplayOperation(world, tape, {
    kind,
    input,
    beforeHash,
    result,
    metadata: options.metadata,
  });
  return { result, operation };
}

function recordReplayOperation(world, tape, input = {}) {
  validateTape(tape);
  const state = ensureReplayState(world);
  const operation = {
    index: tape.operations.length,
    id: input.id || nextEngineId(world, 'replay_step'),
    tickBefore: Number(input.tickBefore ?? world.tick ?? 0),
    tickAfter: Number(world.tick || 0),
    kind: String(input.kind || 'operation'),
    input: cloneValue(input.input),
    beforeHash: input.beforeHash || null,
    afterHash: input.afterHash || hashSimulationState(world, tape.hashOptions || {}),
    result: cloneValue(input.result),
    metadata: cloneValue(input.metadata || {}),
  };
  tape.operations.push(operation);
  state.operationsRecorded = Number(state.operationsRecorded || 0) + 1;
  if (input.checkpoint || (input.checkpointEvery && tape.operations.length % Number(input.checkpointEvery) === 0)) {
    addReplayCheckpoint(world, tape, input.checkpointLabel || operation.kind);
  }
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
  if (!tape.initialWorld && typeof options.createWorld !== 'function') {
    throw new Error('Replay tape has no initial world; createWorld option is required');
  }
  const world = tape.initialWorld
    ? cloneValue(tape.initialWorld)
    : options.createWorld(cloneValue(tape));
  const initialHash = hashSimulationState(world, tape.hashOptions || {});
  if (options.verifyInitial !== false && initialHash !== tape.initialHash) {
    throw createDivergence('Initial replay state does not match tape', {
      index: -1,
      expectedHash: tape.initialHash,
      actualHash: initialHash,
    });
  }

  const report = {
    tapeId: tape.id,
    world,
    operations: [],
    checkpoints: [],
    initialHash,
    finalHash: null,
    integrity: null,
  };

  for (const operation of tape.operations) {
    const handler = resolveReplayHandler(handlers, operation.kind);
    const beforeHash = hashSimulationState(world, tape.hashOptions || {});
    if (options.verifyBefore !== false && operation.beforeHash && beforeHash !== operation.beforeHash) {
      throw createDivergence(`Replay diverged before operation ${operation.index}`, {
        operation,
        index: operation.index,
        phase: 'before',
        expectedHash: operation.beforeHash,
        actualHash: beforeHash,
      });
    }
    const result = handler(world, cloneValue(operation.input), operation, options);
    if (result && typeof result.then === 'function') throw new Error('Replay handler returned Promise; use replayTapeAsync');
    const afterHash = hashSimulationState(world, tape.hashOptions || {});
    const item = {
      index: operation.index,
      id: operation.id,
      kind: operation.kind,
      beforeHash,
      afterHash,
      expectedHash: operation.afterHash,
      result: cloneValue(result),
      matched: afterHash === operation.afterHash,
    };
    report.operations.push(item);
    if (!item.matched && options.verifyAfter !== false) {
      throw createDivergence(`Replay diverged after operation ${operation.index}`, {
        operation,
        index: operation.index,
        phase: 'after',
        expectedHash: operation.afterHash,
        actualHash: afterHash,
        report,
      });
    }
    const checkpoint = tape.checkpoints.find(value => value.index === operation.index);
    if (checkpoint) report.checkpoints.push({
      index: operation.index,
      expectedHash: checkpoint.hash,
      actualHash: afterHash,
      matched: checkpoint.hash === afterHash,
    });
  }

  report.finalHash = hashSimulationState(world, tape.hashOptions || {});
  report.integrity = validateWorldState(world, options.integrityOptions || {});
  if (options.requireIntegrity !== false && !report.integrity.ok) {
    throw createDivergence('Replay completed with invalid world state', { report });
  }
  updateReplaySummary(world, tape, report, null);
  return report;
}

async function replayTapeAsync(tape, handlers, options = {}) {
  validateTape(tape);
  const world = tape.initialWorld
    ? cloneValue(tape.initialWorld)
    : await options.createWorld(cloneValue(tape));
  const report = {
    tapeId: tape.id,
    world,
    operations: [],
    checkpoints: [],
    initialHash: hashSimulationState(world, tape.hashOptions || {}),
    finalHash: null,
    integrity: null,
  };
  if (options.verifyInitial !== false && report.initialHash !== tape.initialHash) {
    throw createDivergence('Initial replay state does not match tape', {
      index: -1,
      expectedHash: tape.initialHash,
      actualHash: report.initialHash,
    });
  }

  for (const operation of tape.operations) {
    const handler = resolveReplayHandler(handlers, operation.kind);
    const beforeHash = hashSimulationState(world, tape.hashOptions || {});
    if (options.verifyBefore !== false && operation.beforeHash && beforeHash !== operation.beforeHash) {
      throw createDivergence(`Replay diverged before operation ${operation.index}`, {
        operation,
        index: operation.index,
        phase: 'before',
        expectedHash: operation.beforeHash,
        actualHash: beforeHash,
      });
    }
    const result = await handler(world, cloneValue(operation.input), operation, options);
    const afterHash = hashSimulationState(world, tape.hashOptions || {});
    const item = {
      index: operation.index,
      id: operation.id,
      kind: operation.kind,
      beforeHash,
      afterHash,
      expectedHash: operation.afterHash,
      result: cloneValue(result),
      matched: afterHash === operation.afterHash,
    };
    report.operations.push(item);
    if (!item.matched && options.verifyAfter !== false) {
      throw createDivergence(`Replay diverged after operation ${operation.index}`, {
        operation,
        index: operation.index,
        phase: 'after',
        expectedHash: operation.afterHash,
        actualHash: afterHash,
        report,
      });
    }
  }

  report.finalHash = hashSimulationState(world, tape.hashOptions || {});
  report.integrity = validateWorldState(world, options.integrityOptions || {});
  if (options.requireIntegrity !== false && !report.integrity.ok) {
    throw createDivergence('Replay completed with invalid world state', { report });
  }
  updateReplaySummary(world, tape, report, null);
  return report;
}

function compareReplayWorlds(expectedWorld, actualWorld, options = {}) {
  return compareCanonicalState(expectedWorld, actualWorld, {
    excludePaths: options.excludePaths || tapeDefaultExcludes(),
  });
}

function exportReplayTape(tape, options = {}) {
  validateTape(tape);
  return options.pretty === false ? JSON.stringify(tape) : JSON.stringify(tape, null, 2);
}

function importReplayTape(value) {
  const tape = typeof value === 'string' ? JSON.parse(value) : cloneValue(value);
  validateTape(tape);
  return tape;
}

function getReplaySummary(world) {
  return cloneValue(ensureReplayState(world));
}

function resolveReplayHandler(handlers, kind) {
  if (typeof handlers === 'function') return handlers;
  const handler = handlers?.[kind] || handlers?.default;
  if (typeof handler !== 'function') throw new Error(`Missing replay handler for ${kind}`);
  return handler;
}

function updateReplaySummary(world, tape, report, divergence) {
  const state = ensureReplayState(world);
  state.replaysRun = Number(state.replaysRun || 0) + 1;
  if (divergence) state.divergences = Number(state.divergences || 0) + 1;
  state.lastReplay = {
    tapeId: tape.id,
    operations: report?.operations?.length || 0,
    finalHash: report?.finalHash || null,
    divergence: cloneValue(divergence),
  };
}

function createDivergence(message, details) {
  return new ReplayDivergenceError(message, cloneValue(details));
}

function validateTape(tape) {
  if (!tape || typeof tape !== 'object') throw new Error('Invalid replay tape');
  if (Number(tape.version) !== REPLAY_VERSION) throw new Error(`Unsupported replay tape version ${tape.version}`);
  if (!Array.isArray(tape.operations)) throw new Error('Replay tape operations must be an array');
  if (!Array.isArray(tape.checkpoints)) tape.checkpoints = [];
  return tape;
}

function sanitizeHashOptions(options) {
  return {
    excludePaths: Array.isArray(options.excludePaths) ? cloneValue(options.excludePaths) : [],
    algorithm: options.algorithm || 'sha256',
  };
}

function tapeDefaultExcludes() {
  return ['accounts', 'apiAudit', 'runtime', 'runtimeLoop', 'engine.replay'];
}

function cloneValue(value) {
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
