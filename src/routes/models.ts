// GET /v1/models — aggregated OpenAI-compatible model list.
// Served from the RouterState DO cache (5-min TTL), refreshed on demand from
// each account's listModels(). Same auth as chat.
//
// Phase 2 (dashboard parity with SRouter's ModelsLogic.GetAllModels):
//   - ?refresh=true / ?force=true skips the DO cache read
//   - merges custom_models rows as "<alias>/<modelId>" (custom: true)
//   - merges enabled fallback_rules as synthetic "srouter/<source>" combo entries
//   - removes hidden_models entries (full-id, case-insensitive match)
//   - filters to allowed_models when the caller authenticates with a restricted key
//   - Cache-Control: public, max-age=60, stale-while-revalidate=300

import { Hono } from "hono";
import type { AppHonoEnv } from "../hono-env.js";
import type { Env } from "../env.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { listAllModels, loadAccounts, providerAlias } from "../providers/registry.js";
import { getModelCatalog, rebuildModelCatalog } from "../router/catalog.js";
import { catalogAliasFor } from "./v1/providers.js";

export const modelsRoutes = new Hono<AppHonoEnv>();

/**
 * c.executionCtx throws ("This context has no ExecutionContext") under
 * hono's test client (app.request). Production always has one. Treat it as
 * optional: without it, catalog rebuilds run inline instead of via waitUntil.
 */
function maybeExecutionCtx(c: {
    executionCtx: { waitUntil(p: Promise<unknown>): void };
}): { waitUntil(p: Promise<unknown>): void } | undefined {
    try {
        const ec = c.executionCtx;
        return typeof ec?.waitUntil === "function" ? ec : undefined;
    } catch {
        return undefined;
    }
}

export interface ModelObject {
    id: string;
    object: "model";
    created?: number;
    owned_by: string;
    custom?: boolean;
}

async function providerEnabled(db: D1Database, providerId: string): Promise<boolean> {
    const row = await db
        .prepare("SELECT value FROM system_settings WHERE key = ?")
        .bind(`provider_enabled_${providerId.toLowerCase()}`)
        .first<{ value: string }>();
    return row == null || row.value === "true";
}

/** Alias used for "<alias>/<model>" ids of a provider base id. */
async function aliasForProvider(db: D1Database, providerId: string): Promise<string> {
    const row = await db
        .prepare("SELECT alias FROM providers WHERE provider_id = ? AND alias IS NOT NULL LIMIT 1")
        .bind(providerId)
        .first<{ alias: string }>();
    if (row?.alias) return row.alias;
    return catalogAliasFor(providerId) ?? providerAlias(providerId);
}

/**
 * Build the full merged model list:
 *   base (upstream aggregation, DO-cached) + custom models + combo entries − hidden.
 * Exported for the provider detail endpoint (with providerFilter).
 */
export async function getMergedModels(
    env: Env,
    opts: { providerFilter?: string; skipCache?: boolean } = {},
    executionCtx?: { waitUntil(p: Promise<unknown>): void }
): Promise<ModelObject[]> {
    const db = env.DB;

    if (!opts.providerFilter) {
        // Aggregated catalog: stale-while-revalidate. The request path never
        // fans out to upstreams; the cron rebuilds in the background and a
        // force refresh single-flights one rebuild.
        if (opts.skipCache) {
            await rebuildModelCatalog(env);
        }
        const catalog = await getModelCatalog(env, executionCtx);
        // getModelCatalog returns null only when no data exists at all
        // (cold start + build failure). Custom/combo models are still merged
        // below; upstream ids are simply absent until a build lands.
        return mergeDbModels(db, catalog ?? [], undefined);
    }

    // Per-provider detail view: aggregate just that provider's accounts.
    let accounts = await loadAccounts(db, env.MASTER_KEY);
    const f = opts.providerFilter.toLowerCase();
    accounts = accounts.filter((a) => a.providerType.toLowerCase() === f);
    const base = (await listAllModels(accounts)) as ModelObject[];
    return mergeDbModels(db, base, opts.providerFilter);
}

