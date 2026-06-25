'use strict';

const {
  hashWorldState,
  hashState,
  compareStates,
  cloneCanonical,
} = require('./state-integrity-engine');

const REPLAY_SCHEMA_VERSION = 1;
const DEFAULT_REPLAY_OPTIONS = {
  stopOnDivergence: true,
  includeReports: true,
  hashOptions: {},
};

function createReplayTape(world, options = {}) {
  if (!world || typeof world !== 'object') throw new Error('createReplayTape requires world');
  const config = { ...DEFAULT_REPLAY_OPTIONS, ...(options || {}) };
  const initialWorld = cloneReplayValue(world);
  return {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    name: options.name || `replay_${world.id || 'world'}_${world.tick || 0}`,
    metadata: { ...(options.metadata || {}) },
    createdAtTick: Number(world.tick || 0),
    initialDigest: hashWorldState(initialWorld, config.hashOptions),
    initialWorld,
    steps: [],
  };
}

function recordReplayStep(tape, world, input = {}, report = null, options = {}) {
  validateReplayTape(tape);
  const config = { ...DEFAULT_REPLAY_OPTIONS, ...(options || {}) };
  const step = {
    index: tape.steps.length,
    tick: Number(world.tick || 0),
    input: cloneReplayValue(input),
    worldDigest: hashWorldState(world, config.hashOptions),
    reportDigest: report === null || report === undefined ? null : hashState(report),
    report: config.includeReports && report !== null && report !== undefined
      ? cloneReplayValue(report)
      : null,
  };
  tape.steps.push(step);
  return step;
}

function captureReplay(world, inputs, runner, options = {}) {
  if (typeof runner !== 'function') throw new Error('captureReplay requires runner');
  const tape = createReplayTape(world, options);
  for (const input of inputs || []) {
    const report = runReplayStep(runner, world, cloneReplayValue(input));
    recordReplayStep(tape, world, input, report, options);
  }
  return tape;
}

function replayTape(tape, runner, options = {}) {
  validateReplayTape(tape);
  if (typeof runner !== 'function') throw new Error('replayTape requires runner');
  const config = { ...DEFAULT_REPLAY_OPTIONS, ...(options || {}) };
  const world = cloneReplayValue(tape.initialWorld);
  const initialDigest = hashWorldState(world, config.hashOptions);
  const divergences = [];
  const reports = [];

  if (initialDigest !== tape.initialDigest) {
    divergences.push({
      step: -1,
      type: 'initial_digest_mismatch',
      expectedDigest: tape.initialDigest,
      actualDigest: initialDigest,
    });
    if (config.stopOnDivergence) {
      return replayResult(world, reports, divergences, tape);
    }
  }

  for (const step of tape.steps) {
    const report = runReplayStep(runner, world, cloneReplayValue(step.input));
    const worldDigest = hashWorldState(world, config.hashOptions);
    const reportDigest = report === null || report === undefined ? null : hashState(report);
    reports.push(report);

    if (worldDigest !== step.worldDigest || reportDigest !== step.reportDigest) {
      const divergence = {
        step: step.index,
        tick: Number(world.tick || 0),
        type: 'step_digest_mismatch',
        expectedWorldDigest: step.worldDigest,
        actualWorldDigest: worldDigest,
        expectedReportDigest: step.reportDigest,
        actualReportDigest: reportDigest,
      };
      if (options.includeStateDiff && step.world) {
        divergence.state = compareStates(step.world, world, config.hashOptions);
      }
      divergences.push(divergence);
      if (config.stopOnDivergence) break;
    }
  }

  return replayResult(world, reports, divergences, tape);
}

function verifyDeterministicExecution(initialWorld, inputs, runner, options = {}) {
  if (typeof runner !== 'function') throw new Error('verifyDeterministicExecution requires runner');
  const firstWorld = cloneReplayValue(initialWorld);
  const secondWorld = cloneReplayValue(initialWorld);
  const steps = [];
  const divergences = [];

  for (let index = 0; index < (inputs || []).length; index += 1) {
    const input = cloneReplayValue(inputs[index]);
    const firstReport = runReplayStep(runner, firstWorld, cloneReplayValue(input));
    const secondReport = runReplayStep(runner, secondWorld, cloneReplayValue(input));
    const firstWorldDigest = hashWorldState(firstWorld, options.hashOptions || {});
    const secondWorldDigest = hashWorldState(secondWorld, options.hashOptions || {});
    const firstReportDigest = hashState(firstReport);
    const secondReportDigest = hashState(secondReport);
    const equal = firstWorldDigest === secondWorldDigest && firstReportDigest === secondReportDigest;
    const step = {
      index,
      equal,
      firstWorldDigest,
      secondWorldDigest,
      firstReportDigest,
      secondReportDigest,
    };
    steps.push(step);
    if (!equal) {
      step.state = compareStates(firstWorld, secondWorld, options.hashOptions || {});
      divergences.push(step);
      if (options.stopOnDivergence !== false) break;
    }
  }

  return {
    ok: divergences.length === 0,
    steps,
    divergences,
    firstWorld,
    secondWorld,
  };
}

function validateReplayTape(tape) {
  if (!tape || tape.schemaVersion !== REPLAY_SCHEMA_VERSION || !tape.initialWorld || !Array.isArray(tape.steps)) {
    throw new Error('Invalid replay tape');
  }
  return tape;
}

function runReplayStep(runner, world, input) {
  const result = runner(world, input);
  if (result && typeof result.then === 'function') {
    throw new Error('Replay runner must be synchronous');
  }
  return result;
}

function replayResult(world, reports, divergences, tape) {
  return {
    ok: divergences.length === 0,
    executedSteps: reports.length,
    expectedSteps: tape.steps.length,
    finalDigest: hashWorldState(world),
    reports,
    divergences,
    world,
  };
}

function cloneReplayValue(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return cloneCanonical(value);
  }
}

module.exports = {
  REPLAY_SCHEMA_VERSION,
  DEFAULT_REPLAY_OPTIONS,
  createReplayTape,
  recordReplayStep,
  captureReplay,
  replayTape,
  verifyDeterministicExecution,
  validateReplayTape,
};
