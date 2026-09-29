# Deployment

Live: `https://switch.ediprnm-keen.workers.dev`

## Deploy

```bash
python3 scripts/deploy.py
```

The script builds the Worker, uploads it via the Cloudflare API, and
**restores the `* * * * *` cron trigger** afterwards. Raw script uploads
wipe cron schedules — never deploy with plain `wrangler deploy` unless
you re-add the schedule after.

**Never reapply the Durable Object migration** (`[[migrations]] tag =
"v1"` in `wrangler.toml`). Re-running it against the live namespace can
orphan existing DO state.

After deploy, verify:

```bash
# cron is back
wrangler triggers list  # or check via the API
curl https://<worker>/health
```

## Secrets (never committed)

```bash
# 32-byte base64 master key for AES-GCM credential encryption.
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
wrangler secret put MASTER_KEY

# Optional: Google OAuth client secret for Antigravity token refresh.
wrangler secret put ANTIGRAVITY_OAUTH_CLIENT_SECRET

# Optional: bring-your-own OAuth clients (when the built-in OAuth clients
# don't have your Worker callback URL registered).
wrangler secret put ANTIGRAVITY_OAUTH_CLIENT_ID
wrangler secret put CLAUDE_OAUTH_CLIENT_ID
wrangler secret put CODEX_OAUTH_CLIENT_ID
# ... plus optional *_OAUTH_REDIRECT_URI companions

# Optional: web-search backends for search interception.
wrangler secret put BRAVE_API_KEY   # or TAVILY_API_KEY / SERPER_API_KEY / SEARXNG_URL
```

Behavior vars (set in `wrangler.toml` `[vars]` or via the dashboard):

| Var | Effect |
|---|---|
| `SROUTER_CORS_ORIGINS` | Comma-separated allowed CORS origins (loopback always allowed) |
| `SROUTER_DISABLE_REQUEST_LOGS=1` | No `request_logs` writes at all |
| `SROUTER_LOG_ALL_REQUESTS=1` | Log every request, not just errors |
| `SROUTER_LOG_RETENTION_DAYS` | Log pruning retention, default 30 (≤0 disables) |
| `STEALTH_HEADER_OVERRIDES` | JSON header overrides per provider (never logged) |

## First-run admin setup

```bash
curl https://<worker>/api/admin/status
# {"initialized":false}
```

Open `https://<worker>/` in a browser and create the admin account, or:

```bash
curl -X POST https://<worker>/api/admin/setup \
  -H 'Content-Type: application/json' \
  -d '{"password":"..."}' -c cookies.txt
```

Admin passwords are PBKDF2-SHA256 via WebCrypto (100k iterations).

## OAuth callbacks

Register `https://<worker>/v1/auth/<provider>/callback` as an authorized
redirect URI in your OAuth app, then set the client ID/secret secrets
above. Query params `?client_id=` / `?redirect_uri=` on
`/v1/auth/<provider>/login` take precedence over the secrets.

## Use it

```bash
curl https://<worker>/v1/models -H "Authorization: Bearer <virtual-key>"
curl https://<worker>/v1/chat/completions -H "Authorization: Bearer <virtual-key>" \
  -H 'Content-Type: application/json' \
  -d '{"model":"antigravity/gemini-3-pro","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

## Gotchas

- Raw Worker uploads **erase cron schedules** — `scripts/deploy.py`
  restores them; always verify after a manual upload.
- Raw uploads can also drop bindings — the deploy script pins D1, R2,
  and DO bindings explicitly.
- Account/key changes take up to 60s to reach warm isolates (cache TTL).
- The model catalog can briefly list a model removed upstream (stale
  cache, bounded by TTL).
- `wrangler.toml` sets `[limits] cpu_ms = 5000` — headroom for cold-start
  decryption on the paid plan.
