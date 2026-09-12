# PostgreSQL Durable Command API Audit

This layer adds append-only operational audit records for authenticated durable command API activity. It is intentionally separate from deterministic world memory and from process-local request throttling.

## Storage

Migration 3 adds `command_api_audit` with the following bounded metadata:

```text
sequence
world_id
account_id
player_id (nullable)
command_id (nullable)
command_sequence (nullable)
method
route
status_code
outcome
created_at
```

The table does not contain Bearer tokens, session hashes, raw command input, command input digests, database URLs, SQL exception text, user-agent strings or source IP addresses.

Supported routes are `command.submit` and `command.status`; methods are POST and GET. Rows are indexed by world, account and command for bounded operational inspection.

## POST transaction boundary

A successful authenticated POST passes the acting account ID into `enqueueCommand`. The command row and its success audit row are inserted in the same PostgreSQL transaction while the authorized world revision is fenced.

Outcomes are:

```text
enqueued
idempotent_pending
idempotent_applied
```

If the audit insert fails, the command insert also rolls back. The API does not acknowledge a command that lacks its required success audit record.

Authenticated POST failures that reach authorization/command storage and resolve to a 4xx response are written as separate audit rows, for example `player_forbidden`, `player_not_found`, `command_id_conflict` and final `world_revision_changed`.

## GET response boundary

After a command row is revision-fenced and authorized, GET writes an audit row before sending command data to the client.

Success outcomes are:

```text
read_pending
read_applied
```

If the audit insert fails, the HTTP request fails instead of returning command data without the required operational record.

Authenticated GET 4xx decisions such as `command_forbidden` and `command_not_found` are also recorded.

## What is deliberately not audited durably

Requests that have not reached a valid account identity are not written to PostgreSQL. Source/account 429 rate-limit responses are not durably audited because doing so would turn throttled traffic into database write amplification. Database/migration/timeout/closed-store 5xx failures also do not trigger a second audit write attempt.

Pre-auth JSON/content-type/path validation remains process-local. Network/gateway logs remain the proper layer for anonymous traffic and abuse telemetry.

## Store interfaces

```js
await store.appendCommandApiAudit({...});
await store.listCommandApiAudits({
  worldId: 'world',
  accountId: 'account',
  route: 'command.status',
  statusCode: 403,
  limit: 100,
});
```

Audit reads require `worldId`, are bounded to at most 1000 rows, and support filters for account, player, command, route, status code and sequence cursor. No public HTTP audit endpoint is added by this layer.

Database `summary()` includes `commandApiAudits` for operational status.

## Verification

Normal discovery includes:

- `durable-command-api-audit-test.js` for authenticated success/failure audit policy, safe fields and fail-closed GET behavior.
- `postgres-command-api-audit-contract-test.js` for audit codec validation and Migration 3 registration.

Real PostgreSQL 18 integration (`postgres-command-api-audit.js`) runs on Node 20 and Node 22 and verifies:

1. Migration 3 and summary count.
2. Safe POST audit linked to the real command sequence.
3. Idempotent and command-ID conflict audit outcomes.
4. Authorized, forbidden and missing GET outcomes.
5. Runtime-applied command audit behavior.
6. Trigger-injected POST audit failure rolls back command ingress.
7. Trigger-injected GET audit failure prevents command-data response.
8. Anonymous/rate-limited traffic does not amplify audit writes; audit listing remains bounded and redacted.

Existing store, command inbox, durable runtime, runtime-command, authenticated command API, 100-tick and independent 1000-tick gates remain mandatory.

## Remaining boundary

This is database-backed operational evidence, not a full SIEM or compliance product. Retention/partitioning, archival, external log export, distributed gateway identity, alerting, operator authorization for future audit viewing and production backup/HA remain separate acceptance work.
