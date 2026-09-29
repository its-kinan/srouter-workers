# Architecture

Switch is a stateless-edge router: every request runs in a fresh Cloudflare
isolate, so all shared state lives in D1 or Durable Objects, and everything
an isolate can remember (decrypted accounts, catalog, key rows) is cached
isolate-locally with short TTLs.

## Request flow

`POST /v1/chat/completions`:

1. **Auth** — `apiKeyAuth` middleware hashes the bearer key (SHA-256) and
   looks up `api_keys` in D1 (30s isolate-local cache). Enabled / credit /
   quota / model-allow-list / rate-limit checks. Admin session cookie
   bypasses key auth.
2. **Preamble (parallel)** — account load (D1 + AES-GCM decrypt, 60s
   isolate cache, selective by provider prefix) and model catalog fetch
   (DO, 60s isolate cache) run via `Promise.all`. Fallback rules load
   from D1 (60s isolate cache).
3. **Model resolution** — `"<prefix>/<model>"` selects accounts whose
   provider type or alias matches the prefix (e.g. `antigravity/`,
   `qd/`, `th/`); the prefix is stripped before upstream dispatch. Bare
   ids resolve via the aggregated catalog (`<alias>/<id>`). A `#suffix`
   pins to one account (`provider/model#account-id` or `#name`); invalid
   pins return 404 instead of failing over.
4. **Ordering** — candidates are ordered isolate-locally: cooldown
   filtering first, then per-account latency EMA (fastest first, unknown
   accounts get discovery priority), then round-robin rotation. No
   blocking DO call on the request path.
5. **Execution** — each candidate's executor streams; **failover happens
   only before the first chunk**. The first chunk commits the response to
   that provider (HTTP semantics: no mid-response upstream switching).
   Without a configured search backend, streaming passes through without
   buffering.
6. **Reporting (waitUntil)** — success/failure + time-to-first-chunk go to
   the provider's DO shard, which maintains the circuit breaker:
   exponential backoff (30s base, 5min max) on failures, immediate heal on
   success. Rate-limit-looking errors go straight to cooldown; 5
   consecutive non-rate-limit failures mark an account exhausted.
7. **Usage + logs (waitUntil)** — token deltas are batched into the DO
   shard and flushed to D1 `api_keys` every ~30s (persisted in DO storage,
   so eviction can't drop them). Failed requests write one row to
   `request_logs` (error-only by default); successes skip it.

`GET /v1/models` serves the aggregated catalog, edge-cached for 60s via
`caches.default` (restricted keys with `allowed_models` bypass the cache
so filtered lists never leak between keys). `GET /health` reports
per-isolate cache stats.

## Where state lives

| State | Where | Notes |
|---|---|---|
| Accounts, keys, logs, fallback rules, settings, admin | D1 (`srouter-db`) | Source of truth for config |
| Circuit health, latency EMA, round-robin cursors, usage deltas, model catalog, refresh locks | Durable Objects (`RouterState`) | **Sharded per provider** (`router-<type>`); `router` keeps the global catalog + refresh locks |
| Backups / snapshots | R2 (`srouter-data`) | |
| Decrypted accounts, catalog, key rows, fallback rules | Isolate memory | 30–60s TTLs; version-checked against D1 |

Sharding is deliberate: one DO per provider means circuit/usage writes for
one provider never contend with another. Persistence is debounced (~1
write/sec/shard under load).

## Why this shape

The original design did 342 AES-GCM decryptions, two blocking DO
round-trips, and two D1 writes on every request — enough per-request CPU
to trip Cloudflare's 1102 resource-limit errors under load. The current
design pushes everything possible into the isolate (caches, routing
decisions) and moves everything shared into sharded DOs written via
`waitUntil`, so the request path is: auth → parallel preamble → local
ordering → upstream stream.

## Cron (`* * * * *`)

`scheduled()` does three things:

1. **OAuth sweeper** — selects enabled OAuth accounts expiring within 10
   minutes, acquires a per-account lock from the DO (120s TTL), refreshes
   via `src/providers/oauth-refresh.ts`, re-encrypts the secrets envelope.
2. **Log pruning** — once a day (00:00 UTC tick), deletes `request_logs`
   rows older than `SROUTER_LOG_RETENTION_DAYS` (default 30; ≤0 disables).
3. **Catalog rebuild** — refreshes the aggregated model catalog so
   request-time fan-out is never needed.

## Encryption

`src/crypto/secretbox.ts`: AES-GCM-256, unique 12-byte nonce per value,
envelope `{"v":1,"iv":"b64","ct":"b64"}` in `providers.secrets_enc`. Master
key: 32-byte base64 `MASTER_KEY` Worker secret, imported once per isolate.
Legacy plaintext columns exist only for import compatibility; new writes
keep them NULL.

## Deliberately dropped (vs the original SRouter)

- **Cloudflare Tunnel settings page** — meaningless on Workers; the Worker
  URL *is* the public endpoint.
- **In-process scheduling** — replaced by cron triggers.
- **Dual-port OAuth callbacks** — everything is same-origin.
