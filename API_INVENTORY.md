# API Inventory — SRouter Dashboard → Cloudflare Workers Port

**Purpose:** Complete reference of every `/v1/*` endpoint the real React dashboard
(`apps/web`) calls, with request/response shapes taken from the **server**
controllers in `apps/api/src` (not just the client), plus the DB tables each
handler touches. Written 2026-09-25 from `its-kinan/SRouter` (fork of
`seaavey/SRouter` v0.1.8).

**Scope note:** the dashboard never calls the gateway endpoints
`POST /v1/chat/completions`, `/v1/messages`, or `/v1/images/*` — those serve
external LLM clients. (`/v1/chat/completions` appears in `apps/web` only inside
curl examples in the combo components.) They are gateway surface, not dashboard
surface, and are not inventoried here beyond this note.

## Global conventions

- Success: `Ok(c, data, status?)` returns the payload as **raw JSON — no envelope**.
- Errors: OpenAI-style `{ error: { message: string, type: string, code?: string, param?: string } }`
  where `type` derives from status (`authentication_error` 401, `permission_error` 403,
  `rate_limit_error` 429, `invalid_request_error` 400/404/409/422).
- **Auth guards:** `RequireAdmin` = valid admin session cookie; `ApiKeyAuth` = valid
  virtual API key (or admin session). Reads are usually `ApiKeyAuth`, mutations are
  `RequireAdmin`.
- **Admin cookie:** `srouter_admin_session`, HttpOnly, `path=/`, `SameSite=Lax`,
  `secure` only when `SROUTER_SECURE_COOKIES=true`, 7-day TTL. Value is a 32-byte
  base64url token; the server stores only its **SHA-256 hex** in
  `admin_sessions.token_hash`. `RequireAdmin` rejects with **401**
  `{ error: { message: "Admin authentication is required", code: "authentication_required" } }`
  — never 403; authorization is binary.
- **Password hashing (original):** scrypt (N=16384, r=8, p=1, 64-byte key), stored as
  `scrypt$16384$8$1$<salt>$<hash>` in `admin_account.password_hash`.
  (Workers port uses PBKDF2-SHA256/100k — hashes are NOT portable.)
- **Provider credentials (original):** stored **in plaintext** in the `providers`
  table (`api_key`, `access_token`, `refresh_token` columns). No encryption at rest.
  (Workers port encrypts with AES-GCM.)
- **Virtual API keys (original):** stored **in plaintext** in `api_keys.key`
  (`sr-live-<16 hex>`); auth is a direct `WHERE key = ?` match.
  (Workers port stores SHA-256 hashes only.)
- **DB tables** (from `packages/db/src/db.ts`): `providers`, `api_keys`,
  `request_logs`, `oauth_sessions`, `fallback_rules`, `system_settings`,
  `custom_models`, `hidden_models`, `favorite_models`, `admin_account`,
  `admin_sessions`, `srouter_schema_meta`.
- Web client (`apps/web/src/lib/api.ts`): `fetch` with `credentials: "include"`,
  JSON bodies; `api.get/post/patch/put/delete` helpers; 204 → `undefined`.

---

# 1. Admin auth & first-run setup

## GET /v1/admin/status
- **Method/path:** `GET /v1/admin/status` — public, no auth, always 200.
- **Web call site:** `components/auth/AdminAuthGate.tsx` — TanStack Query, `retry: false`, `staleTime: 0`.
- **Query/body:** none.
- **Response:**
```ts
{ setupRequired: boolean; authenticated: boolean }
```
- **DB:** `admin_account` (read row `id=1` → `setupRequired = !exists`);
  `admin_sessions` (lookup by SHA-256 of cookie token, check `expires_at` → `authenticated`).
- **Notes:** This is the single source of truth for dashboard auth state.

### "Not initialized" vs "logged out" (AdminAuthGate logic)
There is **no `useAuth` hook** — all logic lives in `AdminAuthGate.tsx`:
- Query pending → "Checking admin session…" screen.
- Query error (network failure; `/status` never 401s) → "Gateway unavailable" + retry.
- `setupRequired: true` → setup mode ("Create your admin password", password+confirmation),
  POSTs `/v1/admin/setup`. Server: no `admin_account` row.
- `setupRequired: false, authenticated: false` → login mode ("Sign in to SRouter",
  single password field), POSTs `/v1/admin/login`. Server: account exists, no valid
  session cookie.
- `authenticated: true` → renders the app. After setup/login the form refetches `/status`.
- The distinction is driven by **200 response fields**, never status codes.

## POST /v1/admin/setup
- **Web call site:** `AdminAuthGate.tsx` (setup mode only).
- **Request body:** `{ password: string; confirmation: string }`
  (zod: both non-empty; server additionally enforces ≤128 chars and match).
- **Response:** `201 { authenticated: true }` + sets session cookie (immediately signed in).
  Errors: `403 { code: "setup_local_only" }` when caller is **not loopback**
  (`127.0.0.1`/`::1`, `::ffff:` stripped — socket address, no proxy-header trust);
  `409 { code: "setup_already_complete" }` (race-safe single row `id=1`);
  `400 { code: "invalid_password" }` / `{ code: "password_mismatch" }`.
- **DB:** `admin_account` (INSERT `id=1, password_hash, created_at, updated_at`);
  `admin_sessions` (INSERT `token_hash, created_at, expires_at`).
- **Notes:** First-run only. Also auto-bootstrappable via `SROUTER_ADMIN_PASSWORD`
  env (creates **or resets** the password on every boot — the recovery path).
  **Workers porting:** the loopback-only check is meaningless on Workers (always
  remote); keep first-claim-wins semantics but add another guard or accept the risk.

## POST /v1/admin/login
- **Web call site:** `AdminAuthGate.tsx` (login mode).
- **Request body:** `{ password: string }`.
- **Response:** `200 { authenticated: true }` + sets session cookie.
  Errors: `401 { code: "invalid_credentials" }` (also on schema failure, anti-oracle);
  `429 { code: "login_rate_limited" }` after **5 failures per client IP** → 15-min block.
