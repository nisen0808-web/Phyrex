'use strict';

// A terminal-record budget never cancels live work. Protected records can
// exceed the budget; expose that pressure instead of silently breaking links.
function validateTerminalLimit(value, name) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0 || value > 1000000) {
    throw new RangeError(`${name} must be an integer between 0 and 1000000`);
  }
}

function pruneTerminalRecords(state, limit, { isTerminal, terminalTick, protectedIds }) {
  validateTerminalLimit(limit, 'terminal record limit');
  if (limit === undefined) return null;
  const terminal = Object.values(state.byId).filter(isTerminal);
  const candidates = terminal.filter(record => !protectedIds.has(record.id));
  // Explicit tie-breaking survives JSONB key reordering and does not consume RNG.
  candidates.sort((a, b) => terminalTick(a) - terminalTick(b)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const count = Math.min(candidates.length, Math.max(0, terminal.length - limit));
  const removedIds = candidates.slice(0, count).map(record => record.id);
  for (const id of removedIds) delete state.byId[id];
  state.retention = {
    limit,
    removed: (state.retention?.removed || 0) + count,
    retainedTerminal: terminal.length - count,
    protectedTerminal: terminal.length - candidates.length,
    overLimit: Math.max(0, terminal.length - count - limit),
  };
  return { ...state.retention, removedIds };
}

function processReferences(world, kind) {
  const ids = new Set();
  for (const process of Object.values(world.processes?.byId || {})) {
    if (process.status === 'resolved') continue;
    if (process.ownerType === kind && typeof process.ownerId === 'string') ids.add(process.ownerId);
    const id = process.payload?.[`${kind}Id`];
    if (typeof id === 'string') ids.add(id);
    const key = process.payload?.key;
    if (typeof key === 'string' && key.startsWith(`${kind}:`)) ids.add(key.slice(kind.length + 1));
  }
  return ids;
}

function finiteTick(...values) {
  return values.find(value => Number.isFinite(value)) ?? 0;
}

module.exports = { validateTerminalLimit, pruneTerminalRecords, processReferences, finiteTick };
