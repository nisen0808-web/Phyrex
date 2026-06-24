# Production Operations — v1.0.0

## 1. Release scope

This runbook applies to the production entrypoint:

```bash
npm start
```

It does not apply to `npm run api`, which is the compatibility-oriented local development server.

## 2. First deployment

1. Copy `.env.production.example` to `.env.production`.
2. Generate a unique administrator secret of at least 20 random characters.
3. Keep `.env.production` outside source control and restrict it to the service operator.
4. Start the service.
5. Verify `/ready` returns HTTP 200 and `"ready": true`.
6. Open `/client`, enter `MUD_ADMIN_ID` and `MUD_ADMIN_SECRET`, then create a Session.
7. Create player accounts through `POST /admin/accounts`, or explicitly enable open player registration.

Docker Compose:

```bash
cp .env.production.example .env.production
chmod 600 .env.production
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8790/ready
```

Direct Node.js:

```bash
set -a
. ./.env.production
set +a
npm start
```

## 3. Authentication and account provisioning

### Administrator login

```bash
curl -X POST http://127.0.0.1:8790/sessions \
  -H 'Content-Type: application/json' \
  -d '{"accountId":"admin","secret":"<ADMIN_SECRET>"}'
```

Use the returned token as `Authorization: Bearer <TOKEN>`.

### Create a player account

```bash
curl -X POST http://127.0.0.1:8790/admin/accounts \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"id":"player_001","name":"Player 001","roles":["player"],"secret":"<PLAYER_SECRET>"}'
```

### Rotate an account secret

```bash
curl -X POST http://127.0.0.1:8790/admin/accounts/player_001/secret \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"secret":"<NEW_PLAYER_SECRET>","revokeSessions":true}'
```

Rotation revokes all active Sessions by default.

### Registration policies

```text
admin     authenticated GM/admin creates accounts; default
open      unauthenticated registration is allowed, but roles are forced to player
disabled  account creation endpoint is disabled
```

Never use `open` unless public signup is an intentional operating decision.

## 4. TLS and reverse proxy

The Node process serves HTTP. Terminate TLS at a reverse proxy or load balancer.

When the proxy supplies trusted `X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto` headers, set:

```text
MUD_TRUST_PROXY=true
```

Only enable this when requests cannot bypass the trusted proxy. Configure exact cross-origin frontend origins with `MUD_CORS_ORIGINS`; do not use wildcard origins.

The proxy must support WebSocket upgrade for `/ws/ticks` and long-lived responses for `/stream`.

## 5. Health and monitoring

Liveness:

```text
GET /health
```

Readiness:

```text
GET /ready
```

Readiness is false when the data directory is not readable/writable, no world is loaded, or no privileged account has a credential.

Authenticated operational endpoints:

```text
GET /admin/status
GET /admin/runtime
GET /admin/loop
GET /admin/connections
GET /admin/audit
GET /admin/errors
GET /admin/security
GET /admin/accounts
```

Monitor at minimum:

- readiness status;
- world tick progress;
- runtime-loop error count;
- last autosave tick and timestamp;
- API error rate and HTTP 429 frequency;
- disk usage and backup age;
- unexpected growth of accounts or Sessions.

Logs are JSON Lines on stdout/stderr. Collect them with the container runtime or service manager.

## 6. Persistence, backups, and restore

All production persistence is constrained to `MUD_DATA_DIR`. The server rejects paths outside that root, including symbolic-link escapes.

Primary files:

```text
MUD_WORLD_FILE          primary state loaded at startup and saved at shutdown
MUD_AUTOSAVE_FILE       runtime-loop autosave target
*.bak.<timestamp>       rotating backup created before overwriting a save
```

### Backup

Pause or stop the runtime loop for a point-in-time copy, then back up the complete data directory or Docker volume.

```bash
curl -X POST http://127.0.0.1:8790/admin/loop/pause \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"reason":"operator_backup"}'

docker run --rm \
  -v phyrex_phyrex-data:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine sh -c 'tar czf /backup/phyrex-$(date +%Y%m%d-%H%M%S).tgz -C /data .'
```

### Restore

1. Stop the service.
2. Copy the selected backup into the data volume.
3. Ensure `MUD_WORLD_FILE` points to the restored primary save.
4. Start the service.
5. Verify `/ready`, world ID, tick, accounts, and runtime-loop state before reopening traffic.

Do not restore a save with a schema version newer than the running binary.

## 7. Graceful shutdown

`SIGTERM` and `SIGINT` perform the following sequence:

1. stop the continuous runtime loop;
2. save the current world with reason `shutdown`;
3. create a rotating backup of the previous primary save;
4. close HTTP, SSE, and WebSocket connections;
5. exit after the configured grace period.

Docker Compose uses a 20-second stop grace period. Keep `MUD_SHUTDOWN_TIMEOUT_MS` lower than the orchestrator grace period.

## 8. Upgrade procedure

1. Confirm current `/ready` and latest successful autosave.
2. Create an external backup of the data volume.
3. Record current image digest or Git commit.
4. Deploy the new image without deleting the data volume.
5. Verify `/ready`, login, dashboard, save listing, world tick, and WebSocket connection.
6. Review `/admin/errors` and logs before completing the rollout.

For a single-instance deployment, expect a short maintenance window. The current engine does not support concurrent writers to one world file.

## 9. Rollback procedure

1. Stop the failed release.
2. Restore the prior image or commit.
3. If the failed release wrote an incompatible save, restore the pre-upgrade data backup.
4. Start the prior release and verify readiness.

The persistence layer uses atomic rename writes, reducing the chance of a partially written primary file, but it does not replace external backups.

## 10. Incident actions

### Suspected credential compromise

- rotate the affected account secret with `revokeSessions=true`;
- rotate the bootstrap administrator secret by setting `MUD_ROTATE_ADMIN_SECRET=true` for one controlled startup;
- reset the variable to `false` after verification;
- inspect `/admin/audit` for account IDs, player IDs, paths, status codes, and errors.

### Repeated login failures

- inspect 401 and 429 counts;
- reduce `MUD_RATE_AUTH_MAX` if appropriate;
- block abusive sources at the reverse proxy or firewall;
- do not reveal whether an account ID exists.

### Save failure or disk exhaustion

- pause the runtime loop;
- free disk space without deleting the newest known-good external backup;
- verify data-directory ownership and write permission;
- call `/ready` and manually save before resuming.

### Runtime loop errors

- pause or stop the loop;
- inspect `/admin/errors`, `/admin/runtime`, and logs;
- create a manual save if the world remains valid;
- restore the latest known-good backup if state integrity is uncertain.

## 11. Known v1.0.0 operating limits

- One active writer process per world data directory.
- In-memory rate limits reset when the process restarts.
- Account authentication is shared-secret based; external identity providers are not included.
- Horizontal scaling requires an external coordination and persistence layer, which is outside v1.0.0.
- TLS termination is delegated to the deployment environment.