- **DB:** `admin_account` (read `password_hash`); `admin_sessions` (INSERT).
- **Notes:** Rate-limit state is an **in-memory** `Map<ip, {count, blockedUntil}>`
  (per-process, lost on restart).

## POST /v1/admin/change-password
- **Web call site:** `components/settings/settings.security.tsx`.
- **Request body:** `{ current_password: string; new_password: string; confirmation: string }`.
- **Response:** `200 { message: "Admin password updated successfully" }`.
  Errors: `401 authentication_required` (bad/missing session),
  `401 invalid_credentials` (wrong current password), `400 invalid_password`
  (new ≤128 chars; min 6 enforced client-side only), `400 password_mismatch`,
  `500 password_update_failed`.
- **DB:** `admin_sessions` (verify); `admin_account` (UPDATE `password_hash`, `updated_at`).
- **Notes:** Route has no `RequireAdmin` — the controller verifies the session itself.
  Does **not** rotate other sessions; they stay valid.

## POST /v1/admin/logout
- **Web call site:** **none — the web app never calls it** (no logout UI exists).
- **Request/response:** no body; `204` empty + clears cookie (clears cookie and returns
  `401 authentication_required` if session invalid).
- **DB:** `admin_sessions` (SELECT by token hash, then DELETE — revokes that one session).

---

# 2. Database export / import

## GET /v1/admin/database/export
- **Web call site:** `lib/databaseTransfer.ts` → `exportDatabase()`
  (`fetch("/v1/admin/database/export", { credentials: "include" })` → Blob),
  triggered from `components/settings/settings.data.tsx` ("Export Database"),
  saved locally as `srouter-backup-<ISO-timestamp>.db`.
- **Response:** `200`, `Content-Type: application/octet-stream`,
  `Content-Disposition: attachment; filename="srouter-backup-<YYYYMMDDHHMMSS>.db"`,
  body = raw SQLite file bytes. Errors: `400 unsupported_storage` (PostgreSQL
  backend), `500 database_transfer_failed`.
- **DB:** whole active SQLite file via `VACUUM INTO` snapshot (all tables).
- **Notes:** Requires admin session. Takes a file-level transfer lock.
  **Cannot work on Workers** (`node:fs` + `node:sqlite` `VACUUM INTO`).

## POST /v1/admin/database/import
- **Web call site:** `lib/databaseTransfer.ts` → `importDatabase(file)`; from
  `components/settings/settings.data.tsx` ("Import Database", `.db` files only,
  confirm dialog). On success: `reauth_required` → `window.location.assign(...)`;
  else toast with backup path / restart notice.
- **Request:** `multipart/form-data` with **exactly one file part named `database`**
  (must have filename; max **25 MiB** enforced by content-length pre-check and the
  streaming parser; errors `upload_too_large`, `missing_database_file`,
  `invalid_database_field`, `invalid_multipart`).
- **Response:** `200 { ok: true; backup_path: string; restart_required: boolean; reauth_required: boolean }`
  — in practice always `restart_required: false`, `reauth_required: true`.
  `backup_path` looks like `~/.srouter/backups/import-backup-<Date.now()>.db`.
  On success the server **deletes the `srouter_admin_session` cookie**, forcing re-login.
  Errors: `400 invalid_database` (integrity/schema), `400 upload_too_large`,
  `409 database_import_busy`, `500 database_recovery_failed` / `database_transfer_failed`,
  `400 unsupported_storage` (Postgres).
- **DB:** replaces the **entire SQLite file**. Validation: `PRAGMA integrity_check`,
  column/type/nullability/default/PK match, required indexes (incl. unique
  `api_keys(key)`), `srouter_schema_meta.schema_version = "1"`. Required tables:
  `providers`, `api_keys`, `request_logs`, `oauth_sessions`, `fallback_rules`,
  `system_settings`, `custom_models`, `admin_account`, `admin_sessions`,
  `srouter_schema_meta`.
- **Server procedure:** stream upload to `~/.srouter/transfer-temp-*/database.db` (0600)
  → validate → acquire `.transfer.lock` → close shared connection → snapshot current
  DB to backup path (0600) → replace active file → remove `-wal`/`-shm` sidecars →
  reopen. On post-rename failure restores the backup (`database_recovery_failed` if
  that fails). **Cannot work on Workers** (`node:fs`, `node:sqlite`, process signals).

---

# 3. OAuth / token-import (`/v1/auth/*`)

Routers mounted at `/v1`. Shared conventions:
- Login JSON mode: `200 { authorizeUrl, state, codeVerifier, redirectUri }` —
  the server generates PKCE and **returns `codeVerifier` to the browser**.
  (Web `lib/pkce.ts` `generateBrowserPKCE` is **dead code — never imported**.)
- Callback success: `200 { success: true, message: string, provider: ProviderConfig }`.
- Token import: `201 { success: true, message: string, provider: ProviderConfig }`.
- Callback/token errors: `500 { error: { message, type: "api_error" } }`;
  login-init errors: OpenAI/Claude rethrow, Antigravity/Qoder return
  `400 { error: { message, type: "invalid_request_error" } }`.
- `ProviderConfig`: `{ id, providerId, name, alias?, category?, protocol?, base_url?, apiKey?, accessToken?, refreshToken?, accountId?, tokenExpiresAt?, lastRefreshedAt?, organizationId?, customHeaders?, providerSpecificData?, enabled: boolean, createdAt }` — **tokens in cleartext**.
- `/login`, `/poll`, `/device`, `/token` carry `RequireAdmin`. **`/callback` routes are
  public** (no RequireAdmin) by design — upstream redirects the browser there;
  security rests on the unguessable `state` in `oauth_sessions`.
- OAuth temp state lives in **`oauth_sessions`** (`state` PK, `code_verifier`,
  `device_code`, `client_id`, `redirect_uri`, `created_at`, `claimed_at`) — **in DB,
  not in-memory**. Polling claims (`SET claimed_at`) → releases while pending →
  deletes on success. Expired rows (>15 min) purged on initiate/callback.
