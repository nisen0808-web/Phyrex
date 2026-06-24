# Changelog

All notable changes are documented in this file.

## 1.0.0 — 2026-06-24

First operations-ready release.

### Security

- Added salted `scrypt` account credentials.
- Required credentials for Session creation in production.
- Prevented public role escalation; open registration always creates `player` accounts.
- Added administrator-only account creation and secret rotation.
- Added separate authentication, registration, and general rate limits.
- Restricted CORS to same-origin or exact configured origins.
- Added authenticated SSE and WebSocket event streams.
- Added Content Security Policy and standard browser security headers.
- Rejected Session tokens in ordinary query strings.

### Persistence and reliability

- Restricted production save, load, backup, and listing paths to `MUD_DATA_DIR`.
- Added symbolic-link-aware path validation.
- Added atomic save writes using temporary files, `fsync`, and rename.
- Added rotating backup creation before overwrite.
- Added world restore on startup.
- Added world save during graceful `SIGTERM` and `SIGINT` shutdown.
- Added readiness checks for world state, storage access, and administrator credentials.

### Deployment and operations

- Added production configuration validation and environment template.
- Added `npm start` production entrypoint.
- Added non-root Docker image, healthcheck, persistent volume, and hardened Compose service.
- Added JSON startup and shutdown logs.
- Added deployment, monitoring, backup, restore, upgrade, rollback, and incident runbook.
- Added root README and security policy.

### Browser client

- Added production login-secret input without persisting the secret in browser storage.
- Added production-mode detection and registration-policy notice.
- Added authenticated WebSocket connection bridge.
- Added explicit Session logout.
- Retained gameplay, action queue, command palette, world templates, world insights, workspace layout, saves, and GM console.

### Validation

- Added a production lifecycle integration test covering bootstrap, login, role-escalation prevention, CORS, rate limits, path sandboxing, authenticated WebSocket upgrade, graceful shutdown save, and restart recovery.
