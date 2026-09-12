# Durable Command API Rate Limit

The durable command API applies two process-local fixed-window limits before commands can reach the PostgreSQL inbox.

## Source limit

Every HTTP request consumes a source bucket before route parsing, world loading or Bearer validation. The source key is derived only from `req.socket.remoteAddress`. IPv4-mapped IPv6 addresses are normalized. Forwarded-address headers are ignored.

Default: 240 requests per 60 seconds, with at most 5000 tracked source keys.

## Authenticated account limits

After a valid session is loaded from the latest committed world, the service consumes a world/account bucket before player or command access continues.

Defaults:

- POST command submission: 60 per 60 seconds.
- GET command status: 240 per 60 seconds.
- At most 10000 tracked account keys for each limiter.

Revision-conflict reauthorization inside one HTTP request does not consume the account bucket a second time.

## Failure response

A limited request returns:

```text
HTTP 429
{"ok":false,"error":"rate_limited"}
Retry-After: <whole seconds>
```

No account identifier, source key, token, command body or limiter internals are returned.

## Bounds and deployment boundary

Expired windows are purged and limiter maps are capped. The cap prevents unbounded process memory growth, but this remains a single-process control. Multi-instance deployments require distributed or gateway rate limiting.

The engine deliberately does not trust `X-Forwarded-For`. A production reverse proxy should terminate external traffic, apply its own network-level policy and forward only to the loopback/private command API listener.

Configuration:

```text
WORLD_ENGINE_COMMAND_API_SOURCE_RATE_LIMIT
WORLD_ENGINE_COMMAND_API_ACCOUNT_SUBMIT_RATE_LIMIT
WORLD_ENGINE_COMMAND_API_ACCOUNT_READ_RATE_LIMIT
WORLD_ENGINE_COMMAND_API_RATE_LIMIT_WINDOW_MS
WORLD_ENGINE_COMMAND_API_MAX_TRACKED_SOURCES
WORLD_ENGINE_COMMAND_API_MAX_TRACKED_ACCOUNTS
```
