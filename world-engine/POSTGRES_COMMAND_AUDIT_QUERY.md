# PostgreSQL Privileged Command Audit Query

## Endpoint and permission boundary

`GET /durable/worlds/:worldId/admin/audit` exposes the durable request audit added in PR #70.
A valid Bearer session from the latest committed world is required. Only accounts
with a `gm` or `admin` role may read that world's audit; regular player accounts
receive `403 audit_forbidden`. This endpoint never enqueues a command or changes
world state.

Authorization passes the exact world revision to `auditStore.list(query,
{ expectedWorldRevision })`. The store checks the world's revision and reads
audit records inside the same PostgreSQL `REPEATABLE READ READ ONLY` transaction.
A checkpoint committed before that read snapshot invalidates stale authorization
and triggers a bounded reload/re-authorization (default three attempts). A
checkpoint concurrent with an already established snapshot does not retroactively
invalidate that snapshot; the response is consistent with that authorized revision.

The path world ID is mandatory and always scopes the SQL query. Cross-world
filter overrides are rejected. Each world has its own account/session state;
a privileged session in one world is not automatically valid in another.

## Query contract

All parameters are optional. Unknown and repeated keys are rejected with
`400 invalid_audit_query`, including `worldId`, `order` and `afterSequence`.

| Parameter | Accepted value |
|---|---|
| limit | Decimal integer 1–1000, default 100 |
| beforeSequence | Positive decimal safe integer, exclusive upper cursor |
| accountId | Nonblank string, at most 200 characters, no NUL |
| playerId | Nonblank string, at most 200 characters, no NUL |
| commandId | Nonblank string, at most 256 characters, no NUL |
| method | GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, CONNECT or TRACE |
| route | submit, status, audit or unknown |
| statusCode | Decimal integer 100–599 |

Numeric values reject negative signs, decimal points, exponent notation, spaces,
empty strings and values above JavaScript's safe-integer range. IDs are matched
exactly rather than trimmed. SQL values are parameterized.

Example:

```text
GET /durable/worlds/my_world/admin/audit?limit=50&route=submit&statusCode=202
Authorization: Bearer <session>
```

The response is:

```json
{
  "ok": true,
  "data": {
    "records": [
      {
        "sequence": 42,
        "requestId": "example-request-id",
        "worldId": "my_world",
        "accountId": "gm-account",
        "playerId": null,
        "commandId": null,
        "method": "GET",
        "route": "audit",
        "statusCode": 200,
        "errorCode": null,
        "createdAt": "2026-10-01T00:00:00.000Z"
      }
    ],
    "nextBeforeSequence": null
  }
}
```

Records are always ordered by sequence descending. Preserve filters and pass the
returned `nextBeforeSequence` to fetch older rows. A full page returns its last
sequence as the next cursor; a short/empty page returns null. A full final page
can therefore be followed by an empty page. The cursor is a continuation hint,
not an exact total or a guarantee that another record exists.

New records with a higher sequence do not enter an in-progress backward traversal.
In particular, the audit written for each query does not cause pagination to chase
its own tail. To see new records, start a new request without a cursor. This is a
live operational log: separate pages do not retain a single database snapshot, and
sequence allocation is not transaction commit ordering. A lower sequence that
commits late may appear on a later page or require refreshing; this API does not
claim a lossless point-in-time export.

## Limits, redaction and auditing

The existing source limiter runs before parsing/loading/authentication.
Authenticated audit queries share the account read limiter with command status
polling (world + account key). A revision retry consumes that account quota only
once for the whole HTTP request. Defaults and environment settings remain those
in `POSTGRES_COMMAND_API.md`. A limit rejection is `429 rate_limited` with
`Retry-After`. Default CORS remains closed.

Responses explicitly select the eleven safe fields shown above. Raw command
input, input digest, Authorization/Bearer tokens, database configuration and SQL
error text are never included. Query strings and filter values are not copied
into the request audit; its logical route is `audit` and command/player identity
remain null. Only authenticated account identity is recorded.

The response is constructed and ended before the request's audit append starts,
so it cannot include itself. Audit persistence is separate from the read: failure
increments `auditStats().failures` without altering the response. It is attempted
once; a failed append must not be routed through HTTP error handling or rewritten
as a fictitious HTTP 500 audit. This isolation also preserves outcomes on the
existing submission/status endpoints.

If an application injects the compatibility memory audit adapter rather than a
PostgreSQL query store, privileged reads fail with `503 service_unavailable`.
The normal CLI constructs the PostgreSQL audit store automatically.

Additional responses include `401 auth_required`, `404 world_not_found`,
`405 method_not_allowed`, `409 world_revision_changed` after exhausted revision
retries, `503 service_unavailable` for recognized storage availability failures,
and a redacted `500 internal_error` for unknown faults.

## Running and validation

No migration or new dependency is needed. Published Migration 1–3 remain
byte-for-byte unchanged. Use the existing migrated PostgreSQL configuration:

```bash
npm --prefix world-engine run api:postgres:commands
node world-engine/tests/durable-command-audit-query-test.js
npm --prefix world-engine run test:postgres:command-audit-query
```

The HTTP regression has eleven controlled-store scenario groups, including
permission revocation, shared read quota, pagination, validation and write-failure
isolation. It is automatically included in the full discovery runner.

The new SQL script requires `WORLD_ENGINE_TEST_DATABASE_URL` ending in `_ci` or
`_test` and never silently skips. It uses real PostgreSQL queries to verify ten
groups: world/revision fences, roles, parameterized filters, pagination with newer
appends, query self-exclusion, committed role revocation, re-authorization quotas,
one repeatable-read snapshot across revision and records, safe SQL failures and
trigger-injected audit write failure. The existing six SQL suites remain mandatory.
The Node 20/22 PostgreSQL 18 workflow retains explicit Bash/pipefail and a checked
`10 passed, 0 failed` marker for the additional suite.

## Remaining boundary

No retention policy, durable audit retry queue, complete shutdown drain guarantee,
leader lease, distributed limiter, production deployment or legacy synchronous
action-route migration is added here. Operational audit may still be lost during
a crash after responding; it is not atomic with a world mutation.
