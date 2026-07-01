'use strict';

const GOVERNANCE_CONFLICT_EFFECTS = {
  SUPPRESS_REVOLT: 'suppress_revolt',
  MOBILIZE_CONFLICT: 'mobilize_conflict',
};

const DEFAULT_CONFLICT_GOVERNANCE_PROCESS_OPTIONS = {
  crackdownSuppressionBase: 8,
  crackdownSuppressionScale: 20,
  mobilizationEscalationBase: 4,
  mobilizationEscalationScale: 12,
};

function applyGovernanceProcessConflictEffects(world, conflict, options = {}) {
  const config = { ...DEFAULT_CONFLICT_GOVERNANCE_PROCESS_OPTIONS, ...(options || {}) };
  const effects = [];
  const processes = getActiveGovernanceConflictProcesses(world);
  for (const process of processes) {
    const responseType = String(process.payload?.responseType || '');
    if (responseType === 'security_crackdown') {
      const effect = applySecurityCrackdownToConflict(world, conflict, process, config);
      if (effect) effects.push(effect);
    }
    if (responseType === 'mobilization') {
      const effect = applyMobilizationToConflict(world, conflict, process, config);
      if (effect) effects.push(effect);
    }
  }
  return effects;
}

function getActiveGovernanceConflictProcesses(world) {
  return Object.values(world.processes?.byId || {})
    .filter(process => process.status === 'active')
    .filter(process => process.type === 'governance_response')
    .filter(process => ['security_crackdown', 'mobilization'].includes(process.payload?.responseType))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function applySecurityCrackdownToConflict(_world, conflict, process, config) {
  const governmentId = process.payload?.governmentId;
  if (!governmentId) return null;
  if (conflict.type !== 'revolt') return null;
  if (!sideMatches(conflict.sideA, 'government', governmentId) && !sideMatches(conflict.sideB, 'government', governmentId)) return null;
  const severity = clamp(Number(process.payload?.severity || 0.1), 0, 1);
  const progress = clamp(Number(process.progress || 0) / 100, 0, 1);
  const before = Number(conflict.intensity || 0);
  const delta = -round((Number(config.crackdownSuppressionBase || 8) + severity * Number(config.crackdownSuppressionScale || 20)) * (0.75 + progress * 0.5), 3);
  conflict.intensity = round(clamp(before + delta, 0, 200), 3);
  addTag(conflict, 'governance_suppressed');
  addCause(conflict, 'security_crackdown');
  return {
    conflictId: conflict.id,
    processId: process.id,
    responseType: 'security_crackdown',
    effect: GOVERNANCE_CONFLICT_EFFECTS.SUPPRESS_REVOLT,
    governmentId,
    intensityBefore: round(before, 3),
    intensityDelta: delta,
    intensityAfter: conflict.intensity,
  };
}

function applyMobilizationToConflict(_world, conflict, process, config) {
  const governmentId = process.payload?.governmentId;
  const organizationId = process.payload?.organizationId;
  if (!governmentId && !organizationId) return null;
  const matches = sideMatches(conflict.sideA, 'government', governmentId)
    || sideMatches(conflict.sideB, 'government', governmentId)
    || sideMatches(conflict.sideA, 'organization', organizationId)
    || sideMatches(conflict.sideB, 'organization', organizationId);
  if (!matches) return null;
  const severity = clamp(Number(process.payload?.severity || 0.1), 0, 1);
  const progress = clamp(Number(process.progress || 0) / 100, 0, 1);
  const before = Number(conflict.intensity || 0);
  const delta = round((Number(config.mobilizationEscalationBase || 4) + severity * Number(config.mobilizationEscalationScale || 12)) * (0.5 + progress), 3);
  conflict.intensity = round(clamp(before + delta, 0, 200), 3);
  addTag(conflict, 'governance_mobilization');
  addCause(conflict, 'mobilization');
  return {
    conflictId: conflict.id,
    processId: process.id,
    responseType: 'mobilization',
    effect: GOVERNANCE_CONFLICT_EFFECTS.MOBILIZE_CONFLICT,
    governmentId: governmentId || null,
    organizationId: organizationId || null,
    intensityBefore: round(before, 3),
    intensityDelta: delta,
    intensityAfter: conflict.intensity,
  };
}

function sideMatches(side, type, id) {
  if (!id) return false;
  return side?.type === type && side?.id === id;
}

function addTag(conflict, tag) {
  if (!Array.isArray(conflict.tags)) conflict.tags = [];
  if (!conflict.tags.includes(tag)) conflict.tags.push(tag);
}

function addCause(conflict, cause) {
  if (!Array.isArray(conflict.causes)) conflict.causes = [];
  if (!conflict.causes.includes(cause)) conflict.causes.push(cause);
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

module.exports = {
  GOVERNANCE_CONFLICT_EFFECTS,
  DEFAULT_CONFLICT_GOVERNANCE_PROCESS_OPTIONS,
  applyGovernanceProcessConflictEffects,
  getActiveGovernanceConflictProcesses,
};
