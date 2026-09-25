// SRouter-compatible /v1/logs/* dashboard endpoints.
//
// Mirrors SRouter's logs & analytics surface (apps/api logs controller):
//   GET  /            recent-or-paginated request log list (dual mode)
//   GET  /stats       all-time usage aggregates
//   GET  /analytics   time-bucketed analytics report (?window=1h|24h|7d|30d)
//   GET  /events      minimal SSE stream (connected + ping heartbeats;
//                     live updates also arrive via the dashboard's polling)
//   GET  /:id         single enriched log entry
//
// DB rows are snake_case; the wire format is camelCase (RequestLogEntry).
// Cost enrichment uses the bundled models.dev pricing snapshot
// (src/lib/pricing-data.ts). All routes require apiKeyAuth.

import { Hono } from "hono";
import type { AppHonoEnv } from "../../hono-env.js";
import { apiKeyAuth } from "../../middleware/apiKeyAuth.js";
import { apiError } from "../../lib/api-error.js";
import { estimateCost } from "../../lib/pricing-data.js";

export const logsRoutes = new Hono<AppHonoEnv>();

// ---------------------------------------------------------------------------
// DB row + wire shapes
// ---------------------------------------------------------------------------

interface RequestLogRow {
    id: string;
    api_key_id: string | null;
    ip_address: string | null;
    user_agent: string | null;
    provider_id: string;
    account_id: string | null;
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    status_code: number;
    latency_ms: number;
    cached_tokens: number;
    cache_creation_tokens: number;
    reasoning_tokens: number;
    estimated_cost: number;
    fallback_occurred: number;
    fallback_path: string | null;
    fallback_reason: string | null;
    resolved_model: string | null;
    created_at: number;
}

interface CostBreakdown {
    inputCost: number;
    outputCost: number;
    cacheReadCost: number;
    totalCost: number;
}

interface RequestLogEntry {
    id: string;
    apiKeyId?: string;
    apiKeyName?: string;
    ipAddress?: string;
    userAgent?: string;
    providerId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    statusCode: number;
    latencyMs: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
    reasoningTokens?: number;
    estimatedCost?: number;
    costBreakdown?: CostBreakdown;
    fallbackOccurred?: boolean;
    fallbackPath?: string;
    fallbackReason?: string;
    resolvedModel?: string;
    createdAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiKeyNameMap(db: D1Database): Promise<Map<string, string>> {
    const rows = await db
        .prepare("SELECT id, name FROM api_keys")
        .all<{ id: string; name: string }>();
    const map = new Map<string, string>();
    for (const r of rows.results ?? []) map.set(r.id, r.name);
    return map;
}

async function requireApiKeyEnabled(db: D1Database): Promise<boolean> {
    const row = await db
        .prepare("SELECT value FROM system_settings WHERE key = 'require_api_key'")
        .first<{ value: string }>();
    return row?.value === "true" || row?.value === "1";
}

function enrichRow(
    row: RequestLogRow,
    keyNames: Map<string, string>,
    keepApiKeyId: boolean
): RequestLogEntry {
    const breakdown = estimateCost(
        row.model,
        row.prompt_tokens,
        row.completion_tokens,
        row.cached_tokens
    );
    const entry: RequestLogEntry = {
        id: row.id,
        providerId: row.provider_id,
        model: row.model,
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        totalTokens: row.total_tokens,
        statusCode: row.status_code,
        latencyMs: row.latency_ms,
        fallbackOccurred: row.fallback_occurred === 1,
        createdAt: row.created_at
    };
    if (keepApiKeyId && row.api_key_id) {
        entry.apiKeyId = row.api_key_id;
        const name = keyNames.get(row.api_key_id);
        if (name) entry.apiKeyName = name;
    }
    if (row.ip_address) entry.ipAddress = row.ip_address;
    if (row.user_agent) entry.userAgent = row.user_agent;
    if (row.cached_tokens) entry.cachedTokens = row.cached_tokens;
    if (row.cache_creation_tokens) entry.cacheCreationTokens = row.cache_creation_tokens;
    if (row.reasoning_tokens) entry.reasoningTokens = row.reasoning_tokens;
    if (breakdown) {
        entry.costBreakdown = breakdown;
        entry.estimatedCost = breakdown.totalCost;
    } else if (row.estimated_cost) {
        entry.estimatedCost = row.estimated_cost;
    }
    if (row.fallback_path) entry.fallbackPath = row.fallback_path;
    if (row.fallback_reason) entry.fallbackReason = row.fallback_reason;
    if (row.resolved_model) entry.resolvedModel = row.resolved_model;
    return entry;
}

function statusCondition(status: string): { sql: string; params: number[] } {
    if (status === "success") return { sql: "AND status_code BETWEEN 200 AND 299", params: [] };
    if (status === "error") return { sql: "AND (status_code < 200 OR status_code > 299)", params: [] };
    return { sql: "", params: [] };
}

// ---------------------------------------------------------------------------
// GET / — recent (no ?page) or paginated (?page present) log list
// ---------------------------------------------------------------------------

logsRoutes.get("/", apiKeyAuth, async (c) => {
    const db = c.env.DB;
    const params = c.req.query();
    const paginated = params.page !== undefined;
    const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(params.limit ?? "50", 10) || 50));
    const status = (params.status ?? "all").toLowerCase();
    const cond = statusCondition(status);