- Web driver: `hooks/useOAuthConnect.ts` + `components/providers/providers.oauth-flow.tsx`
  (popup `window.open(authorizeUrl)`, completion via `window.postMessage("SROUTER_OAUTH_SUCCESS")`
  or 2s client-side polling of `/poll`).

## PKCE login: GET /v1/auth/{openai,antigravity,claude,qoder}/login
- **Query:** `format` (`"json"` → JSON, otherwise **302 redirect** to `authorizeUrl`),
  `client_id?`, `redirect_uri?`, `prompt?`.
- **Response:** `200 { authorizeUrl, state, codeVerifier, redirectUri }`.
- **DB:** `oauth_sessions` INSERT (`state`, `code_verifier`, `client_id`, `redirect_uri`, `created_at`).
- **Default redirect URIs:** `http://localhost:1455/auth/callback` (OpenAI/Codex),
  `http://localhost:1455/auth/antigravity/callback`,
  `http://localhost:1455/auth/claude/callback`; qoder has **no default** (uses
  `redirect_uri` param or provider-lib default).
- **Workers blockers:** the redirect target is served by a **second OAuth-only Hono
  listener on `OAUTH_PORT` (default 1455)** in `apps/api/src/index.ts` (binds
  `OAUTH_HOST` default `0.0.0.0`, no auth). With `SROUTER_PUBLIC_URL` set, that
  listener is **not started** and `ResolveCallbackUrl` rewrites the redirect to
  `<public>/v1/auth/<provider>/callback` on the main port. Without it, the flow is
  inherently localhost-bound. **No second port / localhost listener on Workers.**

## PKCE callback: GET,POST /v1/auth/{openai,antigravity,claude,qoder}/callback
- **Web call site:** `useOAuthConnect` posts `{ callback_url }` to the provider's
  callback endpoint (paste-the-callback-URL tab); GET variants serve browser redirects.
- **Params:** GET `?code=&state=`; POST JSON `{ code?, state?, callback_url? }`
  (`callback_url` must be a valid URL; `code`/`state` parsed from its query string).
- **Response:** `200 { success: true, message, provider }` (messages are Indonesian,
  e.g. `"Login OpenAI Codex Berhasil!"`); `400` if code/state missing; `500` on
  exchange failure ("Invalid or expired OAuth state parameter").
- **DB:** `oauth_sessions` (claim by `state` → DELETE; release on failure);
  `providers` upsert with `access_token`, `refresh_token` (plaintext),
  `account_id`, `organization_id`, `token_expires_at`, `last_refreshed_at`,
  `provider_specific_data` (JSON), `enabled=1`, `created_at`. Connection ids:
  `openai_codex_<ts>`, `antigravity_<ts>`, `claude_<ts>`, `qoder_<ts>`.
- **Notes:** Token exchange is a **live server-side call** to the upstream OAuth
  token endpoint; executor registered in-memory after upsert.

## Device flows (no localhost listener, no tunnel — Workers-safe in principle)
### GET /v1/auth/cline/device
- **Response:** `200 { authorizeUrl, state, userCode, expiresIn, interval }`
  (`authorizeUrl` = `verificationUriComplete ?? verificationUri`). No `format` param.
- **DB:** `oauth_sessions` INSERT (`state`=randomUUID, `device_code`).
- **Web:** `useOAuthConnect` shows `userCode`; polls below every 2s.

### GET,POST /v1/auth/cline/poll  (also codebuddy, codebuddy-cn, qoder variants)
- **Params:** GET `?state=`; POST `{ state }` JSON (web never uses POST).
- **Response:** `200 { status: "pending" | "ok", provider?: ProviderConfig, error?: string }`;
  `400` if `state` missing. On success the session row is deleted and the provider upserted.
- **DB:** `oauth_sessions` (claim → release while pending → delete on success);
  `providers` upsert (e.g. cline: `provider_id="cline"`, `base_url=<CLINE_BASE_URL>`,
  `provider_specific_data={authMethod:"workos-device", email}`;
  qoder poll: `pollDeviceToken({nonce: state, codeVerifier})` then same columns as its callback path).
- **Notes:** Requires admin session. Server polls the upstream device-token endpoint
  (live network call).

### GET /v1/auth/{codebuddy,codebuddy-cn}/login
- **Query:** `format` (`"json"` → JSON, else 302). No client_id/redirect_uri handling.
- **Response:** `200 { authorizeUrl, state }`; `500` on failure.
- **DB:** `oauth_sessions` INSERT (`state` from upstream `requestAuthState()`, empty verifier/client/redirect).
- **Notes:** `CodeBuddyOAuth.requestAuthState()` returns an upstream-hosted `authUrl`;
  server polls CodeBuddy's API. **No localhost listener / tunnel.**

## Token import: POST /v1/auth/{provider}/token
Providers with a token endpoint: `openai`, `antigravity`, `claude`, `cline`,
`codebuddy`, `codebuddy-cn`, `qoder`, `commandcode`, `anthropic`, `atria`, `tokenrouter`.
- **Web call site:** `useOAuthConnect` — `patMutation` posts `{ access_token }`;
  bulk mode posts one request per line with `{ access_token, refresh_token }`.
  Endpoint built as `/v1/auth/${authProviderId}/token`.
- **Request body:** `{ access_token: string (required), refresh_token?: string, base_url?: string, name?: string }`
  (`.passthrough()`; also accepts camelCase `accessToken` etc.). For `commandcode`,
  `anthropic`, `atria`, `tokenrouter` the token is stored as **`api_key`**, not `accessToken`.
- **Response:** `201 { success: true, message, provider }` (e.g.
  `"OpenAI Codex Access Token registered and saved directly to SQLite database!"`).
- **DB:** `providers` upsert (`id=<provider>_<ts>` unless `id` supplied; `category="oauth"`
  for OAuth providers, `"api_key"` for commandcode etc.).
- **Notes:** Direct import — **no OAuth round-trip, no localhost involvement**;
  Workers-safe in principle.

