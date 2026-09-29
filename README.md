# Switch

Edge-native LLM router on Cloudflare Workers. One OpenAI-compatible endpoint
fans out to hundreds of provider accounts (OAuth or API key) with
latency-aware routing, circuit-breaker failover, virtual API keys, per-key
quotas, and token usage tracking — no VPS.

Conceptually forked from [SRouter](https://github.com/its-kinan/SRouter);
rewritten for the edge. It is not SRouter anymore.

## How it works

```
  client ──Bearer key──▶  Cloudflare Worker (Hono)
                          │
                          ├─▶ POST /v1/chat/completions (SSE + JSON)
                          ├─▶ POST /v1/messages (Anthropic)
                          ├─▶ POST /v1/images/generations
                          ├─▶ GET  /v1/models (edge-cached, 60s)
                          ├─▶ /v1/admin/*, /v1/keys/*, /v1/providers/*,
                          │   /v1/logs/*, /v1/auth/* (OAuth), dashboard
                          │
                          ▼
                    ┌──────────────┐
                    │   preamble   │  auth → accounts → catalog (parallel)
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │    routing   │  latency-aware order, cooldown,
                    │              │  circuit breaker, account pinning
                    └──────┬───────┘
                           ▼
                     upstream provider ──stream──▶ client
                     (failover before first chunk)

  State:
    D1  (srouter-db)    accounts, virtual keys, request logs,
                        fallback rules, settings, admin
    DO  (RouterState)   sharded per provider: circuit health,
                        latency EMA, round-robin cursors, usage
                        batching, model catalog, refresh locks
    R2  (srouter-data)  backups / snapshots
```

## Features

- **Multi-provider failover** — per-request candidate ordering across all
  accounts serving a model; automatic retry on the next account before the
  first chunk commits the response.
- **Latency-aware routing** — per-account time-to-first-chunk EMA tracked in
  the DO shard; fastest healthy accounts are tried first. Unknown accounts
  get discovery priority; broken accounts stay in cooldown regardless of
  speed.
- **Circuit breakers** — exponential backoff on failures (30s base, 5min
  max); rate-limit-looking errors go straight to cooldown; consecutive
  failures mark an account exhausted until it heals.
- **Account pinning** — `provider/model#account-id` (or `#name`) routes to
  one specific account; invalid pins 404 instead of silently failing over.
- **Virtual API keys** — SHA-256 hash-only storage, per-key model
  allow-lists, lifetime token quotas, credit limits, per-minute rate limits
  (429 + `Retry-After`).
- **Token usage tracking** — per-key `usage_tokens`/`usage_cost` batched
  through the DO shard and flushed to D1 every ~30s (survives DO eviction).
- **Error-only request logging** — `request_logs` records failed requests
  for investigation; successes skip the write. Metadata only — token
  counts, latency, model, status, cost estimate. Prompt/response text is
  never logged. Full logging restorable via `SROUTER_LOG_ALL_REQUESTS=1`;
  rows older than `SROUTER_LOG_RETENTION_DAYS` (default 30) are pruned
  daily by cron.
- **OAuth** — device-code and callback flows for Antigravity (Google),
  Codex (OpenAI), Claude (Anthropic), Qoder, CodeBuddy, Grok CLI (xAI);
  per-minute cron sweeper refreshes expiring tokens. Bring-your-own OAuth
  client IDs supported when the built-in clients don't have your callback
  URL registered.
- **Web-search interception** — optional server-side search tool injection
  (Brave/Tavily/Serper/SearXNG); streaming bypasses buffering entirely when
  no search backend is configured.
- **Stealth fingerprints** — per-provider request header presets with
  per-credential overrides.
- **Dashboard** — full React admin UI (accounts, keys, logs, analytics,
  providers, OAuth onboarding) served by the Worker itself.

## Performance

Built to stay cheap per request on the free tier:

- Isolate-local caches (60s accounts, 60s catalog, 60s fallback rules,
  30s API-key rows, 5s providers-version check) — a warm isolate serves
  the preamble with ~zero D1 reads.
- Decrypted accounts cached per isolate; selective decrypt loads only the
  providers a request can touch; master key imported once per isolate.
- Routing decisions are isolate-local (round-robin + cooldown); the DO is
  only hit for circuit reports (via `waitUntil`) and catalog reads.
- `RouterState` sharded per provider instead of one global instance;
  persistence debounced to ~1 write/sec/shard under load.
- Token usage batched through the DO (~30s flush) instead of one D1
  `UPDATE` per request.
- Chat preamble fetches run in parallel; `/v1/models` is edge-cached.
- `[limits] cpu_ms = 5000` in `wrangler.toml` as headroom for cold starts.

## Quick start (local)

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # 116 unit tests (crypto, routing, DO logic, caches)
```

## Deploy

Live: `https://switch.ediprnm-keen.workers.dev`

```bash
python3 scripts/deploy.py
```

The deploy script builds the Worker, uploads it, and restores the
`* * * * *` cron trigger (raw script uploads wipe cron schedules — the
script handles this). Never reapply the Durable Object migration.

Secrets (via `wrangler secret put`, never committed):

| Secret | Purpose |
|---|---|
| `MASTER_KEY` | 32-byte base64 key for AES-GCM credential encryption |
| `ANTIGRAVITY_OAUTH_CLIENT_SECRET` | Google OAuth client secret for Antigravity token refresh |
| `*_OAUTH_CLIENT_ID` / `*_OAUTH_REDIRECT_URI` | Bring-your-own OAuth clients (Antigravity, Claude, Codex) |
| `BRAVE_API_KEY` / `TAVILY_API_KEY` / `SERPER_API_KEY` / `SEARXNG_URL` | Web-search backends (optional) |

Behavior vars: `SROUTER_CORS_ORIGINS`, `SROUTER_DISABLE_REQUEST_LOGS=1`
(no log writes at all), `SROUTER_LOG_ALL_REQUESTS=1` (log successes too),
`SROUTER_LOG_RETENTION_DAYS` (default 30).

First run: open `https://<worker>/` and create the admin account
(`POST /api/admin/setup`). Admin passwords are PBKDF2-SHA256 (WebCrypto).

See `docs/DEPLOYMENT.md` for the full procedure.

## Docs

- `docs/ARCHITECTURE.md` — request flow, state layout, caching, cron
- `docs/DEPLOYMENT.md` — deploy procedure, secrets, gotchas
- `docs/PROVIDERS.md` — provider/model prefixes, aliases, adding a provider
- `docs/SECURITY.md` — encryption, keys, sessions

## Layout

- `src/index.ts` — Worker entry, routes, cron
- `src/router/` — completion flow, model catalog, RouterState DO
- `src/providers/` — registry, executors, OAuth refresh
- `src/routing/` — fallback rules engine
- `src/vendor/` — vendored translators/executors
- `src/routes/`, `src/middleware/` — HTTP layer
- `src/db/` — D1 schema + migrations
- `src/crypto/` — AES-GCM envelopes, PBKDF2
- `scripts/` — `deploy.py`, dashboard inliner
- `test/` — unit tests
