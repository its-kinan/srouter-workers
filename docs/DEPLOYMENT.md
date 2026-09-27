# Deployment

Phase 1 is built and committed but **not deployed**. These steps deploy it
with Wrangler.

## 1. Create the D1 database

```bash
wrangler d1 create srouter-db
```

Paste the returned `database_id` into `wrangler.toml` (replacing
`REPLACE_WITH_D1_DATABASE_ID`). Then apply the schema:

```bash
npm run db:migrate   # wrangler d1 migrations apply srouter-db
```

## 2. Create the R2 bucket

```bash
wrangler r2 bucket create srouter-data
```

(Phase 1 only needs the binding to exist; archive/snapshot features are Phase 2.)

## 3. Set secrets (never commit these)

```bash
# 32-byte base64 master key for AES-GCM credential encryption.
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
wrangler secret put MASTER_KEY

# Optional: enables the cron sweeper to refresh Antigravity OAuth tokens.
wrangler secret put ANTIGRAVITY_OAUTH_CLIENT_SECRET
```

## 4. Deploy

```bash
wrangler deploy
```

This also registers the `RouterState` Durable Object migration and the
per-minute cron trigger.

## 5. First-run admin setup

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

Note: SRouter used `scrypt` for admin passwords; this port uses
PBKDF2-SHA256 (WebCrypto). Existing SRouter password hashes cannot be
verified — the admin password must be (re)created via `/api/admin/setup`.

## 6. Add providers and virtual keys

Phase 1 admin data endpoints are read-only (`/api/admin/summary`). Writing
accounts/keys is done via D1 until the dashboard lands:

```sql
-- providers row (secrets as AES-GCM envelope; encrypt with MASTER_KEY —
-- see docs/SECURITY.md for the envelope helper)
INSERT INTO providers (id, provider_id, name, category, protocol, secrets_enc, enabled, created_at)
VALUES ('antigravity_1', 'antigravity', 'Antigravity #1', 'oauth', 'gemini', '<envelope>', 1, unixepoch());

-- virtual API key (store only the SHA-256 hash; show the key once)
INSERT INTO api_keys (id, key_hash, key_prefix, name, enabled, created_at)
VALUES ('key_1', '<sha256 hex>', 'sk-...', 'main key', 1, unixepoch());
```

## 7. Use it

```bash
curl https://<worker>/v1/models -H "Authorization: Bearer <virtual-key>"
curl https://<worker>/v1/chat/completions -H "Authorization: Bearer <virtual-key>" \
  -H 'Content-Type: application/json' \
  -d '{"model":"antigravity/gemini-3-pro","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

## Custom domain / routes

Attach a route in `wrangler.toml` or the dashboard when ready:

```toml
# route = { pattern = "srouter.example.com/*", zone_name = "example.com" }
```
