# PostgreSQL Durable Command API

This service exposes authenticated asynchronous command submission and status polling for the PostgreSQL durable world runtime. It does not mutate live world memory and it does not replace the existing synchronous API.

## Endpoints

```text
POST /durable/worlds/:worldId/players/:playerId/commands
GET  /durable/worlds/:worldId/commands/:commandId
```

POST requires `Content-Type: application/json` and a Bearer session token. The request body must contain caller-owned durable `id` and command `type`. The complete command body becomes the immutable inbox input; the top-level ID is stored separately as the durable idempotency key.

A newly queued command returns HTTP 202 and `status=pending`. Reposting the exact same command is idempotent. If the command has already been applied, an exact repost returns HTTP 200 with the existing terminal result. Reusing the same ID for different input or a different player returns conflict.

GET returns the durable pending/applied state. It never executes a command.

## Authorization

Every POST and GET loads the latest committed world checkpoint and validates the Bearer token with the existing account/session model. Session tokens remain stored as hashes inside the world checkpoint.

Normal player accounts can access only player IDs listed in their account. GM/Admin roles retain the existing privileged player-access rule. POST also requires the target player to exist in the latest committed world.

Authorization is revision-fenced. After session/player authorization, POST calls `enqueueCommand` with the exact world revision used for the decision. PostgreSQL locks the world row with `FOR SHARE` while checking that revision, so a concurrent world checkpoint cannot revoke ownership and then allow the stale request to enter the inbox. A revision conflict reloads the latest checkpoint and re-authorizes, for a small bounded number of attempts.

GET similarly binds command lookup to the revision used for authorization. A changed revision causes a fresh authorization pass before command data is returned.

## Response surface

Command responses expose only:

```text
id
worldId
playerId
sequence
status
result (only when applied)
submittedAt
appliedAt
idempotent
```

Input digests, raw command input, SQL details and database connection configuration are not returned. Responses use `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

CORS is not enabled implicitly. Deployment may place a same-origin gateway in front of the service later; this engine layer does not grant browser origins by default.

## Failure mapping

```text
401 auth_required
403 player_forbidden / command_forbidden
404 world_not_found / player_not_found / command_not_found
409 command_id_conflict / world_revision_changed
413 request_body_too_large / command_too_large
415 json_required
503 service_unavailable
500 internal_error
```

Internal SQL exception text and connection strings are not echoed to clients.

## Process entrypoint

```sh
npm --prefix world-engine run api:postgres:commands
```

Default bind address is `127.0.0.1:8791`. PostgreSQL URL, TLS, pool and schema configuration are accepted only through the existing `WORLD_ENGINE_*` environment settings; the command-line entrypoint does not accept a database password/URL flag.

The server validates PostgreSQL readiness/migration state before opening the listener. SIGINT/SIGTERM close the listener and owned pool.

## Validation

`durable-command-api-test.js` uses a controlled PostgreSQL-shaped store and covers authentication, ownership, GM access, idempotency, status polling, response redaction, body limits and an authorization-revision revocation race.

`tests/integration/postgres-command-api.js` runs on an actual ephemeral PostgreSQL 18 server on Node 20 and Node 22. It verifies:

```text
mandatory Bearer authentication and closed CORS default
player ownership and GM access
idempotent durable HTTP submission
cross-player status authorization
HTTP enqueue does not mutate the world before runtime commit
runtime consumes command and GET observes applied result
applied-command repost does not replay execution
store revision fencing on enqueue/read
authorization revocation race cannot enqueue stale command
bounded validation and redacted errors
```

The existing PostgreSQL store, inbox, runtime and runtime-command suites remain mandatory alongside full engine discovery and 100/1000 tick gates.

## Remaining boundary

This is an engine/service primitive, not a production internet deployment. Rate limiting, gateway TLS termination, production secrets, durable session/account mutation workflows, multi-instance leader policy, retention and backup/restore remain separate acceptance work.