/** Merge custom models, combo entries, then filter hidden — SRouter's MergeCustomModels / MergeComboModels / FilterHiddenModels. */
async function mergeDbModels(
    db: D1Database,
    base: ModelObject[],
    providerFilter?: string
): Promise<ModelObject[]> {
    const merged = new Map<string, ModelObject>();
    for (const m of base) merged.set(m.id.toLowerCase(), m);

    // Custom models: "<alias>/<modelId>", only for enabled providers.
    const customRows = await db
        .prepare("SELECT provider_id, model_id FROM custom_models")
        .all<{ provider_id: string; model_id: string }>();
    for (const row of customRows.results ?? []) {
        if (!(await providerEnabled(db, row.provider_id))) continue;
        const alias = await aliasForProvider(db, row.provider_id);
        if (providerFilter && !alias.toLowerCase().startsWith(providerFilter.toLowerCase())) continue;
        const id = `${alias}/${row.model_id}`;
        merged.set(id.toLowerCase(), { id, object: "model", owned_by: alias, custom: true });
    }

    // Combo entries from enabled fallback rules (skip for per-provider detail).
    if (!providerFilter) {
        const rules = await db
            .prepare("SELECT source_model FROM fallback_rules WHERE enabled = 1")
            .all<{ source_model: string }>();
        for (const rule of (rules.results ?? []).map((r) => r.source_model.trim())) {
            if (!rule || rule === "*" || rule.endsWith("/*")) continue;
            const virtualId = rule.startsWith("srouter/") ? rule : `srouter/${rule}`;
            merged.set(rule.toLowerCase(), {
                id: virtualId,
                object: "model",
                owned_by: "srouter",
                custom: true
            });
        }
    }

    // Hidden models: full-id, case-insensitive.
    const hiddenRows = await db.prepare("SELECT model_id FROM hidden_models").all<{ model_id: string }>();
    const hidden = new Set((hiddenRows.results ?? []).map((r) => r.model_id.toLowerCase()));
    if (hidden.size > 0) {
        for (const key of [...merged.keys()]) {
            if (hidden.has(key)) merged.delete(key);
        }
    }

    return [...merged.values()];
}

