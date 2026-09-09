# PostgreSQL Durable Command Inbox

This layer adds a persistent external-command inbox to the PostgreSQL store. It does not yet change the synchronous HTTP/player routes.

## Ingress

`enqueueCommand` accepts a committed `worldId`, caller-owned durable command `id`, `playerId`, and finite command `input`.

The command ID is unique per world. Repeating exactly the same command is idempotent. Reusing the ID with different player or input data is rejected.

Commands are stored as immutable JSON input with a SHA-256 digest and monotonic database sequence.

## Read path

The store exposes:

```text
enqueueCommand
getCommand
listCommands
listPendingCommands
```

Pending commands are returned FIFO by database sequence. Reads are bounded to at most 1,000 rows.

## Atomic acknowledgement

`saveWorld` accepts `commandResults` in the checkpoint options. Each result binds:

```text
sequence
id
playerId
inputDigest
result
```

A command changes from `pending` to `applied` in the same PostgreSQL transaction as:

```text
world checkpoint
world revision
latest-world pointer
database.world_saved event
caller checkpoint events
```

If the command row no longer matches, has already been consumed by another revision, or the SQL transaction fails, the complete checkpoint rolls back.

The checkpoint idempotency hash includes command results. A lost acknowledgement can therefore safely replay the same save request without applying a command twice.

## Migration

Migration 2 creates `world_commands` with:

```text
monotonic sequence
world_id + command_id uniqueness
player identity
immutable input + digest
pending/applied state
result
applied save sequence
timestamps
bounded indexes for pending and player history
```

Published migration 1 remains unchanged.

## Validation

`postgres-command-inbox-test.js` covers finite command/result capture and checkpoint hashing without claiming SQL integration.

`tests/integration/postgres-command-inbox.js` uses an ephemeral real PostgreSQL 18 database and covers:

```text
migration 2
idempotent ingress
FIFO reads and polling
atomic command acknowledgement
idempotent save replay
forged/stale receipt rollback
SQL-trigger-injected rollback
competing consumers
backlog summary and bounded queries
```

## Next layer

The durable world runtime will consume `listPendingCommands`, execute commands against its isolated candidate world, and pass their results into the same checkpoint transaction. External HTTP submission remains a separate adapter so network retries cannot directly mutate live world memory.
