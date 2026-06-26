'use strict';

const { registerSystem } = require('./system-scheduler-engine');
const { processEcologyTick } = require('./ecology-engine');
const { NATURAL_WORLD_SYSTEM_ID } = require('./natural-world-system-engine');

const ECOLOGY_WORLD_SYSTEM_ID = 'ecology.world';

function registerEcologyWorldSystem(registry, options = {}) {
  if (!registry || !registry.systems) throw new Error('registerEcologyWorldSystem requires a system registry');
  if (registry.systems[ECOLOGY_WORLD_SYSTEM_ID]) return registry.systems[ECOLOGY_WORLD_SYSTEM_ID];
  return registerSystem(registry, {
    id: ECOLOGY_WORLD_SYSTEM_ID,
    phase: options.phase || 'before',
    priority: Number(options.priority ?? 90),
    after: registry.systems[NATURAL_WORLD_SYSTEM_ID] ? [NATURAL_WORLD_SYSTEM_ID] : [],
    reads: ['locations', 'entities', 'species', 'natural', 'ecology'],
    writes: ['ecology', 'memory'],
    tags: ['simulation', 'ecology', 'world'],
    when: context => {
      const frame = context.shared?.simulationFrame;
      if (!frame) return false;
      return frame.config.autoEcology !== false;
    },
    run: context => {
      const frame = context.shared.simulationFrame;
      const result = processEcologyTick(context.world, frame.config.ecology || {}, context);
      frame.report.ecology = result;
      const counters = frame.simulation.counters;
      addCounter(counters, 'ecologyTicks', 1);
      addCounter(counters, 'ecologyPopulations', result.populations.stats.populations);
      addCounter(counters, 'ecologyMigrations', result.migration.events.length);
      addCounter(counters, 'ecologyDiseaseOutbreaks', result.disease.outbreaks.length);
      addCounter(counters, 'ecologyFoodWebInteractions', result.foodWeb.interactions.length);
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
  ECOLOGY_WORLD_SYSTEM_ID,
  registerEcologyWorldSystem,
};
