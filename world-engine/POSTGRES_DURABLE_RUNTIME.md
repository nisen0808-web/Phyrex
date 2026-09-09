# PostgreSQL durable world runtime

## Scope

This layer runs the MUD world without players or an HTTP listener. It consumes the
transactional store from PR #63. It does not replace the existing synchronous API,
JSONL runtime, or account/player endpoints. No production database is provisioned.

## Commit boundary

`createDurableWorldRuntime` requires an explicit world ID and an existing valid
PostgreSQL checkpoint. Migration and initial-world import remain explicit operations.
The constructor finishes recovery before allowing a timer or a step.

Each batch clones the last confirmed world, runs the deterministic modular pipeline
(including the information and culture/belief systems), removes transient caches,
and captures an immutable candidate. The candidate, next revision and batch event
are committed through one store transaction. Only a matching successful receipt
updates the readable world and invokes `onCommit`. `getWorld()` returns a detached
copy, never the mutable internal world.

There is at most one in-flight step and one pending candidate. Concurrent steps are
rejected with `WORLD_RUNTIME_BUSY`, not queued. Ticks per batch are bounded (default
maximum 100; configurable up to 1000). Persisting every batch is intentional; the
runtime does not expose partially saved ticks.

## Retry and conflict rules

Connection unavailability, transaction timeout, serialization failure (`40001`) and
deadlock (`40P01`) retain the same candidate, expected revision, metadata, events and
request ID. Retrying never re-runs simulation or consumes more random values/IDs.
The store's idempotency rule resolves a commit whose acknowledgement was lost.

Automatic mode uses bounded exponential delay and stops after `maxCommitAttempts`
(default 5). `retry()` permits an explicit retry of a retained transient failure.
Revision conflicts, idempotency conflicts, invalid data/receipts, simulation errors
and unknown errors block the runtime. They are not silently converted into a fresh
world or overwritten. Close and reopen from the latest checkpoint to resolve a
stale runtime; there is no automatic leadership takeover or world-state merge.

A deterministic simulation configuration fingerprint is saved in checkpoint
metadata. Recovery rejects a different fingerprint. Timing/batch-size settings do
not alter the fingerprint. Engine-code-version compatibility and explicit config
migration are not solved by this fingerprint.

## Lifecycle

```js
const { createDurableWorldRuntime } = require('./core/durable-runtime-engine');
const runtime = await createDurableWorldRuntime({
  worldId: 'my_world',
  database: { schema: 'world_engine' }, // URL comes from environment
  ticksPerBatch: 2,
  intervalMs: 1000,
});
await runtime.step();          // simulate -> SQL commit -> publish
runtime.start();               // non-overlapping continuous batches
runtime.pause();               // stop scheduling; current commit may finish
await runtime.close();         // drain current step, retry one pending transient save, close pool
```

`close()` never creates an extra batch. An unresolved checkpoint rejects close with
`WORLD_RUNTIME_UNCONFIRMED_CHECKPOINT`; the status retains the unconfirmed tick and
request ID. `close({flush:false})` explicitly abandons in-memory retry, not a claim
that an ambiguous SQL commit was rolled back. A new process recovers the actual DB
head. Closing drains in-flight work even when flush is false. Injected stores remain
caller-owned unless `closeStore:true`; internally created pools are always closed.

`onCommit(result, detachedWorld)` is an optional awaited observer. Failures increment
`observerErrors` and never re-simulate or undo a committed batch. It must finish
promptly and must not await reentrant `step`, `retry` or `close` calls. Timers do not
catch up skipped wall-clock time. On restart an incomplete pre-commit batch is
recomputed from the last checkpoint; operational notifications are not an exactly-
once delivery system. Durable batch events can be read from PostgreSQL.

## Command line

With an existing migrated store and imported world:

```sh
npm --prefix world-engine run runtime:postgres -- --world-id my_world --batches 5 --ticks-per-batch 2
npm --prefix world-engine run runtime:postgres -- --world-id my_world --continuous
```

`WORLD_ENGINE_DATABASE_URL`, `WORLD_ENGINE_DB_SCHEMA` and PostgreSQL TLS/pool settings
reuse the store configuration. `WORLD_ENGINE_WORLD_ID` can supply the world ID.
No connection URL/password flag is accepted. `--help` needs no database.
SIGINT/SIGTERM stops the scheduling delay, drains the current batch and pool, and
reports only confirmed revision/tick data. Hard process termination can lose only
uncommitted progress; external commands and HTTP acknowledgements are not yet wired
into this runner.

## Verification

`tests/durable-runtime-test.js` adds 13 controlled-store lifecycle groups to the
normal discovery runner (86 scripts). These are contract tests, not SQL evidence.
`tests/integration/postgres-durable-runtime.js` adds 11 real PostgreSQL groups:
commit visibility, lost acknowledgement, SQL-trigger rollback, competing runtimes,
independent competing processes, two CLI process restarts with full-state equality,
SIGTERM, required startup, shutdown flush, configuration mismatch, and a 36-entity
world restart. Missing test
DB configuration fails. Only isolated random schemas in named test databases are
removed. Both Node 20 and Node 22 execute this suite in the mandatory PostgreSQL
workflow; all previous 14 store groups, 100/1000-tick gates remain unchanged.

## Remaining work

Async HTTP/player-command integration; persisted external command ingestion/outbox;
production credentials/roles, retention, backup/restore, leader leases and HA.
SQL commit consistency is implemented here; production operation is not claimed.

## JSONB ordering regression

PostgreSQL JSONB does not preserve object-key insertion order. The runner now
canonicalizes object keys before every default-pipeline tick while preserving array
order. This prevents derived indexes and result digests from changing on restart
and makes checkpoint batch size independent of ordering. Five additional local
ordering contracts cover empty/populated worlds, batching and input validation.

Populated-world validation also exposed an existing event/relationship interface
mismatch: event processing passed `{}` to a numeric decay-rate parameter, creating
NaN relationship values. Decay now accepts either numeric rates or `{rate}`, keeps
explicit zero, and rejects non-finite inputs. Storage validation was not weakened.

Reference: https://www.postgresql.org/docs/18/datatype-json.html
