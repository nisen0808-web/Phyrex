# Phyrex World Engine

Phyrex is a persistent MUD world-simulation engine with a browser gameplay and operations client. Version **1.0.0** is the first deployment-oriented release: it adds credential-based sessions, locked-down registration, storage sandboxing, atomic saves, readiness checks, graceful shutdown, container deployment, and an operations runbook.

## Development

Requirements: Node.js 20 or later.

```bash
npm test
npm run api
```

Open `http://127.0.0.1:8790/client`.

The development API intentionally retains convenient defaults. Do not expose `npm run api` directly to the public internet.

## Production

Create a private environment file:

```bash
cp .env.production.example .env.production
```

Set a long random `MUD_ADMIN_SECRET`, then start with Docker Compose:

```bash
docker compose up -d --build
```

Or run directly:

```bash
set -a
. ./.env.production
set +a
npm start
```

The service exposes:

```text
GET  /health       liveness
GET  /ready        readiness and bootstrap checks
GET  /client       browser gameplay and operations client
POST /sessions     credential-based login
WS   /ws/ticks     authenticated world event stream
```

The default registration policy is `admin`: only an authenticated GM/admin can create accounts. Public registration can be enabled explicitly with `MUD_REGISTRATION_POLICY=open`; requested roles are still forced to `player`.

## Production security defaults

- Authentication and account credentials are mandatory.
- Account secrets are stored as salted `scrypt` records; raw secrets are never persisted.
- Session creation requires the account secret.
- File persistence is restricted to `MUD_DATA_DIR` and uses atomic rename writes.
- Cross-origin access is same-origin only unless exact origins are configured.
- Authentication, registration, and general requests have independent rate limits.
- WebSocket and SSE event streams require a valid Session.
- Security headers and a restrictive Content Security Policy are enabled.
- The world is saved during graceful `SIGTERM`/`SIGINT` shutdown.

## Data and recovery

The default container data directory is `/data`:

```text
/data/world.json             primary world save
/data/autosave/world.json    continuous-loop autosave
/data/*.bak.*                rotating backups
```

Back up the entire data volume. The server validates that configured save paths remain inside the data directory, including paths traversing symbolic links.

## Documentation

- [`world-engine/QUICKSTART.md`](world-engine/QUICKSTART.md) — development and feature overview
- [`world-engine/BROWSER_CLIENT.md`](world-engine/BROWSER_CLIENT.md) — browser gameplay and operations client
- [`world-engine/API.md`](world-engine/API.md) — API reference
- [`world-engine/PRODUCTION_OPERATIONS.md`](world-engine/PRODUCTION_OPERATIONS.md) — deployment, backup, monitoring, upgrades, and incidents
- [`SECURITY.md`](SECURITY.md) — supported version and vulnerability reporting
- [`CHANGELOG.md`](CHANGELOG.md) — release history

## Validation

```bash
npm test
npm run test:production
npm run stress
```

The default suite includes the production lifecycle: first bootstrap, credential login, role-escalation prevention, CORS enforcement, storage sandboxing, authenticated WebSocket upgrade, graceful shutdown save, and restart recovery.
