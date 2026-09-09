# PostgreSQL transactional checkpoint store

This layer provides a real asynchronous PostgreSQL adapter using the pinned
pure-JavaScript `pg` driver. JSONL remains the existing synchronous default.
No production database is created or connected by repository changes.

## Scope

- Schema-versioned, checksum-verified migrations serialized by a transaction
  advisory lock. Explicit future versions, gaps and modified migrations fail.
- Atomic world checkpoint, latest-world revision and associated event writes.
- Per-world row locks plus a required expected revision reject stale writers.
- A required caller request ID makes retries idempotent. Reusing an ID for
  different checkpoint content fails. Retrying the same request means submitting
  the same frozen world, metadata, events and expected revision.
- Snapshot SHA-256 checksums are verified before loading/repairing a world.
  Checksums detect corruption; they are not authentication against a database
  administrator who can change both content and digest.
- World snapshots are captured before the first asynchronous wait. The live
  in-memory world is not modified by persistence initialization or repair.
- Bounded connection pool, connection/statement/lock timeouts, bounded query
  results, sequence-cursor event queries, detached finite JSON payloads.
- Parameterized values and a strict dedicated-schema identifier. Database
  errors/status do not disclose connection URLs, passwords or raw SQL payloads.
- New PostgreSQL CLI supports explicit migration, status, JSON save import,
  exclusive-file export and event inspection.

## Configuration

Set `WORLD_ENGINE_DATABASE_URL` in the process environment. The `.env.postgres.example`
file is an example, not an automatically loaded configuration file. Never check
real secrets into source control. Optional settings are
`WORLD_ENGINE_DB_SCHEMA` and `WORLD_ENGINE_DB_POOL_SIZE`.

Remote hosts default to verified TLS (`verify-full`). Local loopback hosts default
to `disable`. Supply `WORLD_ENGINE_DB_SSL_CA` when a private CA is required.
The adapter rejects URL SSL parameters that could override its TLS policy.
Schema names must be lower-case identifiers; `public` and `pg_*` are rejected.
Use separate migration and runtime roles in a production configuration; role
provisioning and grants are not performed automatically here.

From `world-engine/`:

```sh
npm ci --ignore-scripts
npm run database:postgres -- migrate
npm run database:postgres -- status
npm run database:postgres -- import --input output/world.json --expected-revision 0 --request-id initial-import
npm run database:postgres -- export --world-id world --output output/exported-world.json
npm run database:postgres -- events --world-id world --limit 50
```

Export refuses to overwrite an existing file. Import of an existing world must
supply its current database revision, not its tick. Migration is an explicit
command; normal reads/writes do not automatically modify the schema.

## Programmatic API

```js
const { createDatabaseStore } = require('./core/database-engine');
const store = createDatabaseStore({ provider: 'postgres' });
try {
  // Run explicitly during migration setup, not every game tick:
  await store.migrate();
  const previous = await store.loadWorld('world');
  const result = await store.saveWorld(world, {
    expectedRevision: previous?.revision ?? 0,
    requestId: commandId,
    events: [{ type: 'world.checkpoint', payload: { reason: 'scheduled' } }],
  });
  console.log(result.revision);
} finally {
  await store.close();
}
```

Use `createPostgresDatabaseStore` from `core/postgres-database-engine.js` for
PostgreSQL-specific options such as `maxConnections`, `maxEnvelopeBytes`,
`statementTimeoutMillis`, `lockTimeoutMillis` and `connectionTimeoutMillis`.
Do not use the synchronous top-level `saveWorldToDatabase` / `loadWorldFromDatabase`
functions with PostgreSQL: only the factory dispatch and explicit async adapter
support PostgreSQL in this layer.

`loadWorld()` selects automatically only when there is exactly one world.
Multiple worlds require `worldId`. `loadWorld(id, { revision: n })` reads an
explicit historical revision. Latest means the committed world-head revision,
not the largest simulation tick. Rollback saves may have a lower tick.

All PostgreSQL store methods perform asynchronous I/O and must be awaited:
`migrate`, `summary`, `saveWorld`, `loadWorld`, `listWorlds`, `appendEvent`,
`listEvents`, `close`. Global identity sequences may have gaps after rollback;
they do not imply a contiguous history across different worlds.

## Transaction boundaries

One checked-out client executes BEGIN, all checkpoint writes and COMMIT.
Checkpoint event failure rolls back the snapshot, new-world row (when applicable),
latest revision and every related event. The caller receives success only after
COMMIT. A lost connection during COMMIT can leave the result unknown; retry the
same request ID and unchanged snapshot to resolve it safely. There is no blind
retry of a changed live world and no automatic overwrite on revision conflict.

Reads use a read-only repeatable-read transaction. Row locks serialize writers
per world; an outdated expected revision fails instead of overwriting another
process's newer checkpoint. This guards persistence writes, not simultaneous
world simulation: runtime ownership/leader coordination is a separate concern.

## Tests and CI

The normal discovery runner includes six groups in
`tests/postgres-database-contract-test.js`; these need no database and are not
claimed as SQL integration evidence.

`npm run test:postgres` requires `WORLD_ENGINE_TEST_DATABASE_URL` pointing to a
database whose name ends in `_ci` or `_test`. It never silently skips. The suite
creates a random isolated schema, uses the actual `pg` driver and tests 14 groups:
concurrent/repeatable migration, checkpoint/event atomicity, connection restart,
random/ID continuation, lower-tick saves, idempotency/stale writes, independent
writer processes, SQL-trigger-injected rollback, concurrent retries, event
cursors, parameterized IDs, checksum/SQL constraints, migration guards, real CLI
import/export/status, and unavailable-database errors.

The dedicated `World Engine PostgreSQL` workflow runs these groups against an
actual ephemeral PostgreSQL 18 service on Node 20 and Node 22. Test credentials
are only for that discarded CI container. Cleanup is restricted to the randomly
named test schema and an explicitly named test database.

## Remaining boundaries

The existing API server, JSONL recovery and synchronous runtime loop have NOT
been switched to PostgreSQL. SQL async runtime integration/backpressure is a
subsequent layer; setting an existing API provider flag alone does not enable it.
There is no automatic JSONL history migration, database retention, production
backup/restore exercise, replication/failover, deployment or HA claim here.
The legacy JSON save import copies one chosen checkpoint; it is not a full
history migration. Existing JSONL files are left untouched.
