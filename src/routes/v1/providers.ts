// SRouter-compatible provider dashboard endpoints (Phase 2).
// Mounted at /v1/providers by src/index.ts.
//
// "Provider" = catalog-level driver (base id + static defaults, ported from
// @srouter/constants KNOWN_PROVIDERS). "Connection" = one credential row in the
// `providers` table. Round-robin / enabled flags live in `system_settings` as
// `round_robin_<baseId>` / `provider_enabled_<baseId>`, exactly like SRouter.
//
// Secrets are NEVER returned in any response: rows store AES-GCM envelopes in
// `secrets_enc`, and ProviderConfig secret fields are returned as "".

import { Hono } from "hono";
import type { AppHonoEnv } from "../../hono-env.js";
import type { Env } from "../../env.js";
import { apiKeyAuth } from "../../middleware/apiKeyAuth.js";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { apiError } from "../../lib/api-error.js";
import { encryptSecretsObject } from "../../crypto/secretbox.js";
import {
    decryptAccount,
    providerAlias,
    type ProviderRow
} from "../../providers/registry.js";
import { getMergedModels } from "../models.js";

export const providersRoutes = new Hono<AppHonoEnv>();

/** Path params are always present on these routes; default to "" for typing. */
function reqParam(c: { req: { param: (name: string) => string | undefined } }, name: string): string {
    return c.req.param(name) ?? "";
}

// ---------------------------------------------------------------------------
// Static provider catalog (ported from @srouter/constants KNOWN_PROVIDERS).
// ---------------------------------------------------------------------------

type ProviderCategory = "oauth" | "free_tier" | "api_key" | "custom_provider";
type ProviderProtocol = "openai" | "anthropic" | "gemini" | "custom";

interface CatalogEntry {
    id: string;
    name: string;
    category: ProviderCategory;
    protocol: ProviderProtocol;
    base_url?: string;
    alias?: string;
    requires_api_key: boolean;
    requires_oauth?: boolean;
    supports_custom_url?: boolean;
    status_message: string;
}

const KNOWN_PROVIDERS: CatalogEntry[] = [
    { id: "kiro", name: "Kiro", category: "api_key", protocol: "custom", requires_api_key: true, supports_custom_url: true, status_message: "Kiro credential missing" },
    { id: "neosantara", name: "Neosantara", category: "api_key", protocol: "openai", base_url: "https://api.neosantara.xyz/v1", requires_api_key: true, supports_custom_url: true, status_message: "Neosantara API key missing" },
    { id: "tokenrouter", name: "TokenRouter", category: "api_key", protocol: "openai", base_url: "https://api.tokenrouter.com/v1", requires_api_key: true, supports_custom_url: true, status_message: "TokenRouter API key missing" },
    { id: "openai_codex", name: "OpenAI Codex / ChatGPT", category: "oauth", protocol: "openai", alias: "openai", requires_api_key: false, requires_oauth: true, status_message: "OAuth token missing" },
    { id: "anthropic", name: "Anthropic Claude", category: "oauth", protocol: "anthropic", alias: "claude", requires_api_key: false, requires_oauth: true, status_message: "OAuth token missing" },
    { id: "antigravity", name: "Google Antigravity", category: "oauth", protocol: "openai", base_url: "https://daily-cloudcode-pa.googleapis.com", requires_api_key: false, requires_oauth: true, status_message: "Antigravity OAuth token missing" },
    { id: "commandcode", name: "Command Code", category: "api_key", protocol: "openai", base_url: "https://api.commandcode.ai/alpha/generate", requires_api_key: true, supports_custom_url: true, status_message: "Command Code API key missing" },
    { id: "qoder", name: "Qoder", category: "oauth", protocol: "openai", alias: "qd", requires_api_key: false, requires_oauth: true, supports_custom_url: true, status_message: "Qoder token or session missing" },
    { id: "codebuddy", name: "CodeBuddy", category: "oauth", protocol: "openai", alias: "codebuddy", base_url: "https://www.codebuddy.ai/v2/chat/completions", requires_api_key: false, requires_oauth: true, supports_custom_url: true, status_message: "CodeBuddy OAuth token missing" },
    { id: "codebuddy-cn", name: "CodeBuddy CN", category: "oauth", protocol: "openai", alias: "codebuddy-cn", base_url: "https://copilot.tencent.com/v2/chat/completions", requires_api_key: false, requires_oauth: true, supports_custom_url: true, status_message: "CodeBuddy CN OAuth token missing" },
    { id: "opencode_zen", name: "OpenCode Zen", category: "free_tier", protocol: "openai", alias: "zen", base_url: "https://opencode.ai/zen/v1", requires_api_key: false, status_message: "OpenCode Zen is ready" },
    { id: "bai", name: "B.AI", category: "free_tier", protocol: "openai", alias: "bai", base_url: "https://api.b.ai/v1", requires_api_key: false, supports_custom_url: true, status_message: "B.AI API key missing" },
    { id: "experientiallabs", name: "Experiential Labs", category: "api_key", protocol: "openai", alias: "explabs", base_url: "https://api.experientiallabs.ai/v1", requires_api_key: true, supports_custom_url: true, status_message: "Experiential Labs API key missing" },
    { id: "minimax", name: "MiniMax", category: "api_key", protocol: "openai", alias: "minimax", base_url: "https://api.minimax.io/v1", requires_api_key: true, supports_custom_url: true, status_message: "MiniMax API key missing" },
    { id: "cline", name: "Cline", category: "oauth", protocol: "openai", alias: "cline", base_url: "https://api.cline.bot/api/v1", requires_api_key: false, requires_oauth: true, supports_custom_url: true, status_message: "Cline OAuth account missing" },
    { id: "atria", name: "Atria", category: "api_key", protocol: "openai", alias: "atria", base_url: "https://api.atria-asi.ai/v1", requires_api_key: true, supports_custom_url: true, status_message: "Atria API key missing" }
];

