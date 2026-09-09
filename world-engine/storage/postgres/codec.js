'use strict';
const crypto = require('crypto');
const { createSaveEnvelope, migrateSaveEnvelope, repairLoadedWorld } = require('../../core/persistence-engine');
const { validateWorldSaveRecord } = require('../../core/database-engine');
const { databaseError } = require('./config');

function textId(value, name = 'identifier', max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\u0000')) {
    throw databaseError('INVALID_INPUT', `Invalid ${name}`);
  }
  return value;
}
function safeInteger(value, name = 'number', min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw databaseError('INVALID_INPUT', `Invalid ${name}`);
  return value;
}
function fromSqlInteger(value, name = 'number') {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isSafeInteger(n) || n < 0) throw databaseError('CORRUPT_RECORD', `Invalid stored ${name}`);
  return n;
}
function detachedJson(value) {
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('nonfinite');
      if (['bigint', 'function', 'symbol'].includes(typeof item)) throw new Error('unsupported');
      return item;
    }));
  } catch (_) { throw databaseError('INVALID_INPUT', 'Value is not finite JSON data'); }
}
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
function digest(value) { return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function captureEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw databaseError('INVALID_INPUT', 'Invalid event');
  const payload = detachedJson(input.payload ?? {});
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw databaseError('INVALID_INPUT', 'Event payload must be an object');
  return { id: textId(input.id, 'event id', 256), worldId: textId(input.worldId, 'event worldId'),
    tick: safeInteger(input.tick, 'event tick'), type: textId(input.type, 'event type', 128), payload };
}
function captureCommandInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw databaseError('INVALID_INPUT', 'Command input must be an object');
  const command = detachedJson(input);
  delete command.id;
  textId(command.type, 'command type', 128);
  if (command.payload !== undefined && (!command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload))) {
    throw databaseError('INVALID_INPUT', 'Command payload must be an object');
  }
  return command;
}
function captureInboxCommand(input, maxBytes = 256 * 1024) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw databaseError('INVALID_INPUT', 'Invalid command');
  const command = captureCommandInput(input.input);
  const result = {
    worldId: textId(input.worldId, 'command worldId'),
    id: textId(input.id, 'command id', 256),
    playerId: textId(input.playerId, 'command playerId'),
    input: command,
    inputDigest: digest(command),
  };
  if (Buffer.byteLength(canonicalJson(result)) > maxBytes) throw databaseError('PAYLOAD_TOO_LARGE', 'Command exceeds size limit');
  return result;
}
function captureCommandResult(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw databaseError('INVALID_INPUT', 'Invalid command result');
  const result = detachedJson(input.result);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw databaseError('INVALID_INPUT', 'Command result must be an object');
  const inputDigest = textId(input.inputDigest, 'command input digest', 64);
  if (!/^[0-9a-f]{64}$/.test(inputDigest)) throw databaseError('INVALID_INPUT', 'Invalid command input digest');
  return {
    sequence: safeInteger(input.sequence, 'command sequence', 1),
    id: textId(input.id, 'command id', 256),
    playerId: textId(input.playerId, 'command playerId'),
    inputDigest,
    result,
  };
}
function captureCheckpoint(world, options = {}, maxBytes = 32 * 1024 * 1024) {
  const requestId = textId(options.requestId, 'requestId', 128);
  const expectedRevision = safeInteger(options.expectedRevision, 'expectedRevision');
  // Capture synchronously, before any await, without repairing the caller's live world.
  const metadata = detachedJson(options.metadata ?? {});
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw databaseError('INVALID_INPUT', 'Checkpoint metadata must be an object');
  let envelope;
  try {
    envelope = detachedJson(createSaveEnvelope(detachedJson(world), { reason: options.reason || 'postgres_checkpoint', metadata }));
    validateWorldSaveRecord({ recordType: 'world_save', id: requestId, sequence: 1,
      worldId: envelope.worldId, tick: envelope.tick, schemaVersion: envelope.schemaVersion, envelope });
  } catch (_) { throw databaseError('INVALID_INPUT', 'Invalid finite JSON world checkpoint'); }
  textId(envelope.worldId, 'worldId');
  if (!Array.isArray(options.events ?? []) || (options.events || []).length > 1000) {
    throw databaseError('INVALID_INPUT', 'Checkpoint events must be an array of at most 1000 entries');
  }
  if (!Array.isArray(options.commandResults ?? []) || (options.commandResults || []).length > 1000) {
    throw databaseError('INVALID_INPUT', 'Checkpoint command results must be an array of at most 1000 entries');
  }
  const events = (options.events || []).map((event, index) => captureEvent({ ...event,
    id: event?.id ?? `${requestId}:${index}`, worldId: envelope.worldId, tick: event?.tick ?? envelope.tick }));
  const commandResults = (options.commandResults || []).map(captureCommandResult);
  if (new Set(commandResults.map(item => item.sequence)).size !== commandResults.length
      || new Set(commandResults.map(item => item.id)).size !== commandResults.length) {
    throw databaseError('INVALID_INPUT', 'Checkpoint command results must be unique');
  }
  if (Buffer.byteLength(canonicalJson({ envelope, events, commandResults })) > maxBytes) throw databaseError('PAYLOAD_TOO_LARGE', 'Checkpoint exceeds configured size limit');
  const { savedAt: _savedAt, ...requestEnvelope } = envelope;
  return { requestId, expectedRevision, envelope, events, commandResults, checksum: digest(envelope),
    requestHash: digest({ envelope: requestEnvelope, events, commandResults, expectedRevision }) };
}
function summarizeSave(row, idempotent = false) {
  return { provider: 'postgres', id: row.request_id, worldId: row.world_id,
    revision: fromSqlInteger(row.revision, 'revision'), sequence: fromSqlInteger(row.sequence, 'sequence'),
    tick: fromSqlInteger(row.tick, 'tick'), schemaVersion: Number(row.save_schema),
    savedAt: row.saved_at instanceof Date ? row.saved_at.toISOString() : row.saved_at,
    checksum: row.payload_digest, idempotent };
}
function restoreSave(row) {
  const summary = summarizeSave(row);
  if (digest(row.envelope) !== row.payload_digest) throw databaseError('CORRUPT_RECORD', 'World checkpoint checksum mismatch');
  try {
    validateWorldSaveRecord({ recordType: 'world_save', id: row.request_id, sequence: summary.sequence,
      worldId: summary.worldId, tick: summary.tick, schemaVersion: summary.schemaVersion, envelope: row.envelope });
    const envelope = migrateSaveEnvelope(detachedJson(row.envelope));
    repairLoadedWorld(envelope.world);
    return { ...summary, metadata: envelope.metadata, world: envelope.world };
  } catch (_) { throw databaseError('CORRUPT_RECORD', 'World checkpoint schema or headers are invalid'); }
}
module.exports = { textId, safeInteger, fromSqlInteger, detachedJson, canonicalJson, digest,
  captureCheckpoint, captureEvent, captureCommandInput, captureInboxCommand, captureCommandResult, summarizeSave, restoreSave };
