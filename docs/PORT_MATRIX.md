# SRouter → srouter-workers port matrix

Source: `~/workspace/repos/srouter` (its-kinan/SRouter, v0.1.8-based).
Inventory: `PORT_INVENTORY.md` in that repo.

## Endpoints

| SRouter | Phase 1 | Notes |
|---|---|---|
| `POST /v1/chat/completions` (SSE + JSON) | ✅ | Failover before first chunk; usage tally; D1 logging via waitUntil |
| `GET /v1/models` | ✅ | DO-cached aggregation, `<alias>/<id>` ids |
| `POST /v1/messages` (Anthropic) | ❌ | Phase 2 — vendored Anthropic translator is in tree |
| `GET /v1/models` Anthropic shape | ❌ | Phase 2 |
| `POST /v1/images/generations` | ❌ | Phase 2 — vendored image translator/executor in tree |
| `GET /health` | ✅ | |
| Admin REST (`/api/*`) | 🟡 | Auth + status summary only; full CRUD Phase 2 |
| Dashboard (React) | 🟡 | Phase 1 shell in `public/`; full dashboard Phase 2 |
| Live log stream (SSE) | ❌ | Phase 2 (DO pub/sub or polling) |
| Cloudflare Tunnel page | ➖ | Dropped — meaningless on Workers |

## Gateway behavior

| SRouter | Phase 1 | Notes |
|---|---|---|
| Multi-account round-robin | ✅ | RouterState DO |
| Circuit breaker + failover | ✅ | DO; same thresholds as SRouter (30s base, 5min max) |
| Model combo chains | ❌ | Phase 2 |
| Fallback rules (`fallback_rules`) | ❌ | Table exists in D1 schema; engine Phase 2 |
| Virtual API keys | ✅ | Hash-only storage (SRouter stored plaintext) |
| Key quotas (lifetime tokens) | ✅ | Atomic increments |
| Key credit limits | ✅ | |
| Key rate limits | ❌ | Column exists; enforcement Phase 2 |
| Model allow-lists per key | ✅ | |
| Request logs + analytics | 🟡 | Logging ✅; analytics queries Phase 2 |
| Token saving / caching | ❌ | Phase 2 |
| `web_search` interception | ❌ | Phase 2 |
| Pricing / cost attribution | 🟡 | Usage logged; costs 0 until pricing tables ported (D1/R2) |
| OAuth refresh sweeper | ✅ | Cron; codex + antigravity (secret-gated) |
| DB export/import | ❌ | Deferred — design: SQL/JSON snapshots in R2 |
| Quota pooling | ❌ | Phase 2 |

## Providers

| SRouter provider | Phase 1 | Notes |
|---|---|---|
| antigravity | ✅ | Vendored executor + translator |
| qoder | ✅ | Vendored executor (AES-CBC/RSA via `nodejs_compat`) |
| openai_codex | ✅ | Vendored executor (Responses API) |
| commandcode | ✅ | Vendored executor |
| anthropic | 🟡 | Executor not yet wired; translator in tree |
| atria, bai, cline, codebuddy(-cn), experientiallabs, kiro, minimax, neosantara, opencode_zen, tokenrouter | ❌ | Phase 2 — generic `openai-compatible` covers custom endpoints now |
| grok-cli (not in SRouter; 9router) | ✅ | **New** Responses-API adapter from 9router wire mapping |
| gemini-cli (not in SRouter; 9router) | 🟡 | Scaffold; cloudcode-pa transport Phase 2 |
| openai-compatible (custom endpoints) | ✅ | **New** — covers the nine custom endpoint groups |

See `docs/PROVIDER_MAPPING.md` for prefixes, aliases, and gaps.

## Auth & security

| SRouter | Phase 1 | Notes |
|---|---|---|
| Admin first-run setup | ✅ | Same flow; PBKDF2-SHA256 instead of scrypt |
| Admin sessions | ✅ | Hash-stored tokens, HttpOnly SameSite cookie, Origin check |
| OAuth device-code / PKCE flows | ❌ | Phase 2 (D1/DO-backed polling) |