---

# 4. Providers (`/v1/providers/*`)

**Data model:** "provider" = catalog-level driver (base id + defaults from
`DEFAULT_PROVIDER_MAP` in `@srouter/constants`); "connection" = one credential row
in `providers` (`id` e.g. `openai-1730000000000`, `provider_id` = base driver id).
Round-robin and enabled flags live in `system_settings` as
`round_robin_<baseId>` / `provider_enabled_<baseId>` — **per provider, not per connection**.

## GET /v1/providers/catalog
- **Web:** `hooks/useCatalog.ts` (React Query `["providers","catalog"]`); merged client-side
  with static `KNOWN_PROVIDERS`.
- **Response:** `{ total: number; categories: { oauth: ProviderDefinition[]; free_tier: ProviderDefinition[]; api_key: ProviderDefinition[]; custom_provider: ProviderDefinition[] } }`.
- **DB:** `providers` (SELECT all), `system_settings` (flags per provider).
- **Notes:** pure DB read; computes `status.state` (`connected`/`no_connections`) + `connectedCount`.

## GET /v1/providers
- **Web:** none (dashboard uses `/catalog`).
- **Response:** `{ object: "list"; data: ProviderDefinition[] }` (flat, same shape as catalog entries).
- **DB:** `providers`, `system_settings`.

## GET /v1/providers/:providerId
- **Web:** `hooks/useProvider.ts` (query key `["providers", providerId]`); detail page
  `routes/providers/$providerId.tsx`.
- **Response:** `ProviderDefinition` with `connections: ProviderConfig[]` (all rows
  matching the base id), `models: ModelObject[]` (**live-fetched** + custom − hidden),
  `status: { state, message?, connectedCount }`, `roundRobin`, `enabled`. 404 if unknown.
- **DB:** `providers`, `custom_models`, `hidden_models` (filtered per `provider_id`),
  `system_settings`.
- **Notes:** **Live network call possible** — `getProviderModels` hits each matching
  executor's upstream models endpoint (failures swallowed).

## POST /v1/providers/verify
- **Web:** `providers.connection-form.tsx` ("Test Connection") and
  `providers.custom-provider-dialog.tsx` — body `{ protocol, base_url, api_key }`.
  Save is **gated** on `verifyStatus === "success"`.
- **Request:** `{ protocol?: "openai"|"anthropic"|"gemini"|"custom" (default "openai"); base_url?: string (valid URL); api_key?: string }`.
- **Response:** `{ success: boolean; message: string; modelsCount?: number }`
  (messages are Indonesian; 400 only on zod failure).
- **DB:** none.
- **Notes:** **Live upstream call:** `GET <base_url>/models` (OpenAI, 8s timeout,
  redirects NOT followed → failure, SSRF protection) or `GET <base_url>/v1/models`
  (Anthropic, `anthropic-version: 2023-06-01` + `x-api-key`). `AssertPublicUrl`
  rejects non-public URLs via **Node DNS private-range checks** — needs
  re-implementation for Workers.

## POST /v1/providers/connections/verify
- **Web:** `routes/providers/$providerId.tsx` — ConnectionCard `onVerify` posts
  `{ connection_id }`, then refetches.
- **Request:** `{ connection_id: string (required) }` — no secrets in body by design.
- **Response:** `{ success: boolean; message: string; modelsCount?: number; connection_id: string; provider_id?: string }`; 404 if unknown.
- **DB:** `providers` (SELECT by `id` to load the stored credential).
- **Notes:** **Live upstream call** using the stored secret (`access_token || api_key`).

## POST /v1/providers
- **Web:** `hooks/useProvider.ts` `addMutation`; `providers.custom-provider-dialog.tsx`
  `saveMutation`; detail page builds
  `{ id: "<baseId>-<Date.now()>", name, category, protocol, base_url, api_key }`.
- **Request (`CreateProviderSchema`):**
```ts
{ id?: string; provider_id?: string; alias?: string; /* ^[a-z0-9_-]{1,32}$ */
  name: string; category: "oauth"|"free_tier"|"api_key"|"custom_provider";
  protocol: "openai"|"anthropic"|"gemini"|"custom";
  base_url?: string; api_key?: string; access_token?: string; refresh_token?: string;
  provider_specific_data?: Record<string,string>; custom_headers?: Record<string,string> }
```
- **Response:** `ProviderDefinition`. 400 on: validation, duplicate id, invalid base URL
  (SSRF check), missing API key for `api_key`/`custom_provider`.
- **DB:** `providers` INSERT … `ON CONFLICT(id) DO UPDATE` (upsert doubles as the
  **update** path — no PATCH-connection endpoint exists). Columns:
  `id, provider_id, name, alias, category, protocol, base_url, api_key,
  access_token, refresh_token, account_id, organization_id, token_expires_at,
  last_refreshed_at, custom_headers (JSON), provider_specific_data (JSON),
  enabled=1, created_at`. Empty `id` → server generates `crypto.randomUUID()`;
  explicit ids sanitized to `[a-z0-9_-]`.
- **Notes:** no network call; re-registers the executor in the in-memory registry.

## DELETE /v1/providers/:id
- **Web:** `hooks/useProvider.ts` `deleteMutation` (deletes a **connection** by its internal id).
- **Response:** `{ message: "Connection deleted" }`; 404 if not found.
- **DB:** `providers` DELETE WHERE `id = ?` (+ in-memory registry unregister/refresh).

