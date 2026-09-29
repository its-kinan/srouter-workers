# Security

## Credential encryption at rest

Provider secrets (API keys, OAuth access/refresh tokens, device ids) are
encrypted with **AES-GCM-256** via WebCrypto before being written to D1.

- Key: `MASTER_KEY` Worker secret, 32 bytes base64. Set with
  `wrangler secret put MASTER_KEY`. Never committed, never logged.
  Imported once per isolate; decrypted accounts cached isolate-locally
  (60s) so warm requests don't re-decrypt.
- Nonce: fresh 12 random bytes per encrypted value.
- Stored envelope (TEXT column `providers.secrets_enc`):
  `{"v":1,"iv":"<base64>","ct":"<base64>"}` of the JSON secrets object
  `{api_key?, access_token?, refresh_token?, extra?}`.
- Code: `src/crypto/secretbox.ts`. AAD binds ciphertext to the AES-GCM key;
  version field `v` allows future algorithm upgrades.

Legacy plaintext columns (`api_key`, `access_token`, `refresh_token`)
exist only for import compatibility — new writes keep them NULL.

Key rotation: decrypt all envelopes with the old key, re-encrypt with the
new key, swap the Worker secret.

## Virtual API keys

Only the **SHA-256 hash** (`api_keys.key_hash`) is stored. The full key is
shown once at creation and cannot be recovered afterwards. Authentication
hashes the presented key and compares digests (30s isolate-local row
cache; misses are never cached so new keys work immediately). Prefix
(`key_prefix`) is stored for display only.

Per-key controls: model allow-lists, lifetime token quotas, credit limits,
per-minute rate limits (429 + `Retry-After`; 0 = unlimited). Usage
counters are batched through the DO shard (~30s flush), so quota reads
can lag the flush window.

## Admin passwords

**PBKDF2-HMAC-SHA-256**, 100,000 iterations, 16-byte salt, 32-byte hash —
all via WebCrypto (`src/crypto/password.ts`). Stored format:
`pbkdf2$<iterations>$<salt_b64>$<hash_b64>`. Verification uses constant-time
comparison. Admin account is created via the first-run
`/api/admin/setup` flow.

## Admin sessions

- 32 random bytes per session, transported in an `HttpOnly`,
  `SameSite=Lax` cookie (`Secure` in production).
- Only the SHA-256 hash is stored (`admin_sessions.token_hash`); 24h
  expiry; expired rows are deleted on sight.
- Cookie-authenticated mutations additionally require a matching `Origin`
  header (CSRF guard).

## Request logging

`request_logs` stores metadata only — token counts, latency, model,
status, cost estimate, IP, user agent. **Prompt and completion text is
never logged.** Error-only by default
(`SROUTER_DISABLE_REQUEST_LOGS=1` disables entirely,
`SROUTER_LOG_ALL_REQUESTS=1` restores full logging). Rows older than
`SROUTER_LOG_RETENTION_DAYS` (default 30) are pruned daily.