    const [keyNames, keepApiKeyId] = await Promise.all([
        apiKeyNameMap(db),
        requireApiKeyEnabled(db)
    ]);

    let rows: RequestLogRow[];
    let total = 0;
    if (paginated) {
        const offset = (page - 1) * limit;
        const [listRes, countRes] = await Promise.all([
            db
                .prepare(
                    `SELECT * FROM request_logs WHERE 1 = 1 ${cond.sql}
                     ORDER BY created_at DESC LIMIT ? OFFSET ?`
                )
                .bind(limit, offset)
                .all<RequestLogRow>(),
            db
                .prepare(`SELECT COUNT(*) AS n FROM request_logs WHERE 1 = 1 ${cond.sql}`)
                .first<{ n: number }>()
        ]);
        rows = listRes.results ?? [];
        total = countRes?.n ?? 0;
    } else {
        const listRes = await db
            .prepare(
                `SELECT * FROM request_logs WHERE 1 = 1 ${cond.sql}
                 ORDER BY created_at DESC LIMIT ?`
            )
            .bind(limit)
            .all<RequestLogRow>();
        rows = listRes.results ?? [];
    }

    const data = rows.map((r) => enrichRow(r, keyNames, keepApiKeyId));
    if (!paginated) {
        return c.json({ object: "list", data });
    }
    return c.json({
        object: "list",
        data,
        pagination: { page, limit, total, total_pages: Math.ceil(total / limit) }
    });
});

// ---------------------------------------------------------------------------
// GET /stats — all-time usage aggregates
// ---------------------------------------------------------------------------

logsRoutes.get("/stats", apiKeyAuth, async (c) => {
    const db = c.env.DB;

    const totals = await db
        .prepare(
            `SELECT COUNT(*) AS total_requests,
                    SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS success_requests,
                    COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                    COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                    COALESCE(SUM(total_tokens), 0) AS total_tokens,
                    COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
                    COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
                    COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
                    COALESCE(SUM(estimated_cost), 0) AS estimated_cost
             FROM request_logs`
        )
        .first<{
            total_requests: number;
            success_requests: number;
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
            cached_tokens: number;
            cache_creation_tokens: number;
            reasoning_tokens: number;
            estimated_cost: number;
        }>();

    const byModelRows = await db
        .prepare(
            `SELECT model,
                    COUNT(*) AS total_requests,
                    COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                    COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                    COALESCE(SUM(cached_tokens), 0) AS cached_tokens
             FROM request_logs
             GROUP BY model
             ORDER BY total_requests DESC`
        )
        .all<{
            model: string;
            total_requests: number;
            prompt_tokens: number;
            completion_tokens: number;
            cached_tokens: number;
        }>();

    const byModel = (byModelRows.results ?? []).map((r) => {
        const breakdown = estimateCost(r.model, r.prompt_tokens, r.completion_tokens, r.cached_tokens);
        return {
            model: r.model,
            totalRequests: r.total_requests,
            totalInputTokens: r.prompt_tokens,
            totalOutputTokens: r.completion_tokens,
            totalCachedTokens: r.cached_tokens,
            estCost: breakdown ? breakdown.totalCost : 0
        };
    });

    const totalEstimatedCost = totals?.estimated_cost ?? 0;
    return c.json({
        object: "usage",
        totalRequests: totals?.total_requests ?? 0,
        totalSuccessRequests: totals?.success_requests ?? 0,
        totalTokens: totals?.total_tokens ?? 0,
        totalPromptTokens: totals?.prompt_tokens ?? 0,
        totalCompletionTokens: totals?.completion_tokens ?? 0,
        totalCachedTokens: totals?.cached_tokens ?? 0,
        totalCacheCreationTokens: totals?.cache_creation_tokens ?? 0,
        totalReasoningTokens: totals?.reasoning_tokens ?? 0,
        totalEstimatedCost,
        totalInputTokens: totals?.prompt_tokens ?? 0,
        totalOutputTokens: totals?.completion_tokens ?? 0,
        costLabel: `$${totalEstimatedCost.toFixed(2)}`,
        estimated: true,
        byModel
    });
});

