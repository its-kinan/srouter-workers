# Security

## Credential encryption at rest

Provider secrets (API keys, OAuth access/refresh tokens, device ids) are
encrypted with **AES-GCM-256** via WebCrypto before being written to D1.

- Key: `MASTER_KEY` Worker secret, 32 bytes base64. Set with
  `wrangler secret put MASTER_KEY`. Never committed, never logged.
- Nonce: fresh 12 random bytes per encrypted value.
- Stored envelope (TEXT column `providers.secrets_enc`):
  `{"v":1,"iv":"<base64>","ct":"<base64>"}` of the JSON secrets object
  `{api_key?, access_token?, refresh_token?, extra?}`.
- Code: `src/crypto/secretbox.ts`. AAD binds ciphertext to the AES-GCM key;
  version field `v` allows future algorithm upgrades.

SRouter stored these values **plaintext** in SQLite. The port must not. The
legacy plaintext columns (`api_key`, `access_token`, `refresh_token`) exist
only so a future importer can read old databases — new writes keep them NULL.

Key rotation (Phase 2 tooling): decrypt all envelopes with the old key,
re-encrypt with the new key, swap the Worker secret.

## Virtual API keys

Only the **SHA-256 hash** (`api_keys.key_hash`) is stored. The full key is
shown once at creation and cannot be recovered afterwards. Authentication
hashes the presented key and compares digests. Prefix (`key_prefix`) is stored
for display only.

## Admin passwords

**PBKDF2-HMAC-SHA-256**, 210,000 iterations, 16-byte salt, 32-byte hash —
all via WebCrypto (`src/crypto/password.ts`). Stored format:
`pbkdf2$<iterations>$<salt_b64>$<hash_b64>`. Verification uses constant-time
comparison.

SRouter used `node:crypto` `scryptSync`, which has no WebCrypto equivalent;
existing hashes are unverifiable, so the admin (re)creates their password via
the first-run `/api/admin/setup` flow.

## Admin sessions

- 32 random bytes per session, transported in an `HttpOnly`, `SameSite=Lax`
  cookie (`Secure` in production).
- Only the SHA-256 hash is stored (`admin_sessions.token_hash`); 24h expiry;
  expired rows are deleted on sight.
- Cookie-authenticated mutations additionally require a matching `Origin`
  header (CSRF guard).

## What's intentionally out of scope (Phase 1)

- Per-key rate limiting (column exists, enforcement Phase 2).
- Audit logging of admin actions (Phase 2).
- Request/response body redaction in logs: `request_logs` stores metadata,
  token counts, and latency — never prompt/completion text.