## Custom models & hidden models
| Endpoint | Web call site | Body | Response | DB |
|---|---|---|---|---|
| `POST /v1/providers/:providerId/models` | `useProvider` `addModelMutation` | `{ model_id: string }` (≤200 chars, strict charset) | `201 ModelObject { id: "<alias>/<modelId>", object: "model", owned_by: "<alias>" }` | `custom_models` INSERT (`provider_id, model_id, created_at`); clears model cache |
| `DELETE /v1/providers/:providerId/models/:modelId{.+}` | `useProvider` `deleteModelMutation` (`encodeURIComponent`) | — | `{ message: "Custom model deleted" }`; 404 | `custom_models` DELETE |
| `GET /v1/providers/:providerId/hidden-models` | `useProvider` (also migrates legacy `localStorage` `srouter_deleted_models_<id>`) | — | `{ models: string[] }` | `hidden_models` SELECT (providerId lowercased) |
| `POST /v1/providers/:providerId/hidden-models` | `useProvider` hide mutations (UI calls this "delete") | `{ model_id: string }` | `201 { message: "Model hidden" }` | `hidden_models` INSERT |
| `DELETE /v1/providers/:providerId/hidden-models/:modelId{.+}` | `useProvider` restore mutations | — | `{ message: "Model restored" }`; 404 | `hidden_models` DELETE |

## PATCH /v1/providers/:providerId/round-robin
- **Web:** `useProvider` `toggleRoundRobinMutation`. **Body:** `{ enabled: boolean }`.
- **Response:** updated `ProviderDefinition`.
- **DB:** `system_settings` upsert `round_robin_<lowercased id>` = `"true"/"false"` (+ in-memory sync).

## PATCH /v1/providers/:providerId/enabled
- **Web:** `useProvider` `toggleProviderMutation`. **Body:** `{ enabled: boolean }`.
- **Response:** updated `ProviderDefinition`.
- **DB:** `system_settings` upsert `provider_enabled_<lowercased id>` (+ registry sync; enabling re-registers saved executors).

### Custom provider dialog body (concrete)
```ts
POST /v1/providers
{ name: string; alias: string; /* lowercased, ^[a-z0-9_-]{1,32}$ */
  category: "custom_provider"; protocol: "openai" | "anthropic";  // dialog offers only these two
  base_url: string;  /* required, public URL (SSRF check) */
  api_key: string }
// no id → server generates crypto.randomUUID(); provider_id defaults to id
```

---

# 5. Virtual API keys (`/v1/keys/*`) — RequireAdmin

## GET /v1/keys
- **Web:** `hooks/useKeys.ts`; `routes/logs/index.tsx:53` (API-key filter, only when `require_api_key`).
- **Response:** `{ object: "list"; data: APIKey[] }` where
```ts
interface APIKey { id: string; key: string; /* PLAINTEXT secret, returned on every list */
  name: string; enabled: boolean; rate_limit: number; quota_limit: number;
  usage_tokens: number; credit_limit: number; usage_cost: number;
  allowed_models: string[] | null; /* null = all */ created_at: number }
```
- **DB:** `api_keys` read (all columns above), ordered `created_at DESC`.
- **Notes:** returns secrets in plaintext on every call — no masking.

## POST /v1/keys
- **Web:** `hooks/useKeys.ts` `createKey()` ← `routes/keys.tsx:46`; body built by
  `parseKeyPayload()` in `components/keys/keys.form-types.ts`.
- **Request (snake_case):**
```ts
{ name: string;                 /* required, trimmed */
  enabled: boolean;             /* web always sends, default true */
  rate_limit?: number;          /* int ≥ 0 req/min; 0 = unlimited; blank → undefined */
  quota_limit?: number;         /* int ≥ 0 tokens; 0 = unlimited */
  credit_limit?: number;        /* ≥ 0 USD */
  allowed_models?: string[] | null }
```
- **Response:** `201` — created `APIKey` **including the plaintext `key`**
  (`sr-live-<16 hex>`, `id` = `key_<uuid>`). The UI captures it as `newlyCreatedKey`;
  it cannot be retrieved later except via the (also plaintext) list.
- **DB:** `api_keys` INSERT (`usage_tokens=0`, `usage_cost=0`, `allowed_models` JSON or NULL).
- **Notes:** stored **plaintext**; auth is `WHERE key = ?`. No rotation endpoint exists.

## PATCH /v1/keys/:id
- **Web:** `hooks/useKeys.ts` `updateKey()` ← `routes/keys.tsx:122`; same shape, all optional.
- **Response:** `200` updated `APIKey` (plaintext `key` still included); 404 if unknown.
- **DB:** `api_keys` SELECT then UPDATE of supplied fields only (`allowed_models: []`/`null` clears restriction).

## POST /v1/keys/:id/credit
- **Web:** **none — never called.** (Credit set via `credit_limit` in create/update.)
- **Request:** `{ amount: number }` (positive — additive only).
- **Response:** `200` updated `APIKey`; 404 if unknown.
- **DB:** `api_keys` `SET credit_limit = credit_limit + ?`.

## DELETE /v1/keys/:id
- **Web:** `hooks/useKeys.ts` `deleteKey()`.
- **Response:** `200 { message: "API Key revoked and deleted successfully" }`; 404 if unknown.
- **DB:** `api_keys` hard DELETE. `request_logs.api_key_id` rows become orphaned
  (no cascade, no FK). No revoke-without-delete variant.

---

# 6. Logs & analytics (`/v1/logs/*`) — ApiKeyAuth

`RequestLogEntry` (enriched; snake_case in DB, camelCase over the wire):
```ts
{ id: string; apiKeyId?: string; apiKeyName?: string; ipAddress?: string; userAgent?: string;
  providerId: string; model: string;
  promptTokens: number; completionTokens: number; totalTokens: number;
  statusCode: number; latencyMs: number;
  cachedTokens?: number; cacheCreationTokens?: number; reasoningTokens?: number;
  estimatedCost?: number;
  costBreakdown?: { inputCost: number; outputCost: number; cacheReadCost: number; cacheCreationCost?: number; totalCost: number };
  fallbackOccurred?: boolean; fallbackPath?: string; fallbackReason?: string; resolvedModel?: string;
  createdAt: number }
```

## GET /v1/logs
- **Web:** `routes/logs/index.tsx:64` — `/v1/logs?page=${page}&limit=25[&status=success|error]`
  (10s refetch); `dashboard.recent-requests.tsx:22` — `/v1/logs?limit=6` (3s refetch).
- **Query:** `page` (default 1; **its presence switches to paginated mode**),
  `limit` (default 50, clamp 1–500), `status` (`all|success|error`; success = 2xx).
