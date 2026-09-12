'use strict';
const crypto = require('crypto');
const { databaseError } = require('./config');

// Published SQL is immutable: changes require a new numbered migration.
const MIGRATIONS = [
  { version: 1, name: 'transactional_world_checkpoints', sql: `
CREATE TABLE __SCHEMA__.worlds (
  world_id text PRIMARY KEY CHECK (length(world_id) BETWEEN 1 AND 200),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  latest_sequence bigint,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE __SCHEMA__.world_saves (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY CHECK (sequence <= 9007199254740991),
  world_id text NOT NULL REFERENCES __SCHEMA__.worlds(world_id),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  tick bigint NOT NULL CHECK (tick BETWEEN 0 AND 9007199254740991),
  save_schema integer NOT NULL CHECK (save_schema > 0),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  saved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (world_id, revision), UNIQUE (world_id, request_id), UNIQUE (world_id, sequence),
  UNIQUE (world_id, revision, sequence)
);
ALTER TABLE __SCHEMA__.worlds ADD CONSTRAINT worlds_latest_save
  FOREIGN KEY (world_id, revision, latest_sequence) REFERENCES __SCHEMA__.world_saves(world_id, revision, sequence)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE __SCHEMA__.world_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY CHECK (sequence <= 9007199254740991),
  world_id text NOT NULL REFERENCES __SCHEMA__.worlds(world_id),
  save_sequence bigint,
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 256),
  tick bigint NOT NULL CHECK (tick BETWEEN 0 AND 9007199254740991),
  type text NOT NULL CHECK (length(type) BETWEEN 1 AND 128),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (world_id, event_id),
  FOREIGN KEY (world_id, save_sequence) REFERENCES __SCHEMA__.world_saves(world_id, sequence)
);
CREATE INDEX world_events_world_sequence ON __SCHEMA__.world_events(world_id, sequence DESC);
CREATE INDEX world_events_type_sequence ON __SCHEMA__.world_events(type, sequence DESC);
` },
  { version: 2, name: 'durable_command_inbox', sql: `
CREATE TABLE __SCHEMA__.world_commands (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY CHECK (sequence <= 9007199254740991),
  world_id text NOT NULL REFERENCES __SCHEMA__.worlds(world_id),
  command_id text NOT NULL CHECK (length(command_id) BETWEEN 1 AND 256),
  player_id text NOT NULL CHECK (length(player_id) BETWEEN 1 AND 200),
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied')),
  result jsonb,
  applied_save_sequence bigint,
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz,
  UNIQUE (world_id, command_id),
  UNIQUE (world_id, sequence),
  FOREIGN KEY (world_id, applied_save_sequence) REFERENCES __SCHEMA__.world_saves(world_id, sequence),
  CHECK ((status='pending' AND result IS NULL AND applied_save_sequence IS NULL AND applied_at IS NULL)
      OR (status='applied' AND jsonb_typeof(result)='object' AND applied_save_sequence IS NOT NULL AND applied_at IS NOT NULL))
);
CREATE INDEX world_commands_pending_sequence ON __SCHEMA__.world_commands(world_id, sequence) WHERE status='pending';
CREATE INDEX world_commands_player_sequence ON __SCHEMA__.world_commands(world_id, player_id, sequence DESC);
` },
  { version: 3, name: 'durable_command_api_audit', sql: `
CREATE TABLE __SCHEMA__.command_api_audit (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY CHECK (sequence <= 9007199254740991),
  world_id text NOT NULL REFERENCES __SCHEMA__.worlds(world_id),
  account_id text NOT NULL CHECK (length(account_id) BETWEEN 1 AND 200),
  player_id text CHECK (player_id IS NULL OR length(player_id) BETWEEN 1 AND 200),
  command_id text CHECK (command_id IS NULL OR length(command_id) BETWEEN 1 AND 256),
  command_sequence bigint,
  method text NOT NULL CHECK (method IN ('POST','GET')),
  route text NOT NULL CHECK (route IN ('command.submit','command.status')),
  status_code integer NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  outcome text NOT NULL CHECK (length(outcome) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (world_id, command_sequence) REFERENCES __SCHEMA__.world_commands(world_id, sequence)
);
CREATE INDEX command_api_audit_world_sequence ON __SCHEMA__.command_api_audit(world_id, sequence DESC);
CREATE INDEX command_api_audit_account_sequence ON __SCHEMA__.command_api_audit(world_id, account_id, sequence DESC);
CREATE INDEX command_api_audit_command_sequence ON __SCHEMA__.command_api_audit(world_id, command_id, sequence DESC)
  WHERE command_id IS NOT NULL;
` },
].map(m => Object.freeze({ ...m, checksum: crypto.createHash('sha256').update(m.sql).digest('hex') }));
Object.freeze(MIGRATIONS);
function checkMigrationHistory(rows) {
  if (!Array.isArray(rows) || rows.length > MIGRATIONS.length) throw databaseError('SCHEMA_MISMATCH', 'Unsupported database migration version');
  rows.forEach((row, index) => {
    const expected = MIGRATIONS[index];
    if (Number(row.version) !== expected.version || row.name !== expected.name || row.checksum !== expected.checksum) {
      throw databaseError('SCHEMA_MISMATCH', 'Database migration history is incompatible');
    }
  });
  return rows.length;
}
module.exports = { MIGRATIONS, checkMigrationHistory };
