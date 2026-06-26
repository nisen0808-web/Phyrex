'use strict';

const { registerSystem } = require('./system-scheduler-engine');
const { processNaturalWorldTick } = require('./natural-world-engine');

const NATURAL_WORLD_SYSTEM_ID = 'natural.world';

function registerNaturalWorldSystem(registry, options = {}) {
  if (!registry || !registry.systems) throw new Error('registerNaturalWorldSystem requires a system registry');
  if (registry.systems[NATURAL_WORLD_SYSTEM_ID]) return registry.systems[NATURAL_WORLD_SYSTEM_ID];
  return registerSystem(registry, {
    id: NATURAL_WORLD_SYSTEM_ID,
    phase: options.phase || 'before',
    priority: Number(options.priority ?? 100),
    reads: ['locations', 'natural'],
    writes: ['natural', 'locations', 'memory'],
    tags: ['simulation', 'natural', 'world'],
    when: context => {
      const frame = context.shared?.simulationFrame;
      if (!frame) return false;
      return frame.config.autoNatural !== false;
    },
    run: context => {
      const frame = context.shared.simulationFrame;
      const result = processNaturalWorldTick(context.world, frame.config.natural || {}, context);
      frame.report.natural = result;
      const counters = frame.simulation.counters;
      addCounter(counters, 'naturalTicks', 1);
      addCounter(counters, 'weatherUpdates', result.weather.updated.length);
      addCounter(counters, 'resourcesRegenerated', result.resources.regenerated.length);
      addCounter(counters, 'naturalDisastersStarted', result.disasters.started.length);
      addCounter(counters, 'naturalDisasterImpacts', result.disasters.impacts.length);
      return result;
    },
  });
}

function addCounter(counters, key, amount) {
  if (!counters) return;
  if (counters[key] === undefined) counters[key] = 0;
  counters[key] += Number(amount || 0);
}

module.exports = {
  NATURAL_WORLD_SYSTEM_ID,
  registerNaturalWorldSystem,
};