function normalizeModelId(id: string): string {
    return id.replace(/^srouter\//, "").toLowerCase();
}

function isModelAllowed(allowed: string[], modelId: string): boolean {
    const requested = normalizeModelId(modelId);
    return allowed.some((a) => {
        const norm = normalizeModelId(a);
        return norm === requested || a.toLowerCase() === modelId.toLowerCase();
    });
}

modelsRoutes.get("/models", apiKeyAuth, async (c) => {
    const force =
        c.req.query("refresh") === "true" ||
        c.req.query("refresh") === "1" ||
        c.req.query("force") === "true" ||
        c.req.query("force") === "1";
    const cacheControl = c.req.header("cache-control") ?? "";
    const revalidate = cacheControl.includes("no-cache") || cacheControl.includes("no-store");

    // The response varies per caller when the key carries an allowed_models
    // restriction — edge-caching by URL alone would leak one key's filtered
    // list to another. Only the unrestricted (full) list is edge-cacheable.
    let restricted = false;
    if (c.get("authType") === "api_key") {
        const row = c.get("apiKeyRow") as { allowed_models?: string | null } | undefined;
        if (row?.allowed_models) {
            try {
                const allowed = JSON.parse(row.allowed_models) as string[];
                restricted = Array.isArray(allowed) && allowed.length > 0;
            } catch {
                restricted = false;
            }
        }
    }

    // Edge cache (caches.default), 60s TTL, keyed by URL only. The underlying
    // catalog rebuilds at most every few minutes via cron and the merged
    // custom/combo rows change rarely, so 60s staleness is acceptable.
    // `caches` is undefined under node --test; edgeCache() returns null there.
    const edge = !force && !revalidate && !restricted ? edgeCache() : null;
    const cacheKey = edge ? new Request(c.req.url) : null;
    if (edge && cacheKey) {
        const hit = await edge.match(cacheKey);
        if (hit) return hit;
    }

    let models = await getMergedModels(c.env, { skipCache: force }, maybeExecutionCtx(c));

    const bgCtx = maybeExecutionCtx(c);
    if (revalidate && !force && bgCtx) {
        // Serve the cached view, refresh the DO cache in the background (SRouter parity).
        bgCtx.waitUntil(getMergedModels(c.env, { skipCache: true }, bgCtx).catch(() => []));
    }

    // Model allow-list for restricted virtual keys (SRouter's EnforceModelAccess).
    if (c.get("authType") === "api_key") {
        const row = c.get("apiKeyRow");
        let allowed: string[] | null = null;
        if (row?.allowed_models) {
            try {
                allowed = JSON.parse(row.allowed_models) as string[];
            } catch {
                allowed = null;
            }
        }
        if (allowed && allowed.length > 0) {
            models = models.filter((m) => isModelAllowed(allowed, m.id));
        }
    }

    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    const response = c.json({ object: "list", data: models });
    if (edge && cacheKey) {
        // Populate the edge cache in the background; the stored response
        // carries the Cache-Control above, bounding staleness at 60s.
        const putCtx = maybeExecutionCtx(c);
        const put = edge.put(cacheKey, response.clone()).catch(() => {});
        if (putCtx) putCtx.waitUntil(put);
        else await put;
    }
    return response;
});

/**
 * The Workers edge cache (caches.default). Null outside the Workers runtime
 * (e.g. under node --test), where the endpoint simply computes every time.
 * The cast avoids a conflict between the WebWorker lib's CacheStorage and
 * @cloudflare/workers-types' augmentation.
 */
function edgeCache(): Cache | null {
    const storage = (globalThis as unknown as { caches?: { default?: Cache } }).caches;
    return storage?.default ?? null;
}

// GET /v1/models/:model — single model lookup (SRouter's ModelsController.GetModelById).
// The `:model{.+}` pattern allows slashes in model ids
// (e.g. "antigravity/gemini-3.8-flash-high").
modelsRoutes.get("/models/:model{.+}", apiKeyAuth, async (c) => {
    const rawModelId = c.req.param("model");
    const modelId = rawModelId ? decodeURIComponent(rawModelId) : undefined;
    if (!modelId) {
        return c.json(
            {
                error: {
                    message: "Model ID parameter is required",
                    type: "invalid_request_error",
                    code: "invalid_request"
                }
            },
            400
        );
    }

    // Enforce the key's model allow-list before revealing existence (SRouter parity).
    if (c.get("authType") === "api_key") {
        const row = c.get("apiKeyRow");
        let allowed: string[] | null = null;
        if (row?.allowed_models) {
            try {
                allowed = JSON.parse(row.allowed_models) as string[];
            } catch {
                allowed = null;
            }
        }
        if (allowed && allowed.length > 0 && !isModelAllowed(allowed, modelId)) {
            return c.json(
                {
                    error: {
                        message: `Model '${modelId}' is not allowed for this API key`,
                        type: "invalid_request_error",
                        code: "model_not_allowed"
                    }
                },
                403
            );
        }
    }

    const force =
        c.req.query("refresh") === "true" ||
        c.req.query("refresh") === "1" ||
        c.req.query("force") === "true" ||
        c.req.query("force") === "1";

    const models = await getMergedModels(c.env, { skipCache: force }, maybeExecutionCtx(c));
    const found = models.find((m) => m.id.toLowerCase() === modelId.toLowerCase());
    if (found) {
        c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
        return c.json(found);
    }
    return c.json(
        {
            error: {
                message: `Model '${modelId}' not found`,
                type: "invalid_request_error",
                code: "model_not_found"
            }
        },
        404
    );
});
