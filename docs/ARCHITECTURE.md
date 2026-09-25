# Architecture

## Why Workers

SRouter is a stateful Node gateway: an in-process provider registry holds
round-robin cursors and circuit-breaker health, a `setInterval` sweeps OAuth
tokens, and SQLite persists everything. On Cloudflare Workers that state has
to live somewhere else:

| SRouter (Node)                          | srouter-workers                              |
|-----------------------------------------|----------------------------------------------|
| In-memory `ProviderRegistry`            | `RouterState` Durable Object (one, global)   |
| `setInterval` OAuth sweeper             | Cron trigger `* * * * *` → `scheduled()`     |
| SQLite (`packages/db`, 12 tables)       | D1 (`src/db/migrations/0001_initial.sql`)    |
| `scryptSync` admin passwords            | PBKDF2-SHA256 via WebCrypto                  |
| Plaintext provider secrets in SQLite    | AES-GCM envelopes in D1 (`secrets_enc`)      |
| Plaintext virtual API keys              | SHA-256 hashes only                          |
| Cloudflare Tunnel settings page         | Dropped — Workers are publicly reachable     |
| DB export/import (SQLite file copy)     | Deferred — design: SQL/JSON snapshots to R2  |
| Dual-port OAuth callbacks (20128/20129) | Single Worker origin; device-code polling    |
|                                         | state lives in D1/DO (Phase 2)               |

## Request flow

`POST /v1/chat/completions`:

1. `apiKeyAuth` middleware — admin session cookie bypasses key auth; otherwise
   the virtual key is SHA-256-hashed and looked up in D1; enabled / credit /
   quota / model-allow-list checks.
2. Body validated with Zod; model resolved to candidate accounts:
   - `"<prefix>/<model>"` → accounts whose provider type or alias matches the
     prefix (e.g. `antigravity/`, `gcli/`, `qd/`); prefix stripped upstream.
   - bare id → looked up in the DO-cached aggregated catalog (`<alias>/<id>`).
3. The DO's `/route` returns candidates ordered by health (healthy first,
   then shortest remaining cooldown) with round-robin rotation per provider
   base.
4. Each candidate's executor streams; **failover happens only before the first
   chunk**. The first chunk commits us to that provider (HTTP semantics: we
   cannot switch upstreams mid-response).
5. Success/failure is reported to the DO (`/report`), which maintains the
   circuit breaker: exponential backoff (30s base, 5min max) on failures,
   immediate heal on success. Rate-limit-looking errors go straight to
   cooldown; 5 consecutive non-rate-limit failures mark an account exhausted.
6. Usage is tallied from upstream `usage` fields (estimated when absent),
   the request is logged to D1 and the key's token/cost counters bumped
   atomically — all inside `ctx.waitUntil` so logging never delays the client.

`GET /v1/models` serves the DO-cached aggregation (5-min TTL), refreshing
from each account's `listModels()` on miss.

## Durable Object: RouterState

Single instance (`getByName("router")`). Persists to `ctx.storage` on every
mutation:

- `roundRobin: Record<providerBase, number>` — rotation cursors
- `circuit: Record<accountId, CircuitEntry>` — health, consecutive failures,
  cooldown deadlines, last error
- `modelCache: { models, cachedAt } | null`
- `refreshLocks: Record<accountId, heldUntil>` — cron dedup across isolates

RPC is plain JSON-over-fetch (`/route`, `/report`, `/health`, `/models`,
`/refresh/try`, `/reset`). The DO never sees secrets — the Worker passes only
`{ id, base }` refs.

Single-instance is a deliberate Phase 1 choice: one writer means no split
brain for circuit state. If traffic outgrows one DO, shard by provider base.

## Cron sweeper

Every minute, `scheduled()` selects enabled OAuth accounts whose tokens
expire within 10 minutes (or have no recorded expiry), acquires a per-account
lock from the DO (120s TTL), refreshes via `src/providers/oauth-refresh.ts`,
re-encrypts the secrets envelope, and updates D1. Refresh support:

- `openai_codex` — live (public client id, no secret)
- `antigravity` — live when `ANTIGRAVITY_OAUTH_CLIENT_SECRET` Worker secret is
  set; skipped with a warning otherwise (never committed to the repo)
- `qoder` — no-op (SRouter's own QoderOAuth.refreshTokens is a documented
  no-op for device tokens)
- `grok-cli` / `gemini-cli` — Phase 2, with their OAuth onboarding flows

## Encryption

`src/crypto/secretbox.ts`: AES-GCM-256, unique 12-byte nonce per value,
envelope `{"v":1,"iv":"b64","ct":"b64"}` stored in `providers.secrets_enc`.
Master key: 32-byte base64 in the `MASTER_KEY` Worker secret. Key rotation:
re-encrypt envelopes and swap the secret (tooling Phase 2).

## What was deliberately dropped

- **Cloudflare Tunnel page** — meaningless on Workers; the Worker URL *is*
  the public endpoint.
- **In-process scheduling** — replaced by cron triggers.
- **Dual-port OAuth** — SRouter ran OAuth callbacks on a second port; here
  everything is same-origin.
