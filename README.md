# srouter-workers

A port of [SRouter](https://github.com/its-kinan/SRouter) (its-kinan/SRouter, fork of
seaavey/SRouter) to Cloudflare Workers. One OpenAI-compatible endpoint fans out
to many provider accounts (OAuth or API key) with round-robin load balancing,
circuit-breaker failover, virtual API keys, request logging, and an admin
dashboard — with no VPS.

```
                        ┌──────────────────────────────────────────────┐
                        │            Cloudflare Worker (Hono)          │
                        │                                              │
  client ──Bearer key──▶│  /v1/chat/completions   /v1/models           │
                        │  /api/admin/*           static dashboard     │
                        │         │                                    │
                        │         ▼                                    │
                        │  ┌─────────────┐   ┌──────────────────────┐   │
                        │  │ RouterState │   │ providers/registry   │   │
                        │  │ Durable Obj │◀──│ + vendored executors │   │
                        │  │  (1/global) │   │ (antigravity, qoder, │   │
                        │  └─────────────┘   │  codex, commandcode, │   │
                        │         │          │  grok-cli, gemini,   │   │
                        │         ▼          │  openai-compat)      │   │
                        │  ┌─────────────┐   └──────────────────────┘   │
                        │  │     D1      │            │                 │
                        │  │ accounts /  │            ▼                 │
                        │  │ keys / logs │      upstream providers     │
                        │  │ settings    │                             │
                        │  └─────────────┘                             │
                        │         ▲                                    │
                        │  cron * * * * * (OAuth token sweeper)        │
                        └──────────────────────────────────────────────┘
                                    R2: log archive / snapshots (Phase 2+)
```

## Phase 1 status

Working: `/health`, `POST /v1/chat/completions` (SSE + JSON, failover before
first chunk), `GET /v1/models`, virtual API keys (hash-only storage, quotas),
request logging to D1 with `waitUntil`, admin first-run setup/login (PBKDF2),
round-robin + circuit breaker in a Durable Object, per-minute OAuth refresh
cron (Codex live; Antigravity via Worker secret; qoder is a documented no-op),
AES-GCM credential encryption, minimal dashboard shell.

Not yet: full React dashboard, Anthropic-compatible endpoints, image
generation, model-combo chains, fallback rules engine, per-key rate limiting,
web_search interception, DB export/import (designed: SQL snapshots to R2),
gemini-cli chat transport (scaffold), grok-cli/gemini-cli OAuth onboarding.

See `docs/PORT_MATRIX.md` for the full SRouter feature mapping.

## Quick start (local)

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # unit tests (crypto, routing, DO logic)
```

## Deploy

See `docs/DEPLOYMENT.md`. Summary: create the D1 database, apply
`src/db/migrations`, `wrangler secret put MASTER_KEY` (32-byte base64),
`wrangler deploy`. Never commit secrets — the repo contains none.

## Security model

- Provider secrets are AES-GCM encrypted (WebCrypto) with a Worker-secret
  master key before touching D1. Plaintext credential columns exist only for
  import compatibility and stay NULL on new writes.
- Virtual API keys: only SHA-256 hashes stored; the full key is shown once.
- Admin passwords: PBKDF2-SHA256 (SRouter used scrypt, which has no WebCrypto
  equivalent — passwords reset on first deploy via `/api/admin/setup`).
- Admin sessions: random token in an HttpOnly SameSite cookie; only the hash
  is stored. Cookie mutations require an Origin check.

See `docs/SECURITY.md`.

## Layout

- `src/index.ts` — Worker entry, routes, cron sweeper
- `src/router/durable.ts` — RouterState Durable Object
- `src/providers/` — registry, new grok-cli adapter, gemini-cli scaffold, OAuth refresh
- `src/vendor/` — SRouter code vendored for Workers (translators, executors, types)
- `src/db/` — D1 schema + migrations
- `src/crypto/` — AES-GCM envelopes, PBKDF2
- `src/routes/`, `src/middleware/` — HTTP layer
- `public/` — Phase 1 dashboard shell
- `docs/` — architecture, port matrix, provider mapping, deployment, security