- **Response:**
```ts
// recent mode (no ?page): { object: "list"; data: RequestLogEntry[] }
// paginated mode:         { object: "list"; data: RequestLogEntry[];
//                           pagination: { page, limit, total, total_pages } }
```
- **DB:** `request_logs` (all 20 columns), ordered `created_at DESC`;
  `api_keys` (id→name map for `apiKeyName`); `system_settings` (`require_api_key` —
  `apiKeyId` stripped when API-key auth is disabled).
- **Notes:** entries enriched server-side with `costBreakdown` from the pricing dataset.
  `useLogs.ts` filters client-side only (no extra API).

## GET /v1/logs/stats
- **Web:** `routes/index.tsx:86` (dashboard), `routes/logs/index.tsx:72`; kept fresh by SSE.
- **Response:**
```ts
{ object: "usage"; totalRequests: number; totalSuccessRequests?: number;
  totalTokens: number; totalPromptTokens: number; totalCompletionTokens: number;
  totalCachedTokens: number; totalCacheCreationTokens: number; totalReasoningTokens: number;
  totalEstimatedCost: number; totalInputTokens: number; totalOutputTokens: number;
  costLabel: string; /* e.g. "$12.34" */ estimated: true;
  byModel: { model: string; totalRequests: number; totalInputTokens: number;
             totalOutputTokens: number; totalCachedTokens: number; estCost: number }[] }
```
- **DB:** `request_logs` — `SUM`s over token/cost columns; `byModel` groups by `model`
  ordered by requests DESC. All-time totals (no window); `estimated: true` always
  (costs derive from pricing data, not measured spend).

## GET /v1/logs/events  (SSE)
- **Web:** `hooks/useLogsStream.ts` —
  `new EventSource(\`${getGatewayBaseUrl()}/logs/events\`)` (`getGatewayBaseUrl()`
  already ends in `/v1`). Consumed in `routes/index.tsx`; on `usage.updated` writes the
  `["stats"]` query cache.
- **Response:** `text/event-stream`:
```ts
{ type: "connected" }
| { type: "usage.updated"; stats: UsageStats }    // same shape as GET /v1/logs/stats
| { type: "request.logged"; log: RequestLogEntry }
```
- **DB:** same enrichment queries as stats/list, re-run per event.
- **Notes:** hard cap **16 concurrent streams** (17th → `429 "Too many usage event streams"`);
  `: ping` heartbeat every 25s; emitted on every logged request via `usageEvents`.
  **Workers porting:** SSE works on Workers, but the in-process fan-out must move to
  Durable Objects.

## GET /v1/logs/analytics
- **Web:** `hooks/useAnalytics.ts` via `Api.getAnalytics(window)` →
  `/v1/logs/analytics?window=${window}`; `routes/analytics.tsx` (default `"24h"`;
  10s refetch for `1h`, 60s otherwise).
- **Query:** `window` — valid values **`"1h" | "24h" | "7d" | "30d"`** (zod enum in
  `@srouter/types` `AnalyticsQuerySchema`); default `"24h"`; else `400 "Invalid window parameter"`.
- **Response (`AnalyticsReport`):**
```ts
{ object: "analytics"; window: "1h"|"24h"|"7d"|"30d"; bucketSizeMs: number; generatedAt: number;
  requestsPerSecond: number; /* rolling 60s avg, 2dp */ totalRequests: number;
  errorRate: number; /* 0..1, 3dp */ p95LatencyMs: number;
  buckets: { bucketStart: number; totalRequests: number; successRequests: number;
             errorRequests: number; avgLatencyMs: number; totalTokens: number;
             promptTokens: number; completionTokens: number; cachedTokens: number }[]; // zero-filled, ascending
  topModels: { model: string; totalRequests: number; totalTokens: number; estCost: number }[]; // top 10
  topAgents?: { agent: string; rawUserAgent: string; totalRequests: number; totalTokens: number }[]; // top 10 user_agents
  providers: { providerId: string; totalRequests: number }[] }
```
- **DB:** `request_logs` — time-bucketed `GROUP BY CAST(created_at / bucketSize AS BIGINT) * bucketSize`
  filtered to window; p95 via ordered `OFFSET COUNT*0.95`; RPS from last 60s.
- **Bucket geometry:** `1h` = 60×1-min; `24h` = 24×1-hr; `7d` = 28×6-hr; `30d` = 30×24-hr.
  Missing buckets zero-filled server-side.

## GET /v1/logs/:id
- **Web:** `routes/logs/$logId.tsx:218` — `/v1/logs/${encodeURIComponent(logId)}`.
- **Response:** single enriched `RequestLogEntry`; 404 if unknown.
- **DB:** `request_logs` single row by `id`; `api_keys` + `system_settings` enrichment.
- **Notes:** registered after the literal `/logs/stats|events|analytics` routes so they aren't captured.

---

# 7. Models, pricing, quota

## GET /v1/models
- **Web:** `combo.dialog.tsx:155` (when dialog open), `keys.model-picker.tsx:25`.
- **Query:** `refresh` or `force` (`"true"`/`"1"` = fresh upstream fetch); a request
  `Cache-Control: no-cache|no-store` header also triggers background refresh.
- **Response:** OpenAI list format:
```ts
{ object: "list"; data: ModelObject[] }
/* ModelObject { id: string; object: "model"; created?: number; owned_by: string; custom?: boolean } */
```
- **DB:** `providers` (source models), `custom_models` (user-added, `custom: true`),
  `hidden_models` (filtered out), `fallback_rules` (enabled rules merged as synthetic "combo" entries).
- **Notes:** filtered to `allowed_models` when the calling key restricts them.
  Response header `Cache-Control: public, max-age=60, stale-while-revalidate=300`.

## GET /v1/models/:model{.+}
- **Web:** none. **Response:** single `ModelObject`; `403 {code:"model_not_allowed"}` if the
  key's `allowed_models` excludes it (checked **before** lookup); `404 {code:"model_not_found"}`.
