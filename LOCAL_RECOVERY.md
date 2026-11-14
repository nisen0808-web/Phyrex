# Local development and recovery

The Render release was cancelled at the owner's request on 2026-11-14
(Asia/Singapore). Continue development locally. Publishing source to GitHub
does not authorize a Render deployment. Do not resume the former hosted writer.

This checkout starts from merged commit
`9e216426359c5f16e324a96af42e7901bbf7ed2d` (PRs #85 and #86), and integrates
the previously uncommitted read-diagnostics work from the older local checkout.
The original checkouts and their Git histories are preserved separately.

## Source and private data

This public repository contains source, tests, and configuration examples.
Keep database archives, database URLs, live tokens, account credentials,
operator reports and restored database directories outside the repository.
The local recovery handoff identifies the actual private archive and its
SHA-256 and restore verification. Never upload a complete operator directory.

## Restore a database archive

Use PostgreSQL 18 tools compatible with the archive. Create a new empty local
database and a new local owner; keep its password in local configuration.
The operator's custom-format `pg_dump` archive is restored with `pg_restore`
(`--no-owner --no-acl --exit-on-error --single-transaction`) into that empty
database. It is not the engine's NDJSON backup format and must not be passed
to `database:backup restore`.

The logical archive excludes original cluster roles and grants. Recreate local
permissions explicitly. Keep the new server bound to loopback and use the
`phyrex_trial` schema for the former trial world. Any additional archived
schemas are historical recovery checks, not additional active writers.
Verify the archive hash before restoration and compare restored table counts,
complete row fingerprints and sequence state with the private manifest.

## Run and verify locally

Use Node.js 20 or 22, install the pinned dependencies with
`npm --prefix world-engine ci --ignore-scripts`, then run
`npm --prefix world-engine test`. Follow
[the engine quickstart](world-engine/ENGINE_QUICKSTART.md) for local startup.
Use fresh local credentials, the restored `phyrex_trial` schema and world ID
`phyrex-trial`; only one runtime may advance that world. Start from a working
copy of the restored database, retaining the verified archive unchanged.

Run SQL integration checks only against a disposable database whose name ends
in `_test` or `_ci`, as required by the test harness. Never point tests at the
restored world database or the former Render endpoint.

On native Windows, the engine's backup publication and destructive maintenance
fail closed when directory synchronization is unsupported. A separately
verified native PostgreSQL dump does not prove power-loss durability of the
Windows directory entry. See [backup policy](world-engine/POSTGRES_BACKUP.md).
