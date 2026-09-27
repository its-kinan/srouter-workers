-- srouter-workers D1 schema (Phase 1)
-- Ported from SRouter packages/db (12 tables). Key differences from SRouter:
--   * Provider/OAuth secrets are NEVER stored plaintext: `providers.secrets_enc`
--     holds an AES-GCM envelope JSON encrypted with the MASTER_KEY Worker secret.
--     The legacy plaintext columns (api_key, access_token, refresh_token) are
--     kept for import compatibility but must stay NULL on new writes.
--   * `oauth_sessions.code_verifier` is likewise encrypted (`code_verifier_enc`).
--   * Virtual API keys store only a SHA-256 hash (`key_hash`); the full key is
--     shown once at creation. SRouter stored the key plaintext.
--   * Admin passwords use PBKDF2-SHA256 (WebCrypto). SRouter used scrypt, which
--     has no WebCrypto equivalent; existing scrypt hashes cannot be verified.
--
-- Applied by wrangler as migration 0001_initial.sql

CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    name TEXT NOT NULL,
    alias TEXT,
    category TEXT NOT NULL,
    protocol TEXT NOT NULL,
    base_url TEXT,
    -- Encrypted secrets envelope (AES-GCM, see docs/ARCHITECTURE.md):
    -- {"v":1,"iv":"base64","ct":"base64"} of JSON {api_key?,access_token?,refresh_token?,extra?}
    secrets_enc TEXT,
    -- Legacy plaintext columns (SRouter import compat). Keep NULL on new writes.
    api_key TEXT,
    access_token TEXT,
    refresh_token TEXT,
    account_id TEXT,
    organization_id TEXT,
    provider_specific_data TEXT,
    custom_headers TEXT,
    token_expires_at INTEGER,
    last_refreshed_at INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT UNIQUE NOT NULL,
    key_prefix TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    rate_limit INTEGER DEFAULT 0,
    quota_limit INTEGER DEFAULT 0,
    usage_tokens INTEGER DEFAULT 0,
    credit_limit REAL DEFAULT 0,
    usage_cost REAL DEFAULT 0,
    allowed_models TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS request_logs (
    id TEXT PRIMARY KEY,
    api_key_id TEXT,
    ip_address TEXT,
    user_agent TEXT,
    provider_id TEXT NOT NULL,
    account_id TEXT,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    status_code INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost REAL NOT NULL DEFAULT 0,
    fallback_occurred INTEGER NOT NULL DEFAULT 0,
    fallback_path TEXT,
    fallback_reason TEXT,
    resolved_model TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_sessions (
    state TEXT PRIMARY KEY,
    code_verifier_enc TEXT,
    code_verifier TEXT,
    device_code TEXT,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    claimed_at INTEGER
);

CREATE TABLE IF NOT EXISTS fallback_rules (
    id TEXT PRIMARY KEY,
    source_model TEXT NOT NULL,
    target_model TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    trigger_on_status TEXT,
    max_retries INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_models (
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS hidden_models (
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS favorite_models (
    model_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_account (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    -- "pbkdf2$<iterations>$<salt_b64>$<hash_b64>" (WebCrypto PBKDF2-SHA256)
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '1');
INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('secret_storage', 'aes-gcm-envelope');

CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_provider_created ON request_logs(provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_provider_model ON request_logs(provider_id, model);
CREATE INDEX IF NOT EXISTS idx_request_logs_model ON request_logs(model);
CREATE INDEX IF NOT EXISTS idx_fallback_rules_priority ON fallback_rules(priority ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_providers_provider_id ON providers(provider_id);
CREATE INDEX IF NOT EXISTS idx_custom_models_provider ON custom_models(provider_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_hidden_models_provider ON hidden_models(provider_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_favorite_models_created ON favorite_models(created_at ASC);