- **DB:** same as list.

## GET /v1/pricing/models
- **Web:** `hooks/usePricing.ts` (1h client staleTime).
- **Query:** `refresh`/`force` (`"true"`/`"1"` bypass cache); `Cache-Control: no-cache|no-store` also forces.
- **Response:**
```ts
{ object: "list"; total: number; updated_at: string; /* ISO */
  data: { id: string; name: string; description?: string; family?: string; provider?: string; /* parsed from "<provider>/<model>" */
    attachment?: boolean; reasoning?: boolean; tool_call?: boolean; temperature?: boolean;
    structured_output?: boolean; open_weights?: boolean;
    knowledge?: string; release_date?: string; last_updated?: string;
    cost: { input?: number; output?: number; cache_read?: number; cache_write?: number;
            reasoning?: number; input_audio?: number; output_audio?: number }; /* per 1M tokens */
    limit?: { context?: number; output?: number };
    modalities?: { input?: string[]; output?: string[] } }[] }
```
- **DB:** **none** — built from the bundled models.dev dataset (`loadModelsDevData()`
  in `@srouter/pricing`), sorted by provider then name; 1-hour in-process memory cache.
- **Notes:** header `Cache-Control: public, max-age=3600, stale-while-revalidate=86400`.
  Drives cost enrichment of logs.

## GET /v1/quota
- **Web:** `hooks/useQuota.ts` — `/v1/quota` or `/v1/quota?force=true`; `routes/quota.tsx:44`
  calls `?force=true` on manual refresh. Auto-refetch 60s.
- **Query:** `refresh` or `force` (`"true"` = force).
- **Response:**
```ts
{ object: "quota"; totalAccounts: number;
  providers: { id: string; provider: string; account: string; enabled: boolean;
    quotaType: "live_provider_quota" | "usage_logged";
    totalQuotas?: number;
    quotas?: { name: string; used: number; limit: number; percentage: string;
               percentageValue: number; resetIn: string; resetTime?: string;
               status: "ok" | "warning" | "exhausted" }[];
    usageMetrics?: { model: string; totalRequests: number; totalTokens: number;
                     promptTokens: number; completionTokens: number; lastUsedAt: string | null }[] }[] }
```
- **DB:** `providers` — reads all rows, keeps `category='oauth'` or quota-supported ids.
- **Notes:** live figures fetched **from upstream per account** (`fetchLiveOAuthQuota`),
  not from DB. `force=true` bypasses the 60s in-memory cache (`QuotaLogic.cachedQuota`)
  and re-fetches concurrently (`Promise.allSettled`, per-account failures skipped);
  concurrent requests share one in-flight promise. Typo alias `GET /v1/qouta` exists,
  behaves identically, **uncalled**.

---

# 8. Settings & fallback combos (`/v1/settings/*`)

## GET /v1/settings
- **Web:** `hooks/useSettings.ts:68` (hydrates/migrates gateway settings),
  `routes/settings.tsx:69`, `routes/logs/index.tsx:45`, `routes/logs/$logId.tsx:226`,
  `components/settings/settings.system.tsx:42`.
- **Response:**
```ts
{ require_api_key?: boolean;   // snake_case
  requireApiKey?: boolean;     // camelCase duplicate, intentional for back-compat
  settings?: Record<string, string> }  // ALL system_settings rows (string values)
```
- **DB:** `system_settings` — `getAllSettingsDB()`; `require_api_key` via
  `getRequireApiKeyDB()` (`"true"`/`"1"` → true).
- **Notes:** `useSettings.ts` maps server keys `request_timeout_sec, auto_retry_on_429,
  max_retries, retry_delay_ms, token_refresh_lead_min, logging_level,
  log_retention_days, record_token_usage, mask_sensitive_headers`; if none exist it
  PATCHes local defaults up (one-time migration).

## PATCH /v1/settings  (web's primary write path)
- **Web:** `hooks/useSettings.ts:80,111` — `{ settings: { [serverKey]: String(value) } }`
  on first-run migration and every setting change.
- **Request (`UpdateSettingsSchema`):** `{ require_api_key?: boolean; settings?: Record<string, string> }`
  (non-string values silently skipped).
- **Response:** `200 { message: "Settings updated successfully", require_api_key, requireApiKey, settings }`
  (fresh read-back, same shape as GET).
- **DB:** `system_settings` upsert (`ON CONFLICT(key) DO UPDATE`) per entry;
  `require_api_key` stored as `"true"`/`"false"`.

## POST /v1/settings
- **Web:** `routes/settings.tsx:152` — security toggle ("API Key Authentication Required" /
  "Open Access Mode") posts `{ require_api_key: boolean }`.
- **Request/response/DB:** same schema and controller as PATCH (`UpdateSettings`).

## Fallback combos — "Model Combos" UI (`routes/combo.tsx` ← `hooks/useFallbacks.ts`)
`FallbackRule`:
```ts
{ id: string;                 /* fb_<id> */
  sourceModel: string;        /* exact model id, "<prefix>/*" wildcard, or "*" catch-all */
  targetModel: string;
  priority: number;           /* lower runs first */
  enabled: boolean;
  triggerOnStatus?: number[]; /* e.g. [429, 500, 502, 503]; JSON string in DB */
  maxRetries?: number;
  createdAt: number }
```

