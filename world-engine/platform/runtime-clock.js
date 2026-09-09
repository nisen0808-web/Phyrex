'use strict';

// Operational time for transport, authentication and persistence metadata.
// Simulation systems use world ticks / random-engine, not this adapter.
function wallClockNow() { return Date.now(); }
function wallClockIso() { return new Date().toISOString(); }

// Pure conversion: requires a supplied timestamp; never reads the current time.
function formatTimestamp(milliseconds) {
  if (!Number.isFinite(milliseconds)) throw new TypeError('Timestamp must be finite');
  return new Date(milliseconds).toISOString();
}

module.exports = { wallClockNow, wallClockIso, formatTimestamp };
