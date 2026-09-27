// Virtual API keys (SRouter-compatible dashboard surface). Mounted at /v1/keys.
// All endpoints require an admin session.
//
// Security divergence from the original: SRouter stored key secrets in
// plaintext and returned them on every list call. This port stores only the
// SHA-256 hash — the plaintext secret is returned exactly once, in the POST
// response. List/update responses carry key: "".

import { Hono } from "hono";
import { z } from "zod";
import type { AppHonoEnv } from "../../hono-env.js";
import { sha256Hex } from "../../crypto/password.js";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { apiError } from "../../lib/api-error.js";

export const v1KeysRoutes = new Hono<AppHonoEnv>();

interface ApiKeyRow {
    id: string;
    name: string;
    enabled: number;
    rate_limit: number | null;
    quota_limit: number | null;
    usage_tokens: number | null;
    credit_limit: number | null;
    usage_cost: number | null;
    allowed_models: string | null;
    created_at: number;
}

const KEY_COLUMNS = `id, name, enabled, rate_limit, quota_limit, usage_tokens,
    credit_limit, usage_cost, allowed_models, created_at`;

function toApiKey(row: ApiKeyRow, key = "") {
    let allowedModels: string[] | null = null;
    if (row.allowed_models) {
        try {
            const parsed: unknown = JSON.parse(row.allowed_models);
            if (Array.isArray(parsed)) allowedModels = parsed.filter((m): m is string => typeof m === "string");
        } catch {
            allowedModels = null;
        }
    }
    return {
        id: row.id,
        key,
        name: row.name,
        enabled: !!row.enabled,
        rate_limit: row.rate_limit ?? 0,
        quota_limit: row.quota_limit ?? 0,
        usage_tokens: row.usage_tokens ?? 0,
        credit_limit: row.credit_limit ?? 0,
        usage_cost: row.usage_cost ?? 0,
        allowed_models: allowedModels,
        created_at: row.created_at
    };
}

v1KeysRoutes.get("/", requireAdmin, async (c) => {
    const rows = await c.env.DB.prepare(
        `SELECT ${KEY_COLUMNS} FROM api_keys ORDER BY created_at DESC`
    ).all<ApiKeyRow>();
    return c.json({ object: "list", data: (rows.results ?? []).map((r) => toApiKey(r)) });
});

const KeyPayloadSchema = z.object({
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().optional().default(true),
    rate_limit: z.number().int().nonnegative().optional(),
    quota_limit: z.number().int().nonnegative().optional(),
    credit_limit: z.number().nonnegative().optional(),
    allowed_models: z.array(z.string()).nullable().optional()
});

function randomKeySecret(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return "sr-live-" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

v1KeysRoutes.post("/", requireAdmin, async (c) => {
    const parsed = KeyPayloadSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
        return apiError(c, 400, "Invalid key payload: name is required", "invalid_request");
    }
    const { name, enabled, rate_limit, quota_limit, credit_limit, allowed_models } = parsed.data;
    const secret = randomKeySecret();
    const id = `key_${crypto.randomUUID()}`;
    const now = Date.now();
    const allowedJson = allowed_models ? JSON.stringify(allowed_models) : null;
    await c.env.DB.prepare(
        `INSERT INTO api_keys (id, key_hash, key_prefix, name, enabled, rate_limit,
                               quota_limit, usage_tokens, credit_limit, usage_cost,
                               allowed_models, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`
    )
        .bind(
            id,
            await sha256Hex(secret),
            secret.slice(0, 12),
            name,
            enabled ? 1 : 0,
            rate_limit ?? 0,
            quota_limit ?? 0,
            credit_limit ?? 0,
            allowedJson,
            now
        )
        .run();
    return c.json(
        toApiKey(
            {
                id,
                name,
                enabled: enabled ? 1 : 0,
                rate_limit: rate_limit ?? 0,
                quota_limit: quota_limit ?? 0,
                usage_tokens: 0,
                credit_limit: credit_limit ?? 0,
                usage_cost: 0,
                allowed_models: allowedJson,
                created_at: now
            },
            secret
        ),
        201
    );
});

v1KeysRoutes.patch("/:id", requireAdmin, async (c) => {
    const db = c.env.DB;
    const id = c.req.param("id");
    const row = await db
        .prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = ?`)
        .bind(id)
        .first<ApiKeyRow>();
    if (!row) return apiError(c, 404, "API key not found", "not_found");
    const parsed = KeyPayloadSchema.partial().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
        return apiError(c, 400, "Invalid key payload", "invalid_request");
    }
    const d = parsed.data;
    const updates: string[] = [];
    const binds: unknown[] = [];
    if (d.name !== undefined) {
        updates.push("name = ?");
        binds.push(d.name);
    }
    if (d.enabled !== undefined) {
        updates.push("enabled = ?");
        binds.push(d.enabled ? 1 : 0);
    }
    if (d.rate_limit !== undefined) {
        updates.push("rate_limit = ?");
        binds.push(d.rate_limit);
    }
    if (d.quota_limit !== undefined) {
        updates.push("quota_limit = ?");
        binds.push(d.quota_limit);
    }
    if (d.credit_limit !== undefined) {
        updates.push("credit_limit = ?");
        binds.push(d.credit_limit);
    }
    if (d.allowed_models !== undefined) {
        // [] / null clears the model restriction.
        updates.push("allowed_models = ?");
        binds.push(d.allowed_models ? JSON.stringify(d.allowed_models) : null);
    }
    if (updates.length > 0) {
        await db
            .prepare(`UPDATE api_keys SET ${updates.join(", ")} WHERE id = ?`)
            .bind(...binds, id)
            .run();
    }
    const updated = await db
        .prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = ?`)
        .bind(id)
        .first<ApiKeyRow>();
    return c.json(toApiKey(updated!));
});

v1KeysRoutes.delete("/:id", requireAdmin, async (c) => {
    const res = await c.env.DB.prepare("DELETE FROM api_keys WHERE id = ?")
        .bind(c.req.param("id"))
        .run();
    if ((res.meta.changes ?? 0) === 0) return apiError(c, 404, "API key not found", "not_found");
    return c.json({ message: "API Key revoked and deleted successfully" });
});
