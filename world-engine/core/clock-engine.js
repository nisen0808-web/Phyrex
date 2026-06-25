'use strict';

function wallClockNow() {
  return Date.now();
}

function monotonicNow() {
  return process.hrtime.bigint();
}

function elapsedMilliseconds(startedAt) {
  const elapsed = process.hrtime.bigint() - BigInt(startedAt);
  return Number(elapsed) / 1e6;
}

function futureIso(delayMs, now = wallClockNow()) {
  return new Date(Number(now) + Math.max(0, Number(delayMs || 0))).toISOString();
}

module.exports = {
  wallClockNow,
  monotonicNow,
  elapsedMilliseconds,
  futureIso,
};
