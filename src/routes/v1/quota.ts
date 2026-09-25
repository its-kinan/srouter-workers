// GET /v1/quota — per-account usage-derived quota view (Phase 2).
// Mounted at /v1/quota by src/index.ts.
//
// SRouter fetches live figures from each OAuth upstream; on Workers we report
// usage logged in request_logs instead, so quotaType is always "usage_logged".
// The dashboard renders this identically.

import { Hono } from "hono";
import type { AppHonoEnv } from "../../hono-env.js";
import { apiKeyAuth } from "../../middleware/apiKeyAuth.js";

export const quotaRoutes = new Hono<AppHonoEnv>();

interface UsageMetric {
    model: string;
    totalRequests: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    lastUsedAt: string | null;
}

quotaRoutes.get("/", apiKeyAuth, async (c) => {
    const db = c.env.DB;
    const force = c.req.query("force") === "true" || c.req.query("refresh") === "true";

    const rows = await db
        .prepare("SELECT id, provider_id, name, enabled FROM providers ORDER BY created_at ASC")
        .all<{ id: string; provider_id: string; name: string; enabled: number }>();

    const providers: {
        id: string;
        provider: string;
        account: string;
        enabled: boolean;
        quotaType: "usage_logged";
        usageMetrics: UsageMetric[];
    }[] = [];

    for (const row of rows.results ?? []) {
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

    // `force` is accepted for dashboard compatibility (no upstream cache here).
    void force;
    return c.json({
        object: "quota",
        totalAccounts: providers.length,
        providers
    });
});
