// Gateway settings + fallback combos (SRouter-compatible dashboard surface).
// Mounted at /v1/settings. Reads use ApiKeyAuth; mutations require an admin session.

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppHonoEnv } from "../../hono-env.js";
import { apiKeyAuth } from "../../middleware/apiKeyAuth.js";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { apiError } from "../../lib/api-error.js";

export const v1SettingsRoutes = new Hono<AppHonoEnv>();

function isTruthy(v: string | undefined): boolean {
    return v === "true" || v === "1";
}

async function readSettings(db: D1Database): Promise<Record<string, string>> {
    const rows = await db
        .prepare("SELECT key, value FROM system_settings")
        .all<{ key: string; value: string }>();
    const out: Record<string, string> = {};
    for (const r of rows.results ?? []) out[r.key] = r.value;
    return out;
}

function settingsResponse(settings: Record<string, string>) {
    const require_api_key = isTruthy(settings["require_api_key"]);
    // requireApiKey is an intentional camelCase duplicate for back-compat.
    return { require_api_key, requireApiKey: require_api_key, settings };
}

v1SettingsRoutes.get("/", apiKeyAuth, async (c) => {
    return c.json(settingsResponse(await readSettings(c.env.DB)));
});

const UpdateSettingsSchema = z.object({
    require_api_key: z.boolean().optional(),
    settings: z.record(z.string(), z.unknown()).optional()
});

async function updateSettings(c: Context<AppHonoEnv>) {
    const parsed = UpdateSettingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
        return apiError(c, 400, "Invalid settings payload", "invalid_request");
    }
    const db = c.env.DB;
    const { require_api_key, settings } = parsed.data;
    if (require_api_key !== undefined) {
        await db
            .prepare(
                "INSERT INTO system_settings (key, value) VALUES ('require_api_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            )
            .bind(require_api_key ? "true" : "false")
            .run();
    }
    if (settings) {
        for (const [k, v] of Object.entries(settings)) {
            // Non-string values are silently skipped, matching the original.
            if (typeof v !== "string") continue;
            await db
                .prepare(
                    "INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
                )
                .bind(k, v)
                .run();
        }
    }
    return c.json({
        message: "Settings updated successfully",
        ...settingsResponse(await readSettings(db))
    });
}

v1SettingsRoutes.patch("/", requireAdmin, updateSettings);
v1SettingsRoutes.post("/", requireAdmin, updateSettings);

// --- Fallback combos ("Model Combos" UI) ---

interface FallbackRuleRow {
    id: string;
    source_model: string;
    target_model: string;
    priority: number;
    enabled: number;
    trigger_on_status: string | null;
    max_retries: number | null;
    created_at: number;
}

function toFallbackRule(row: FallbackRuleRow) {
    let triggerOnStatus: number[] | undefined;
    if (row.trigger_on_status) {
        try {
            const parsed: unknown = JSON.parse(row.trigger_on_status);
            if (Array.isArray(parsed)) {
                triggerOnStatus = parsed.filter((n): n is number => typeof n === "number");
            }
        } catch {
            triggerOnStatus = undefined;
        }
    }
    return {
        id: row.id,
        sourceModel: row.source_model,
        targetModel: row.target_model,
        priority: row.priority,
        enabled: !!row.enabled,
        ...(triggerOnStatus !== undefined ? { triggerOnStatus } : {}),
        maxRetries: row.max_retries ?? 1,
        createdAt: row.created_at
    };
}

v1SettingsRoutes.get("/fallbacks", apiKeyAuth, async (c) => {
    const rows = await c.env.DB.prepare(
        "SELECT * FROM fallback_rules ORDER BY priority ASC, created_at ASC"
    ).all<FallbackRuleRow>();
    return c.json({ fallbacks: (rows.results ?? []).map(toFallbackRule) });
});

const FallbackPayloadSchema = z.object({
    id: z.string().min(1).max(100).optional(),
    source_model: z.string().min(1).max(200),
    target_model: z.string().min(1).max(200),
    priority: z.number().int().nonnegative().optional().default(1),
    enabled: z.boolean().optional().default(true),
    trigger_on_status: z.array(z.number().int()).optional(),
    max_retries: z.number().int().nonnegative().optional()
});

function randomFallbackId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return "fb_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

v1SettingsRoutes.post("/fallbacks", requireAdmin, async (c) => {
    const parsed = FallbackPayloadSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
        return apiError(c, 400, "source_model and target_model are required", "invalid_request");
    }
    const d = parsed.data;
    const id = d.id ?? randomFallbackId();
    const now = Date.now();
    const triggerJson = d.trigger_on_status ? JSON.stringify(d.trigger_on_status) : null;
    const maxRetries = d.max_retries ?? 1;
    try {
        await c.env.DB.prepare(
            `INSERT INTO fallback_rules (id, source_model, target_model, priority, enabled,
                                        trigger_on_status, max_retries, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
            .bind(id, d.source_model, d.target_model, d.priority, d.enabled ? 1 : 0, triggerJson, maxRetries, now)
            .run();
    } catch {
        return apiError(c, 409, `Fallback rule "${id}" already exists`, "conflict");
    }
    return c.json(
        {
            fallback: toFallbackRule({
                id,
                source_model: d.source_model,
                target_model: d.target_model,
                priority: d.priority,
                enabled: d.enabled ? 1 : 0,
                trigger_on_status: triggerJson,
                max_retries: maxRetries,
                created_at: now
            })
        },
        201
    );
});

async function updateFallback(c: Context<AppHonoEnv, "/fallbacks/:id">) {
    const db = c.env.DB;
    const id = c.req.param("id");
    const row = await db
        .prepare("SELECT * FROM fallback_rules WHERE id = ?")
        .bind(id)
        .first<FallbackRuleRow>();
    if (!row) return apiError(c, 404, `Fallback rule "${id}" not found`, "not_found");
    const parsed = FallbackPayloadSchema.partial().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
        return apiError(c, 400, "Invalid fallback payload", "invalid_request");
    }
    const d = parsed.data;
    const merged = {
        source_model: d.source_model ?? row.source_model,
        target_model: d.target_model ?? row.target_model,
        priority: d.priority ?? row.priority,
        enabled: d.enabled !== undefined ? (d.enabled ? 1 : 0) : row.enabled,
        trigger_on_status:
            d.trigger_on_status !== undefined ? JSON.stringify(d.trigger_on_status) : row.trigger_on_status,
        max_retries: d.max_retries ?? row.max_retries ?? 1
    };
    await db
        .prepare(
            `UPDATE fallback_rules
             SET source_model = ?, target_model = ?, priority = ?, enabled = ?,
                 trigger_on_status = ?, max_retries = ?
             WHERE id = ?`
        )
        .bind(
            merged.source_model,
            merged.target_model,
            merged.priority,
            merged.enabled,
            merged.trigger_on_status,
            merged.max_retries,
            id
        )
        .run();
    return c.json({ fallback: toFallbackRule({ id, ...merged, created_at: row.created_at }) });
}

// The web app uses PUT for updates; PATCH is kept as an alias for completeness.
v1SettingsRoutes.put("/fallbacks/:id", requireAdmin, updateFallback);
v1SettingsRoutes.patch("/fallbacks/:id", requireAdmin, updateFallback);

v1SettingsRoutes.delete("/fallbacks/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const res = await c.env.DB.prepare("DELETE FROM fallback_rules WHERE id = ?").bind(id).run();
    if ((res.meta.changes ?? 0) === 0) {
        return apiError(c, 404, `Fallback rule "${id}" not found`, "not_found");
    }
    return c.json({ message: `Fallback rule "${id}" deleted successfully` });
});