| Endpoint | Web call site | Body | Response | DB |
|---|---|---|---|---|
| `GET /v1/settings/fallbacks` | `useFallbacks.ts:14` | — | `{ fallbacks: FallbackRule[] }` ordered `priority ASC, created_at ASC` | `fallback_rules` read |
| `POST /v1/settings/fallbacks` | `useFallbacks.ts:44` (snake_case mapped from camelCase form) | `{ source_model: string (req); target_model: string (req); priority?: int ≥ 0 (default 1); enabled?: boolean (default true); trigger_on_status?: number[]; max_retries?: int ≥ 0 }` | `201 { fallback: FallbackRule }` (`maxRetries` defaults to 1 in returned object) | `fallback_rules` INSERT (`id` = `fb_<id>` or supplied) |
| `PUT /v1/settings/fallbacks/:id` | `useFallbacks.ts:76` (**web's update path**) | Partial of create body, snake_case | `200 { fallback: FallbackRule }`; 404 | `fallback_rules` read-merge-update (missing fields keep values) |
| `PATCH /v1/settings/fallbacks/:id` | **none — web uses PUT** | same as PUT | same as PUT | same as PUT |
| `DELETE /v1/settings/fallbacks/:id` | `useFallbacks.ts:106` | — | `200 { message: "Fallback rule \"<id>\" deleted successfully" }`; 404 | `fallback_rules` DELETE |

**Notes:** the same rules are merged into `GET /v1/models` output and drive runtime
fallback chaining.

---

# 9. Favorites (`/v1/favorites/*`) — registered in `routes/v1/providers.ts`

| Endpoint | Auth | Web call site | Body | Response | DB |
|---|---|---|---|---|---|
| `GET /v1/favorites` | ApiKeyAuth | `hooks/useFavorites.ts:23` (migrates legacy `localStorage` `srouter_favorite_models` on first empty load) | — | `{ models: string[] }` ordered `created_at ASC` (plain ids) | `favorite_models` read |
| `POST /v1/favorites` | RequireAdmin | `hooks/useFavorites.ts:28,38` | `{ model_id: string }` (required, non-empty) | `201 { message: "Model added to favorites" }` (idempotent) | `favorite_models` INSERT |
| `DELETE /v1/favorites/:modelId{.+}` | RequireAdmin | `hooks/useFavorites.ts:39` (`encodeURIComponent`) | — | `200 { message: "Model removed from favorites" }`; 404 | `favorite_models` DELETE |

---

# 10. Tunnel (`/v1/tunnel/*`) — RequireAdmin — **NOT portable to Workers**

Spawns/manages a `cloudflared` **subprocess** (token/domain in `system_settings` as
`cloudflare_tunnel_token` / `cloudflare_tunnel_domain`). A Worker is already public;
drop this entire section in the port.

| Endpoint | Web call site | Body | Response | Notes |
|---|---|---|---|---|
| `GET /v1/tunnel/status` | `hooks/useTunnel.ts` | — | `{ running, startedAt, error, domain, desired, restartAttempts, maxRestartAttempts, autostart, mode: "quick"\|"named", tokenConfigured }` (`autostart` from `system_settings` `SETTING_TUNNEL_AUTOSTART`) | pure status read |
| `GET /v1/tunnel/events` | `useTunnel.ts` (`EventSource`) | — | SSE `text/event-stream`: `data: {…status…, tokenConfigured}` + `: ping` every 25s; 429 after 8 concurrent streams | in-process fan-out |
| `POST /v1/tunnel/start` | `useTunnel.ts` | `{ token?: string; domain?: string }` (`TunnelConfigSchema`) | `{ success, message, domain?, mode }` or 400 | **spawns cloudflared subprocess** |
| `POST /v1/tunnel/stop` | `useTunnel.ts` | — | `{ success, message }` or 400 | kills subprocess |
| `PUT /v1/tunnel/config` | *(none found in web)* | `{ token?; domain? }` (at least one required) | `{ message: "Tunnel configuration updated", domain? }` | writes `system_settings` |
| `POST /v1/tunnel/install` | `useTunnel.ts` | — | `{ success, message }` or 400 | installs cloudflared binary |
| `GET /v1/tunnel/install` | *(none found in web)* | — | install status | — |

---

# 11. Porting blockers & divergences (summary)

| Area | Original behavior | Workers implication |
|---|---|---|
| Tunnel (`/v1/tunnel/*`) | `cloudflared` subprocess lifecycle | **Drop entirely** — Workers are already public |
| OAuth PKCE login/callback | default redirect `http://localhost:1455/...`; second Hono listener on `OAUTH_PORT` | **Broken on Workers** — no second port/listener. Needs public-URL callback (`SROUTER_PUBLIC_URL` rewrite path) or device flows |
| OAuth device flows (cline, codebuddy, codebuddy-cn, qoder poll) | outbound HTTPS polling only | Portable as-is (DO/D1 for `oauth_sessions` claim semantics) |
| Token import (`POST /v1/auth/*/token`) | direct DB upsert, no OAuth round-trip | Portable as-is |
| Admin setup localhost-only | 403 `setup_local_only` for non-loopback | Meaningless on Workers — replace with first-claim-wins + warning (already the dashboard's posture) |
| Login rate limiting | in-memory `Map` per process | Move to DO/D1 |
| scrypt passwords | `scrypt$…` hashes | **Not portable** — PBKDF2-SHA256/100k (WebCrypto cap); admins reset on first deploy |
| Plaintext provider credentials | `providers.api_key/access_token/refresh_token` plaintext | Encrypt at rest (AES-GCM envelopes) |
| Plaintext virtual keys | `api_keys.key` plaintext, `WHERE key = ?` | Store SHA-256 hashes only |
| `AssertPublicUrl` SSRF guard | Node DNS private-range checks | Re-implement for Workers (fetch works; the guard needs review) |
| SQLite export/import | `VACUUM INTO`, file replace, `-wal`/`-shm` sidecars | **Cannot port** — redesign as D1 export / R2 snapshots |
| SSE fan-out (`/v1/logs/events`, `/v1/tunnel/events`) | in-process emitter, 16/8 stream caps | Move to Durable Objects |
| In-memory caches | model cache, quota cache (60s), pricing dataset (1h) | DO or Cache API |

## Endpoints with no web call site (dead surface — port optionally)
- `POST /v1/admin/logout` (no logout UI)
- `GET /v1/providers` (dashboard uses `/catalog`)
- `POST /v1/keys/:id/credit`
- `GET /v1/models/:model`
- `PATCH /v1/settings/fallbacks/:id` (web uses PUT)
- `GET /v1/qouta` (typo alias of `/v1/quota`)
- `PUT /v1/tunnel/config`, `GET /v1/tunnel/install` (no web call site found)
