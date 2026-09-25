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
import { catalogAliasFor } from "./v1/providers.js";

export const modelsRoutes = new Hono<AppHonoEnv>();

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
    opts: { providerFilter?: string; skipCache?: boolean } = {}
): Promise<ModelObject[]> {
    const db = env.DB;
    const stub = env.ROUTER_STATE.getByName("router");

    // 1. Base list: upstream aggregation.
    let base: ModelObject[];
    if (!opts.skipCache && !opts.providerFilter) {
        try {
            const cached = await stub.fetch(new Request("https://do/models"));
            const data = (await cached.json()) as { models: ModelObject[] | null };
            if (data.models) {
                base = data.models;
                return mergeDbModels(db, base, opts.providerFilter);
            }
        } catch {
            // fall through to refresh
        }
    }

    let accounts = await loadAccounts(db, env.MASTER_KEY);
    if (opts.providerFilter) {
        const f = opts.providerFilter.toLowerCase();
        accounts = accounts.filter((a) => a.providerType.toLowerCase() === f);
    }
    base = (await listAllModels(accounts)) as ModelObject[];

    if (!opts.providerFilter) {
        stub
            .fetch(
                new Request("https://do/models", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ models: base })
                })
            )
            .catch(() => {});
    }
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

    let models = await getMergedModels(c.env, { skipCache: force });

    if (revalidate && !force) {
        // Serve the cached view, refresh the DO cache in the background (SRouter parity).
        c.executionCtx.waitUntil(getMergedModels(c.env, { skipCache: true }).catch(() => []));
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
    return c.json({ object: "list", data: models });
});