// ---------------------------------------------------------------------------
// GET /analytics — time-bucketed analytics report
// ---------------------------------------------------------------------------

const WINDOWS = {
    "1h": { windowMs: 3_600_000, bucketSizeMs: 60_000, buckets: 60 },
    "24h": { windowMs: 86_400_000, bucketSizeMs: 3_600_000, buckets: 24 },
    "7d": { windowMs: 604_800_000, bucketSizeMs: 21_600_000, buckets: 28 },
    "30d": { windowMs: 2_592_000_000, bucketSizeMs: 86_400_000, buckets: 30 }
} as const;

type WindowKey = keyof typeof WINDOWS;

logsRoutes.get("/analytics", apiKeyAuth, async (c) => {
    const db = c.env.DB;
    const window = (c.req.query("window") ?? "24h") as string;
    if (!(window in WINDOWS)) {
        return apiError(c, 400, "Invalid window parameter", "invalid_window");
    }
    const { windowMs, bucketSizeMs, buckets: bucketCount } = WINDOWS[window as WindowKey];
    const now = Date.now();
    const windowStart = now - windowMs;

    // Epoch-aligned bucket grid ending at/after now.
    const gridEnd = Math.ceil(now / bucketSizeMs) * bucketSizeMs;
    const gridStart = gridEnd - bucketCount * bucketSizeMs;
    const bucketArr = Array.from({ length: bucketCount }, (_, i) => ({
        bucketStart: gridStart + i * bucketSizeMs,
        totalRequests: 0,
        successRequests: 0,
        errorRequests: 0,
        avgLatencyMs: 0,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        _latSum: 0
    }));

    const bucketRows = await db
        .prepare(
            `SELECT CAST(created_at / ? AS INTEGER) * ? AS bucket,
                    COUNT(*) AS total,
                    SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS success,
                    SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 0 ELSE 1 END) AS errors,
                    COALESCE(AVG(latency_ms), 0) AS avg_latency,
                    COALESCE(SUM(total_tokens), 0) AS total_tokens,
                    COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                    COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                    COALESCE(SUM(cached_tokens), 0) AS cached_tokens
             FROM request_logs
             WHERE created_at >= ?
             GROUP BY bucket`
        )
        .bind(bucketSizeMs, bucketSizeMs, windowStart)
        .all<{
            bucket: number;
            total: number;
            success: number;
            errors: number;
            avg_latency: number;
            total_tokens: number;
            prompt_tokens: number;
            completion_tokens: number;
            cached_tokens: number;
        }>();
    for (const r of bucketRows.results ?? []) {
        const idx = Math.floor((r.bucket - gridStart) / bucketSizeMs);
        if (idx < 0 || idx >= bucketCount) continue;
        const b = bucketArr[idx];
        b.totalRequests = r.total;
        b.successRequests = r.success;
        b.errorRequests = r.errors;
        b.avgLatencyMs = Math.round(r.avg_latency * 100) / 100;
        b.totalTokens = r.total_tokens;
        b.promptTokens = r.prompt_tokens;
        b.completionTokens = r.completion_tokens;
        b.cachedTokens = r.cached_tokens;
    }
    const buckets = bucketArr.map(({ _latSum: _ignored, ...b }) => b);

    const [summary, rpsRow, p95Count, topModelRows, topAgentRows, providerRows] = await Promise.all([
        db
            .prepare(
                `SELECT COUNT(*) AS total,
                        SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 0 ELSE 1 END) AS errors
                 FROM request_logs WHERE created_at >= ?`
            )
            .bind(windowStart)
            .first<{ total: number; errors: number }>(),
        db
            .prepare("SELECT COUNT(*) AS n FROM request_logs WHERE created_at >= ?")
            .bind(now - 60_000)
            .first<{ n: number }>(),
        db
            .prepare("SELECT COUNT(*) AS n FROM request_logs WHERE created_at >= ?")
            .bind(windowStart)
            .first<{ n: number }>(),
        db
            .prepare(
                `SELECT model, COUNT(*) AS total_requests,
                        COALESCE(SUM(total_tokens), 0) AS total_tokens,
                        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                        COALESCE(SUM(cached_tokens), 0) AS cached_tokens
                 FROM request_logs WHERE created_at >= ?
                 GROUP BY model ORDER BY total_requests DESC LIMIT 10`
            )
            .bind(windowStart)
            .all<{
                model: string;
                total_requests: number;
                total_tokens: number;
                prompt_tokens: number;
                completion_tokens: number;
                cached_tokens: number;
            }>(),
        db
            .prepare(
                `SELECT user_agent, COUNT(*) AS total_requests,
                        COALESCE(SUM(total_tokens), 0) AS total_tokens
                 FROM request_logs
                 WHERE created_at >= ? AND user_agent IS NOT NULL AND user_agent != ''
                 GROUP BY user_agent ORDER BY total_requests DESC LIMIT 10`
            )
            .bind(windowStart)
            .all<{ user_agent: string; total_requests: number; total_tokens: number }>(),
        db
            .prepare(
                `SELECT provider_id, COUNT(*) AS total_requests
                 FROM request_logs WHERE created_at >= ?
                 GROUP BY provider_id ORDER BY total_requests DESC`
            )
            .bind(windowStart)
            .all<{ provider_id: string; total_requests: number }>()
    ]);

    const totalRequests = summary?.total ?? 0;
    const errorRequests = summary?.errors ?? 0;
    const errorRate = totalRequests > 0 ? Math.round((errorRequests / totalRequests) * 1000) / 1000 : 0;
    const requestsPerSecond = Math.round(((rpsRow?.n ?? 0) / 60) * 100) / 100;

    let p95LatencyMs = 0;
    const p95Total = p95Count?.n ?? 0;
    if (p95Total > 0) {
        const offset = Math.min(p95Total - 1, Math.floor(p95Total * 0.95));
        const p95Row = await db
            .prepare(
                `SELECT latency_ms FROM request_logs
                 WHERE created_at >= ?
                 ORDER BY latency_ms ASC LIMIT 1 OFFSET ?`
            )
            .bind(windowStart, offset)
            .first<{ latency_ms: number }>();
        p95LatencyMs = p95Row?.latency_ms ?? 0;
    }

    const topModels = (topModelRows.results ?? []).map((r) => {
        const breakdown = estimateCost(r.model, r.prompt_tokens, r.completion_tokens, r.cached_tokens);
        return {
            model: r.model,
            totalRequests: r.total_requests,
            totalTokens: r.total_tokens,
            estCost: breakdown ? breakdown.totalCost : 0
        };
    });

    const topAgents = (topAgentRows.results ?? []).map((r) => ({
        agent: r.user_agent.split(/[/\s]/)[0] || r.user_agent,
        rawUserAgent: r.user_agent,
        totalRequests: r.total_requests,
        totalTokens: r.total_tokens
    }));

    const providers = (providerRows.results ?? []).map((r) => ({
        providerId: r.provider_id,
        totalRequests: r.total_requests
    }));

    return c.json({
        object: "analytics",
        window,
        bucketSizeMs,
        generatedAt: now,
        requestsPerSecond,
        totalRequests,
        errorRate,
        p95LatencyMs,
        buckets,
        topModels,
        topAgents,
        providers
    });
});

// ---------------------------------------------------------------------------
// GET /events — minimal SSE stream (connected + 25s ping heartbeats)
// ---------------------------------------------------------------------------

logsRoutes.get("/events", apiKeyAuth, (c) => {
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected" })}\n\n`));
            timer = setInterval(() => {
                try {
                    controller.enqueue(encoder.encode(": ping\n\n"));
                } catch {
                    if (timer) clearInterval(timer);
                }
            }, 25_000);
        },
        cancel() {
            if (timer) clearInterval(timer);
        }
    });
    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
        }
    });
});

// ---------------------------------------------------------------------------
// GET /:id — single enriched log entry (registered last)
// ---------------------------------------------------------------------------

logsRoutes.get("/:id", apiKeyAuth, async (c) => {
    const db = c.env.DB;
    const row = await db
        .prepare("SELECT * FROM request_logs WHERE id = ?")
        .bind(c.req.param("id"))
        .first<RequestLogRow>();
    if (!row) {
        return apiError(c, 404, "Log entry not found", "log_not_found");
    }
    const [keyNames, keepApiKeyId] = await Promise.all([
        apiKeyNameMap(db),
        requireApiKeyEnabled(db)
    ]);
    return c.json(enrichRow(row, keyNames, keepApiKeyId));
});
