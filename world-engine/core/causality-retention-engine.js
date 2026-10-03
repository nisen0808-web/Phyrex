'use strict';
const { validateTerminalLimit } = require('./terminal-retention-engine');

function pruneCausality(world, options = {}) {
  const limit = options.maxCausalityRecords;
  validateTerminalLimit(limit, 'maxCausalityRecords');
  if (limit === undefined) return null;
  const records = world.causality || [];
  const pinned = new Set();
  for (const source of [...(world.events || []).filter(row => row.status === 'pending'), ...(world.actionQueue || [])]) {
    for (const id of source.causeIds || []) pinned.add(id);
    if (typeof source.payload?.causeId === 'string') pinned.add(source.payload.causeId);
  }
  for (const process of Object.values(world.processes?.byId || {})) {
    if (process.status === 'resolved') continue;
    for (const id of process.sourceIds || []) pinned.add(id);
    if (typeof process.payload?.causeId === 'string') pinned.add(process.payload.causeId);
  }
  // Summarize only a prefix. Keeping the original addition order preserves
  // even floating-point narrative scores; a pinned prefix reports pressure.
  let remove = Math.max(0, records.length - limit);
  const firstPinned = records.findIndex(row => pinned.has(row.id));
  if (firstPinned >= 0) remove = Math.min(remove, firstPinned);
  const scores = new Map(Object.entries(world.causalityArchive?.scoresByEntity || {}));
  for (const cause of records.slice(0, remove)) {
    const weight = Number(cause.weight || 1);
    if (!Number.isFinite(weight)) throw new Error('Causality weight must be finite');
    for (const id of new Set([cause.sourceId, cause.targetId].filter(id => typeof id === 'string'))) {
      const score = (scores.get(id) || 0) + weight;
      if (!Number.isFinite(score)) throw new Error('Causality score exceeds finite range');
      scores.set(id, score);
    }
  }
  world.causality = records.slice(remove);
  world.causalityArchive = { version: 1, scoresByEntity: Object.fromEntries(scores),
    removedRecords: (world.causalityArchive?.removedRecords || 0) + remove,
    limit, retained: records.length - remove, overLimit: Math.max(0, records.length - remove - limit),
    protectedPrefix: firstPinned >= 0 && firstPinned < records.length - limit };
  return { removed: remove, retained: world.causalityArchive.retained, overLimit: world.causalityArchive.overLimit };
}
module.exports = { pruneCausality };
