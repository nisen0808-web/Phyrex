# PostgreSQL durable world runtime

## Scope

This layer runs the MUD world without an HTTP listener. It consumes the transactional
PostgreSQL store and its durable command inbox. It does not replace the existing
synchronous API, JSONL runtime, or account/player endpoints. No production database
is provisioned.

## Commit boundary

`createDurableWorldRuntime` requires an explicit world ID and an existing valid
PostgreSQL checkpoint. Migration and initial-world import remain explicit operations.
The constructor finishes recovery before allowing a timer or a step.

Each batch clones the last confirmed world, reads at most 100 pending PostgreSQL
commands in FIFO order, executes them against that isolated candidate, then runs the
deterministic modular pipeline (including information and culture/belief systems).
The candidate, next revision, command results and batch event are committed through
one store transaction. Only a matching successful receipt updates the readable world
and invokes `onCommit`. `getWorld()` returns a detached copy, never mutable internals.

There is at most one in-flight step and one pending candidate. Concurrent steps are
rejected with `WORLD_RUNTIME_BUSY`, not queued. Ticks per batch are bounded (default
maximum 100; configurable up to 1000). Command consumption is separately capped at
100 per batch; remaining commands stay pending for later revisions.

## Durable command rules

Commands are read only when creating a new candidate. Once a candidate exists, its
command rows, results, expected revision, request ID and world snapshot are frozen for
retry. A transient SQL error or lost acknowledgement therefore never re-reads the
inbox and never executes a player command twice.

`executePlayerCommand` uses the durable command ID supplied by the inbox. The runtime
refuses a pending command whose ID already exists in the committed world command log,
rather than overwriting historical state. Deterministic rejections such as a missing
player are terminal command results and are acknowledged with the checkpoint so one
bad request cannot poison the queue forever.

Commands arriving after a batch has captured its FIFO input are not inserted into the
in-flight candidate. They remain pending for the next committed revision. Competing
runtime processes may read the same pending rows, but optimistic world revision and
command receipt checks allow only one committed consumer.

## Retry and conflict rules

Connection unavailability, transaction timeout, serialization failure (`40001`) and
deadlock (`40P01`) retain the same candidate, expected revision, metadata, events,
command results and request ID. Retrying never re-runs commands/simulation or consumes
more random values/IDs. Store idempotency resolves a transaction whose acknowledgement
was lost after commit.

Automatic mode uses bounded exponential delay and stops after `maxCommitAttempts`
(default 5). `retry()` permits an explicit retry of a retained transient failure.
Revision conflicts, command conflicts, idempotency conflicts, invalid data/receipts,
simulation errors and unknown errors block the runtime. They are never converted into
a fresh world or overwrite a competing revision.

Runtime configuration fingerprint version 2 includes the command-consumption profile.
Recovery accepts the exact version-1 fingerprint once as a compatibility upgrade from
PR #64; the first new checkpoint writes version 2. Other simulation fingerprint changes
remain rejected. Batch/timing settings do not affect deterministic simulation identity.

## Lifecycle

```js
const { createDurableWorldRuntime } = require('./core/durable-runtime-engine');
const runtime = await createDurableWorldRuntime({
  worldId: 'my_world',
  database: { schema: 'world_engine' },
  ticksPerBatch: 2,
  intervalMs: 1000,
});
await runtime.step();          // commands -> simulate -> SQL commit -> publish
runtime.start();               // non-overlapping continuous batches
runtime.pause();               // stop scheduling; current commit may finish
await runtime.close();         // drain current step and owned pool
```

`summary()` reports committed tick/revision plus total `commandsApplied`; a retained
candidate reports its command count without exposing command payloads.

`close()` never creates an extra batch. An unresolved checkpoint rejects close with
`WORLD_RUNTIME_UNCONFIRMED_CHECKPOINT`; status retains only safe checkpoint metadata.
`close({flush:false})` abandons in-memory retry explicitly. A new process recovers the
actual database head.

`onCommit(result, detachedWorld)` is an optional awaited observer. Observer failures
never re-simulate or undo a committed batch. Timers do not catch up skipped wall-clock
time. Durable batch and command state remain queryable from PostgreSQL.

## Command line

With an existing migrated store and imported world:

```sh
npm --prefix world-engine run runtime:postgres -- --world-id my_world --batches 5 --ticks-per-batch 2
npm --prefix world-engine run runtime:postgres -- --world-id my_world --continuous
```

The runner automatically consumes pending commands for that world. External command
submission itself remains a separate adapter; the current synchronous HTTP routes are
not redirected yet.

`WORLD_ENGINE_DATABASE_URL`, `WORLD_ENGINE_DB_SCHEMA` and PostgreSQL TLS/pool settings
reuse the store configuration. `WORLD_ENGINE_WORLD_ID` can supply the world ID.
No connection URL/password flag is accepted. SIGINT/SIGTERM drains current work and
reports only confirmed revision/tick data.

## Verification

Existing lifecycle and ordering tests remain in normal discovery. This layer adds
`durable-runtime-command-test.js` for controlled-store command semantics: execution
order, deterministic rejection, retry reuse, late-arrival deferral, version-1 config
upgrade, simulation failure and the 100-command batch bound.

`tests/integration/postgres-runtime-commands.js` runs against real PostgreSQL 18 on
Node 20 and Node 22 and verifies:

```text
FIFO command consumption and atomic acknowledgement
terminal deterministic rejection
lost commit acknowledgement without duplicate execution
SQL-trigger command acknowledgement rollback + retry
competing runtime consumers
late command deferral to the next revision
restart after applied command without replay
```

The existing PostgreSQL store, command-inbox and durable-runtime integration suites,
full discovery suites, 100-tick and 1000-tick gates remain mandatory.

## Remaining work

Async HTTP command submission/result polling; production authorization boundary for
player IDs; production credentials/roles, retention, backup/restore, leader leases and
HA. The runner now has durable command execution semantics, but no production service
surface is claimed.

## JSONB ordering regression

PostgreSQL JSONB does not preserve object-key insertion order. The runner canonicalizes
object keys before every default-pipeline tick while preserving array order. This keeps
restart and checkpoint-batch behavior deterministic. Event relationship decay also
accepts numeric rates or `{rate}` and rejects non-finite inputs, avoiding prior NaN
state. Storage validation remains strict.

Reference: https://www.postgresql.org/docs/18/datatype-json.html
