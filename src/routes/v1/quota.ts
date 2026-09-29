// GET /v1/quota — quota & limits view.
// Ported 1:1 from SRouter's QuotaLogic: OAuth providers with live quota support
// (Antigravity, CodeBuddy CN, OpenAI Codex) fetch live figures from upstream;
// all other providers report usage logged in request_logs (quotaType "usage_logged").
//
// Live results are cached 60s (like the original's CACHE_TTL_MS); force refresh
// via ?force=true or ?refresh=true.

import { Hono, type Context } from "hono";
import type { AppHonoEnv } from "../../hono-env.js";
import { apiKeyAuth } from "../../middleware/apiKeyAuth.js";
import { loadAccountMetas, decryptAccountSecrets } from "../../providers/registry.js";
import {
    fetchLiveQuota,
    isLiveQuotaSupported,
    type ProviderQuotaAccount
} from "../../quota/fetchers.js";

export const quotaRoutes = new Hono<AppHonoEnv>();

const CACHE_TTL_MS = 60_000;
let cached: { at: number; data: { object: "quota"; totalAccounts: number; providers: ProviderQuotaAccount[] } } | null = null;
let inFlight: Promise<{ object: "quota"; totalAccounts: number; providers: ProviderQuotaAccount[] }> | null = null;

async function buildQuota(env: AppHonoEnv["Bindings"]): Promise<{ object: "quota"; totalAccounts: number; providers: ProviderQuotaAccount[] }> {
    const db = (env as { DB: D1Database }).DB;
    const masterKey = (env as { MASTER_KEY?: string }).MASTER_KEY ?? "";

    const rows = await db
        .prepare("SELECT id, provider_id, name, enabled FROM providers ORDER BY created_at ASC")
        .all<{ id: string; provider_id: string; name: string; enabled: number }>();

    const providers: ProviderQuotaAccount[] = [];

    // Live quota for supported OAuth providers (concurrent, failures skipped).
    // Secrets decrypt lazily — only the handful of live-quota accounts, not
    // every row.
    const liveRows = (rows.results ?? []).filter((r) => isLiveQuotaSupported(r.provider_id));
    if (masterKey && liveRows.length > 0) {
        const metas = await loadAccountMetas(db, {
            providerTypes: [...new Set(liveRows.map((r) => r.provider_id))]
        });
        const byId = new Map(metas.map((m) => [m.id, m]));
        const settled = await Promise.allSettled(
            liveRows.map(async (row) => {
                const meta = byId.get(row.id);
                if (!meta) return null;
                let accessToken: string | undefined;
                try {
                    const account = await decryptAccountSecrets(meta, masterKey);
                    accessToken = account.accessToken || account.apiKey;
                } catch {
                    return null;
                }
                if (!accessToken) return null;
                const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 20000));
                return await Promise.race([
                    fetchLiveQuota({
                        id: row.id,
                        providerId: row.provider_id,
                        name: row.name,
                        accessToken,
                        accountId: meta.accountId,
                        enabled: row.enabled === 1
                    }),
                    timeout
                ]);
            })
        );
        for (const s of settled) {
            if (s.status === "fulfilled" && s.value) providers.push(s.value);
        }
    }
    const liveIds = new Set(providers.map((p) => p.id));

    // Usage-logged fallback for everyone else (and live rows that failed).
    for (const row of rows.results ?? []) {
        if (liveIds.has(row.id)) continue;
        const metrics = await db
            .prepare(
                `SELECT model,
                        COUNT(*) AS totalRequests,
                        COALESCE(SUM(total_tokens), 0) AS totalTokens,
                        COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
                        COALESCE(SUM(completion_tokens), 0) AS completionTokens,
                        MAX(created_at) AS lastUsedAt
                 FROM request_logs
                 WHERE provider_id = ? AND account_id = ?
                 GROUP BY model
                 ORDER BY totalRequests DESC`
            )
            .bind(row.provider_id, row.id)
            .all<{
                model: string;
                totalRequests: number;
                totalTokens: number;
                promptTokens: number;
                completionTokens: number;
                lastUsedAt: number | null;
            }>();

        providers.push({
            id: row.id,
            provider: row.provider_id,
            account: row.name,
            enabled: row.enabled === 1,
            quotaType: "usage_logged",
            usageMetrics: (metrics.results ?? []).map((m) => ({
                model: m.model,
                totalRequests: m.totalRequests,
                totalTokens: m.totalTokens,
                promptTokens: m.promptTokens,
                completionTokens: m.completionTokens,
                lastUsedAt: m.lastUsedAt != null ? new Date(m.lastUsedAt).toISOString() : null
            }))
        });
    }

    return { object: "quota", totalAccounts: providers.length, providers };
}

quotaRoutes.get("/", apiKeyAuth, handleQuota);

// Exported so index.ts can mount the "/v1/qouta" typo alias (SRouter parity:
// the original QuotaRouter registers both "/quota" and "/qouta").
export async function handleQuota(c: Context<AppHonoEnv>) {
    const env = c.env as AppHonoEnv["Bindings"];
    const force = c.req.query("force") === "true" || c.req.query("refresh") === "true";
    const now = Date.now();

    if (!force && cached && now - cached.at < CACHE_TTL_MS) {
        return c.json(cached.data);
    }
    if (inFlight) {
        return c.json(await inFlight);
    }
    inFlight = (async () => {
        try {
            const data = await buildQuota(env);
            cached = { at: Date.now(), data };
            return data;
        } finally {
            inFlight = null;
        }
    })();
    return c.json(await inFlight);
}
