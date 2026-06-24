# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | Yes |
| Development snapshots before 1.0.0 | No production security support |

## Reporting a vulnerability

Do not disclose credentials, Session tokens, save files, or exploitable details in a public issue. Contact the repository owner privately through the available GitHub security-reporting channel.

Include:

- affected commit or version;
- deployment mode and relevant non-secret configuration;
- reproducible request sequence;
- expected and observed behavior;
- impact assessment;
- whether credentials or world data may have been exposed.

## Deployment boundary

Only `npm start` / `world-engine/demo/production-server.js` is intended for an internet-facing deployment behind TLS termination. `npm run api` is a development compatibility server and must remain bound to a trusted local network.

Operators are responsible for:

- protecting `.env.production` and backup archives;
- using a unique high-entropy administrator secret;
- terminating TLS at a trusted reverse proxy or load balancer;
- restricting direct access when `MUD_TRUST_PROXY=true`;
- maintaining external backups of `MUD_DATA_DIR`;
- reviewing security and dependency updates before deployment.