const KNOWN_IDS = new Set(KNOWN_PROVIDERS.map((p) => p.id));

/** Resolve the display alias for a provider base id (used by models.ts). */
export function catalogAliasFor(providerId: string): string | null {
    const entry = KNOWN_PROVIDERS.find((p) => p.id === providerId);
    return entry?.alias ?? null;
}

/** Longest known-id prefix match, mirroring SRouter's providerBaseId. */
function baseIdFor(id: string): string {
    const sorted = [...KNOWN_IDS].sort((a, b) => b.length - a.length);
    const hit = sorted.find((c) => id === c || id.startsWith(`${c}_`) || id.startsWith(`${c}-`));
    return hit ?? id;
}

function prettyName(id: string): string {
    return id
        .split(/[-_]/)
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(" ");
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function getSetting(db: D1Database, key: string): Promise<string | null> {
    const row = await db
        .prepare("SELECT value FROM system_settings WHERE key = ?")
        .bind(key)
        .first<{ value: string }>();
    return row?.value ?? null;
}

async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
    await db
        .prepare("INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key, value)
        .run();
}

async function allProviderRows(db: D1Database): Promise<ProviderRowFull[]> {
    const res = await db.prepare("SELECT * FROM providers").all<ProviderRowFull>();
    return res.results ?? [];
}

/** ProviderRow plus the timestamp columns the D1 schema carries. */
interface ProviderRowFull extends ProviderRow {
    token_expires_at: number | null;
    last_refreshed_at: number | null;
    created_at: number;
}

function parseJsonObject(value: string | null): Record<string, string> | undefined {
    if (!value) return undefined;
    try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, string>;
        }
    } catch {
        // ignore malformed JSON
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Shape builders
// ---------------------------------------------------------------------------

interface ProviderConfigWire {
    id: string;
    providerId: string;
    name: string;
    alias?: string;
    category?: ProviderCategory;
    protocol?: ProviderProtocol;
    base_url?: string;
    apiKey: string;
    accessToken: string;
    refreshToken: string;
    accountId?: string;
    tokenExpiresAt?: number;
    lastRefreshedAt?: number;
    organizationId?: string;
    customHeaders?: Record<string, string>;
    providerSpecificData?: Record<string, string>;
    enabled: boolean;
    createdAt: number;
}

/** ProviderConfig with secrets redacted — the port stores only encrypted envelopes. */
function toProviderConfig(row: ProviderRowFull): ProviderConfigWire {
    return {
        id: row.id,
        providerId: row.provider_id,
        name: row.name,
        alias: row.alias ?? undefined,
        category: row.category as ProviderCategory,
        protocol: row.protocol as ProviderProtocol,
        base_url: row.base_url ?? undefined,
        apiKey: "",
        accessToken: "",
        refreshToken: "",
        accountId: row.account_id ?? undefined,
        tokenExpiresAt: row.token_expires_at ?? undefined,
        lastRefreshedAt: row.last_refreshed_at ?? undefined,
        organizationId: row.organization_id ?? undefined,
        customHeaders: parseJsonObject(row.custom_headers),
        providerSpecificData: parseJsonObject(row.provider_specific_data),
        enabled: row.enabled === 1,
        createdAt: row.created_at
    };
}

interface ProviderDefinitionWire {
    id: string;
    name: string;
    category: ProviderCategory;
    protocol: ProviderProtocol;
    base_url?: string;
    alias?: string;
    requires_api_key: boolean;
    requires_oauth?: boolean;
    supports_custom_url?: boolean;
    roundRobin?: boolean;
    enabled?: boolean;
    status: { state: "connected" | "no_connections"; message?: string; connectedCount?: number };
    models: unknown[];
    connections?: ProviderConfigWire[];
}

async function buildDefinition(
    db: D1Database,
    entry: CatalogEntry,
    rows: ProviderRowFull[],
    opts: { includeConnections: boolean }
): Promise<ProviderDefinitionWire> {
    const connectedCount = rows.length;
    const enabledFlag = await getSetting(db, `provider_enabled_${entry.id.toLowerCase()}`);
    const rrFlag = await getSetting(db, `round_robin_${entry.id.toLowerCase()}`);
    return {
        id: entry.id,
        name: entry.name,
        category: entry.category,
        protocol: entry.protocol,
        base_url: entry.base_url,
        alias: entry.alias,
        requires_api_key: entry.requires_api_key,
        requires_oauth: entry.requires_oauth,
        supports_custom_url: entry.supports_custom_url,
        roundRobin: rrFlag == null ? true : rrFlag === "true",
        enabled: enabledFlag == null ? true : enabledFlag === "true",
        status: {
            state: connectedCount > 0 ? "connected" : "no_connections",
            message: connectedCount > 0 ? undefined : entry.status_message,
            connectedCount
        },
        models: [],
        ...(opts.includeConnections ? { connections: rows.map(toProviderConfig) } : {})
    };
}

/** Catalog entries for base ids present in the DB but unknown to the static catalog. */
function syntheticEntries(rows: ProviderRowFull[]): CatalogEntry[] {
    const seen = new Set<string>();
    const out: CatalogEntry[] = [];
    for (const row of rows) {
        if (KNOWN_IDS.has(row.provider_id) || seen.has(row.provider_id)) continue;
        seen.add(row.provider_id);
        out.push({
            id: row.provider_id,
            name: prettyName(row.provider_id),
            category: "custom_provider",
            protocol: (row.protocol as ProviderProtocol) || "openai",
            base_url: row.base_url ?? undefined,
            requires_api_key: true,
            supports_custom_url: true,
            status_message: `${prettyName(row.provider_id)} credentials missing`
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// GET /v1/providers/catalog
// ---------------------------------------------------------------------------

providersRoutes.get("/catalog", apiKeyAuth, async (c) => {
    const db = c.env.DB;
    const rows = await allProviderRows(db);
    const byBase = new Map<string, ProviderRowFull[]>();
    for (const row of rows) {
        const base = baseIdFor(row.provider_id);
        const list = byBase.get(base) ?? [];
        list.push(row);
        byBase.set(base, list);
    }

    const entries = [...KNOWN_PROVIDERS, ...syntheticEntries(rows)];
    const oauth: ProviderDefinitionWire[] = [];
    const free_tier: ProviderDefinitionWire[] = [];
    const api_key: ProviderDefinitionWire[] = [];
    const custom_provider: ProviderDefinitionWire[] = [];

    for (const entry of entries) {
        const def = await buildDefinition(db, entry, byBase.get(entry.id) ?? [], {
            includeConnections: false
        });
        if (entry.category === "oauth") oauth.push(def);
        else if (entry.category === "free_tier") free_tier.push(def);
        else if (entry.category === "api_key") api_key.push(def);
        else custom_provider.push(def);
    }

    return c.json({
        total: entries.length,
        categories: { oauth, free_tier, api_key, custom_provider }
    });
});

// ---------------------------------------------------------------------------
// GET /v1/providers (flat list; no web callers, kept for API parity)
// ---------------------------------------------------------------------------

providersRoutes.get("/", apiKeyAuth, async (c) => {
    const db = c.env.DB;
    const rows = await allProviderRows(db);
    const byBase = new Map<string, ProviderRowFull[]>();
    for (const row of rows) {
        const base = baseIdFor(row.provider_id);
        const list = byBase.get(base) ?? [];
        list.push(row);
        byBase.set(base, list);
    }
    const entries = [...KNOWN_PROVIDERS, ...syntheticEntries(rows)];
    const data: ProviderDefinitionWire[] = [];
    for (const entry of entries) {
        data.push(await buildDefinition(db, entry, byBase.get(entry.id) ?? [], { includeConnections: false }));
    }
    return c.json({ object: "list", data });
});

// ---------------------------------------------------------------------------
// POST /v1/providers/verify — test a candidate base_url/api_key (no DB writes)
// ---------------------------------------------------------------------------

const VERIFY_TIMEOUT_MS = 8000;

async function liveVerifyModels(
    protocol: string,
    baseUrl: string,
    apiKey?: string
): Promise<{ success: boolean; message: string; modelsCount?: number }> {
    let url: string;
    const headers: Record<string, string> = {};
    if (protocol === "anthropic") {
        url = baseUrl.replace(/\/+$/, "") + "/v1/models";
        headers["anthropic-version"] = "2023-06-01";
        if (apiKey) headers["x-api-key"] = apiKey;
    } else {
        url = baseUrl.replace(/\/+$/, "") + "/models";
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    }
    try {
        const res = await fetch(url, {
            method: "GET",
            headers,
            redirect: "manual",
            signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
        });
        if (!res.ok) {
            return { success: false, message: `Upstream responded with HTTP ${res.status}` };
        }
        const body = (await res.json().catch(() => null)) as { data?: unknown[] } | null;
        const modelsCount = Array.isArray(body?.data) ? body.data.length : undefined;
        return {
            success: true,
            message: "Connection verified successfully",
            ...(modelsCount !== undefined ? { modelsCount } : {})
        };
    } catch (err) {
        return {
            success: false,
            message: err instanceof Error ? `Verification failed: ${err.message}` : "Verification failed"
        };
    }
}

providersRoutes.post("/verify", apiKeyAuth, async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
        protocol?: string;
        base_url?: string;
        api_key?: string;
    } | null;
    const protocol = body?.protocol ?? "openai";
    if (!["openai", "anthropic", "gemini", "custom"].includes(protocol)) {
        return apiError(c, 400, `Invalid protocol "${protocol}"`, "invalid_protocol");
    }
    if (!body?.base_url) {
        return apiError(c, 400, "base_url is required", "missing_base_url");
    }
    let parsed: URL;
    try {
        parsed = new URL(body.base_url);
    } catch {
        return apiError(c, 400, "base_url must be a valid URL", "invalid_base_url");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
        return apiError(c, 400, "base_url must use http or https", "invalid_base_url");
    }
    // NOTE: SRouter's AssertPublicUrl SSRF guard (Node DNS private-range checks)
    // has no Workers equivalent; Workers fetch cannot reach RFC1918 targets
    // through the public internet anyway.
    const result = await liveVerifyModels(protocol, body.base_url, body.api_key);
    return c.json(result);
});

// ---------------------------------------------------------------------------
// POST /v1/providers/connections/verify — verify a stored connection
// ---------------------------------------------------------------------------

providersRoutes.post("/connections/verify", apiKeyAuth, async (c) => {
    const env = c.env as Env;
    const body = (await c.req.json().catch(() => null)) as { connection_id?: string } | null;
    if (!body?.connection_id) {
        return apiError(c, 400, "connection_id is required", "missing_connection_id");
    }
    const row = await env.DB.prepare("SELECT * FROM providers WHERE id = ?")
        .bind(body.connection_id)
        .first<ProviderRow>();
    if (!row) {
        return apiError(c, 404, "Connection not found", "connection_not_found");
    }
    let account;
    try {
        account = await decryptAccount(row, env.MASTER_KEY);
    } catch {
        return c.json({
            success: false,
            message: "Stored credentials could not be decrypted",
            connection_id: row.id,
            provider_id: row.provider_id
        });
    }
    const credential = account.accessToken || account.apiKey;
    const baseUrl = account.baseUrl || KNOWN_PROVIDERS.find((p) => p.id === row.provider_id)?.base_url;
    if (!baseUrl) {
        return c.json({
            success: false,
            message: "No base URL configured for this connection",
            connection_id: row.id,
            provider_id: row.provider_id
        });
    }
    const protocol = row.provider_id === "anthropic" ? "anthropic" : account.protocol || "openai";
    const result = await liveVerifyModels(protocol, baseUrl, credential);
    return c.json({ ...result, connection_id: row.id, provider_id: row.provider_id });
});

// ---------------------------------------------------------------------------
// POST /v1/providers — create a connection
// ---------------------------------------------------------------------------

const ID_SANITIZE_RE = /[^a-z0-9_-]/g;

providersRoutes.post("/", requireAdmin, async (c) => {
    const env = c.env as Env;
    const body = (await c.req.json().catch(() => null)) as {
        id?: string;
        provider_id?: string;
        alias?: string;
        name?: string;
        category?: string;
        protocol?: string;
        base_url?: string;
        api_key?: string;
        access_token?: string;
        refresh_token?: string;
        provider_specific_data?: Record<string, string>;
        custom_headers?: Record<string, string>;
    } | null;

    if (!body || typeof body !== "object") {
        return apiError(c, 400, "Request body must be a JSON object", "invalid_body");
    }
    const name = (body.name ?? "").trim();
    if (!name) return apiError(c, 400, "name is required", "missing_name");
    const category = body.category ?? "api_key";
    if (!["oauth", "free_tier", "api_key", "custom_provider"].includes(category)) {
        return apiError(c, 400, `Invalid category "${category}"`, "invalid_category");
    }
    const protocol = body.protocol ?? "openai";
    if (!["openai", "anthropic", "gemini", "custom"].includes(protocol)) {
        return apiError(c, 400, `Invalid protocol "${protocol}"`, "invalid_protocol");
    }
    if (body.alias && !/^[a-z0-9_-]{1,32}$/.test(body.alias)) {
        return apiError(c, 400, "alias must match ^[a-z0-9_-]{1,32}$", "invalid_alias");
    }
    if (body.base_url) {
        try {
            new URL(body.base_url);
        } catch {
            return apiError(c, 400, "base_url must be a valid URL", "invalid_base_url");
        }
    }
    if ((category === "api_key" || category === "custom_provider") && !body.api_key) {
        return apiError(c, 400, "api_key is required for api_key providers", "missing_api_key");
    }

    const providerId = (body.provider_id ?? baseIdFor(name.toLowerCase().replace(/[^a-z0-9_-]/g, "")) ?? "custom").toLowerCase() || "custom";
    let id = (body.id ?? "").trim().toLowerCase().replace(ID_SANITIZE_RE, "");
    if (!id) id = `${providerId}-${Date.now()}`;
    const existing = await env.DB.prepare("SELECT id FROM providers WHERE id = ?").bind(id).first();
    if (existing) {
        return apiError(c, 400, `Connection id "${id}" already exists`, "duplicate_id");
    }

    const secretsEnc = await encryptSecretsObject(
        {
            api_key: body.api_key || undefined,
            access_token: body.access_token || undefined,
            refresh_token: body.refresh_token || undefined
        },
        env.MASTER_KEY
    );
    const now = Date.now();
    await env.DB.prepare(
        `INSERT INTO providers
         (id, provider_id, name, alias, category, protocol, base_url, secrets_enc,
          account_id, organization_id, provider_specific_data, custom_headers,
          token_expires_at, last_refreshed_at, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, 1, ?)`
    )
        .bind(
            id,
            providerId,
            name,
            body.alias ?? null,
            category,
            protocol,
            body.base_url ?? null,
            secretsEnc,
            body.provider_specific_data ? JSON.stringify(body.provider_specific_data) : null,
            body.custom_headers ? JSON.stringify(body.custom_headers) : null,
            now
        )
        .run();

    const row = await env.DB.prepare("SELECT * FROM providers WHERE id = ?").bind(id).first<ProviderRowFull>();
    return c.json(toProviderConfig(row!), 201);
});

// ---------------------------------------------------------------------------
// DELETE /v1/providers/:id — delete a connection
// ---------------------------------------------------------------------------

providersRoutes.delete("/:id", requireAdmin, async (c) => {
    const id = reqParam(c, "id");
    const res = await c.env.DB.prepare("DELETE FROM providers WHERE id = ?").bind(id).run();
    if (!res.meta.changes) {
        return apiError(c, 404, "Connection not found", "connection_not_found");
    }
    return c.json({ message: "Connection deleted" });
});

// ---------------------------------------------------------------------------
// Custom models
// ---------------------------------------------------------------------------

const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,200}$/;

providersRoutes.post("/:providerId/models", requireAdmin, async (c) => {
    const providerId = reqParam(c, "providerId");
    const body = (await c.req.json().catch(() => null)) as { model_id?: string } | null;
    const modelId = (body?.model_id ?? "").trim();
    if (!MODEL_ID_RE.test(modelId)) {
        return apiError(c, 400, "model_id must be 1-200 chars of [A-Za-z0-9._:/-]", "invalid_model_id");
    }
    await c.env.DB.prepare(
        "INSERT OR IGNORE INTO custom_models (provider_id, model_id, created_at) VALUES (?, ?, ?)"
    )
        .bind(providerId.toLowerCase(), modelId, Date.now())
        .run();
    const alias = catalogAliasFor(baseIdFor(providerId)) ?? providerAlias(baseIdFor(providerId));
    return c.json({ id: `${alias}/${modelId}`, object: "model", owned_by: alias }, 201);
});

providersRoutes.delete("/:providerId/models/:modelId", requireAdmin, async (c) => {
    const providerId = reqParam(c, "providerId");
    const modelId = reqParam(c, "modelId");
    const res = await c.env.DB.prepare(
        "DELETE FROM custom_models WHERE provider_id = ? AND model_id = ?"
    )
        .bind(providerId.toLowerCase(), modelId)
        .run();
    if (!res.meta.changes) {
        return apiError(c, 404, "Custom model not found", "model_not_found");
    }
    return c.json({ message: "Custom model deleted" });
});

// ---------------------------------------------------------------------------
// Hidden models
// ---------------------------------------------------------------------------

providersRoutes.get("/:providerId/hidden-models", apiKeyAuth, async (c) => {
    const providerId = reqParam(c, "providerId").toLowerCase();
    const res = await c.env.DB.prepare(
        "SELECT model_id FROM hidden_models WHERE provider_id = ? ORDER BY created_at ASC"
    )
        .bind(providerId)
        .all<{ model_id: string }>();
    return c.json({ models: (res.results ?? []).map((r) => r.model_id) });
});

providersRoutes.post("/:providerId/hidden-models", requireAdmin, async (c) => {
    const providerId = reqParam(c, "providerId").toLowerCase();
    const body = (await c.req.json().catch(() => null)) as { model_id?: string } | null;
    const modelId = (body?.model_id ?? "").trim();
    if (!modelId) return apiError(c, 400, "model_id is required", "missing_model_id");
    await c.env.DB.prepare(
        "INSERT OR IGNORE INTO hidden_models (provider_id, model_id, created_at) VALUES (?, ?, ?)"
    )
        .bind(providerId, modelId, Date.now())
        .run();
    return c.json({ message: "Model hidden" }, 201);
});

providersRoutes.delete("/:providerId/hidden-models/:modelId", requireAdmin, async (c) => {
    const providerId = reqParam(c, "providerId").toLowerCase();
    const modelId = reqParam(c, "modelId");
    const res = await c.env.DB.prepare(
        "DELETE FROM hidden_models WHERE provider_id = ? AND model_id = ?"
    )
        .bind(providerId, modelId)
        .run();
    if (!res.meta.changes) {
        return apiError(c, 404, "Hidden model not found", "model_not_found");
    }
    return c.json({ message: "Model restored" });
});

// ---------------------------------------------------------------------------
// PATCH /v1/providers/:providerId/round-robin and /enabled
// ---------------------------------------------------------------------------

async function detailDefinition(db: D1Database, providerId: string): Promise<ProviderDefinitionWire | null> {
    const base = baseIdFor(providerId.toLowerCase());
    const entry =
        KNOWN_PROVIDERS.find((p) => p.id === base) ??
        (await (async () => {
            const rows = await allProviderRows(db);
            const synth = syntheticEntries(rows).find((e) => e.id === base);
            return synth ?? null;
        })());
    if (!entry) return null;
    const rows = (await allProviderRows(db)).filter((r) => baseIdFor(r.provider_id) === base);
    if (rows.length === 0 && !KNOWN_IDS.has(base)) return null;
    return buildDefinition(db, entry, rows, { includeConnections: true });
}

providersRoutes.patch("/:providerId/round-robin", requireAdmin, async (c) => {
    const providerId = reqParam(c, "providerId").toLowerCase();
    const body = (await c.req.json().catch(() => null)) as { enabled?: boolean } | null;
    if (typeof body?.enabled !== "boolean") {
        return apiError(c, 400, "enabled (boolean) is required", "invalid_body");
    }
    const db = c.env.DB;
    const base = baseIdFor(providerId);
    await setSetting(db, `round_robin_${base}`, body.enabled ? "true" : "false");
    const def = await detailDefinition(db, base);
    if (!def) return apiError(c, 404, "Provider not found", "provider_not_found");
    return c.json(def);
});

providersRoutes.patch("/:providerId/enabled", requireAdmin, async (c) => {
    const providerId = reqParam(c, "providerId").toLowerCase();
    const body = (await c.req.json().catch(() => null)) as { enabled?: boolean } | null;
    if (typeof body?.enabled !== "boolean") {
        return apiError(c, 400, "enabled (boolean) is required", "invalid_body");
    }
    const db = c.env.DB;
    const base = baseIdFor(providerId);
    await setSetting(db, `provider_enabled_${base}`, body.enabled ? "true" : "false");
    // Keep the per-row gateway routing flag in sync with the catalog flag.
    const rows = await allProviderRows(db);
    const ids = rows.filter((r) => baseIdFor(r.provider_id) === base).map((r) => r.id);
    if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(",");
        await db
            .prepare(`UPDATE providers SET enabled = ? WHERE id IN (${placeholders})`)
            .bind(body.enabled ? 1 : 0, ...ids)
            .run();
    }
    const def = await detailDefinition(db, base);
    if (!def) return apiError(c, 404, "Provider not found", "provider_not_found");
    return c.json(def);
});

// ---------------------------------------------------------------------------
// GET /v1/providers/:providerId — detail with connections + live models
// ---------------------------------------------------------------------------

providersRoutes.get("/:providerId", apiKeyAuth, async (c) => {
    const env = c.env as Env;
    const providerId = reqParam(c, "providerId");
    const base = baseIdFor(providerId.toLowerCase());

    const entry =
        KNOWN_PROVIDERS.find((p) => p.id === base) ??
        syntheticEntries(await allProviderRows(env.DB)).find((e) => e.id === base);
    if (!entry) {
        return apiError(c, 404, "Provider not found", "provider_not_found");
    }
    const rows = (await allProviderRows(env.DB)).filter((r) => baseIdFor(r.provider_id) === base);
    if (rows.length === 0 && !KNOWN_IDS.has(base)) {
        return apiError(c, 404, "Provider not found", "provider_not_found");
    }

    const def = await buildDefinition(env.DB, entry, rows, { includeConnections: true });

    // Live models for this provider only (failures swallowed, like SRouter).
    try {
        const models = await getMergedModels(env, { providerFilter: base, skipCache: true });
        def.models = models.filter((m) => {
            const owned = (m as { owned_by?: string }).owned_by;
            return owned !== "srouter";
        });
    } catch {
        def.models = [];
    }
    return c.json(def);
});
