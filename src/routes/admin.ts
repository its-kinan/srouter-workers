// Admin auth + account management (Phase 1).
//
// Follows SRouter's first-run setup flow:
//   GET  /api/admin/status  -> { initialized: bool }  (public)
//   POST /api/admin/setup   -> { password } creates the singleton admin when
//                              none exists; afterwards 409
//   POST /api/admin/login   -> sets session cookie; 401 on bad password
//   POST /api/admin/logout  -> clears cookie
//
// Passwords use PBKDF2-SHA256 (WebCrypto). SRouter used scryptSync, which has
// no WebCrypto equivalent, so existing hashes are not portable — the admin
// resets their password on first deploy via /setup.
//
// Sessions: random 32-byte token in an HttpOnly SameSite=Lax Secure cookie;
// only the SHA-256 hash is stored in D1 (admin_sessions), 24h expiry.
// Cookie-authenticated mutations additionally require an Origin check.

import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { Env } from "../env.js";
import type { AppHonoEnv } from "../hono-env.js";
import { hashPassword, sha256Hex, verifyPassword } from "../crypto/password.js";

export const ADMIN_SESSION_COOKIE = "srouter_admin_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export const adminRoutes = new Hono<AppHonoEnv>();

async function hasAdminAccount(db: D1Database): Promise<boolean> {
    const row = await db
        .prepare("SELECT id FROM admin_account WHERE id = 1")
        .first<{ id: number }>();
    return !!row;
}

/** Verify a session cookie value. Exported for the apiKeyAuth middleware. */
export async function verifyAdminSession(
    db: D1Database,
    cookieValue: string | undefined
): Promise<boolean> {
    if (!cookieValue) return false;
    const tokenHash = await sha256Hex(cookieValue);
    const row = await db
        .prepare("SELECT expires_at FROM admin_sessions WHERE token_hash = ?")
        .bind(tokenHash)
        .first<{ expires_at: number }>();
    if (!row) return false;
    if (row.expires_at < Date.now()) {
        await db
            .prepare("DELETE FROM admin_sessions WHERE token_hash = ?")
            .bind(tokenHash)
            .run()
            .catch(() => {});
        return false;
    }
    return true;
}

function issueSessionCookie(c: Parameters<typeof setCookie>[0], token: string, env: Env): void {
    setCookie(c, ADMIN_SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "Lax",
        secure: env.ENVIRONMENT === "production",
        path: "/",
        maxAge: SESSION_TTL_MS / 1000
    });
}

/** CSRF guard for cookie-authenticated admin mutations. */
async function requireAdmin(
    c: Context<AppHonoEnv>
): Promise<Response | null> {
    const env = c.env;
    if (!(await verifyAdminSession(env.DB, getCookie(c, ADMIN_SESSION_COOKIE)))) {
        return c.json({ error: "Unauthorized" }, 401);
    }
    const origin = c.req.header("Origin");
    if (origin) {
        const host = new URL(c.req.url).host;
        try {
            if (new URL(origin).host !== host) {
                return c.json({ error: "Origin mismatch" }, 403);
            }
        } catch {
            return c.json({ error: "Invalid Origin" }, 403);
        }
    }
    return null;
}

adminRoutes.get("/admin/status", async (c) => {
    return c.json({ initialized: await hasAdminAccount(c.env.DB) });
});

const SetupSchema = z.object({
    password: z.string().min(8).max(256)
});

adminRoutes.post("/admin/setup", async (c) => {
    const env = c.env;
    if (await hasAdminAccount(env.DB)) {
        return c.json({ error: "Admin account already exists" }, 409);
    }
    const parsed = SetupSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
        return c.json({ error: "Password must be 8-256 characters" }, 400);
    }
    const passwordHash = await hashPassword(parsed.data.password);
    const now = Date.now();
    await env.DB.prepare(
        "INSERT INTO admin_account (id, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?)"
    )
        .bind(passwordHash, now, now)
        .run();
    const token = [...crypto.getRandomValues(new Uint8Array(32))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    const tokenHash = await sha256Hex(token);
    await env.DB.prepare(
        "INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)"
    )
        .bind(tokenHash, now, now + SESSION_TTL_MS)
        .run();
    issueSessionCookie(c, token, env);
    return c.json({ ok: true });
});

adminRoutes.post("/admin/login", async (c) => {
    const env = c.env;
    const row = await env.DB.prepare(
        "SELECT password_hash FROM admin_account WHERE id = 1"
    ).first<{ password_hash: string }>();
    if (!row) {
        return c.json({ error: "Admin account not initialized" }, 404);
    }
    const parsed = z
        .object({ password: z.string() })
        .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !(await verifyPassword(parsed.data.password, row.password_hash))) {
        return c.json({ error: "Invalid password" }, 401);
    }
    const token = [...crypto.getRandomValues(new Uint8Array(32))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    const now = Date.now();
    await env.DB.prepare(
        "INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)"
    )
        .bind(await sha256Hex(token), now, now + SESSION_TTL_MS)
        .run();
    issueSessionCookie(c, token, env);
    return c.json({ ok: true });
});

adminRoutes.post("/admin/logout", async (c) => {
    const env = c.env;
    const cookieValue = getCookie(c, ADMIN_SESSION_COOKIE);
    if (cookieValue) {
        await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?")
            .bind(await sha256Hex(cookieValue))
            .run()
            .catch(() => {});
    }
    deleteCookie(c, ADMIN_SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
});

// --- Phase 1 admin data endpoints (status summary for the dashboard shell) ---

adminRoutes.get("/admin/summary", async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;
    const env = c.env;
    const [providers, keys, logs] = await Promise.all([
        env.DB.prepare(
            "SELECT id, provider_id, name, alias, enabled FROM providers ORDER BY created_at DESC"
        ).all(),
        env.DB.prepare(
            "SELECT id, name, key_prefix, enabled, credit_limit, quota_limit, usage_tokens, usage_cost FROM api_keys ORDER BY created_at DESC"
        ).all(),
        env.DB.prepare(
            "SELECT provider_id, model, status_code, total_tokens, latency_ms, created_at FROM request_logs ORDER BY created_at DESC LIMIT 50"
        ).all()
    ]);
    let routerHealth: unknown = null;
    try {
        const res = await env.ROUTER_STATE.getByName("router").fetch(
            new Request("https://do/health")
        );
        routerHealth = await res.json();
    } catch {
        routerHealth = null;
    }
    return c.json({
        providers: providers.results ?? [],
        apiKeys: keys.results ?? [],
        recentLogs: logs.results ?? [],
        routerHealth
    });
});

// --- Dashboard management endpoints (SRouter-style admin UI) ---

adminRoutes.get("/admin/logs", async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "100", 10) || 100, 1), 500);
    const rows = await c.env.DB.prepare(
        `SELECT id, api_key_id, provider_id, account_id, model, resolved_model,
                prompt_tokens, completion_tokens, total_tokens, status_code,
                latency_ms, estimated_cost, fallback_occurred, created_at
         FROM request_logs ORDER BY created_at DESC LIMIT ?`
    )
        .bind(limit)
        .all();
    const total = await c.env.DB.prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(total_tokens),0) AS t, COALESCE(SUM(estimated_cost),0) AS cost FROM request_logs"
    ).first<{ n: number; t: number; cost: number }>();
    return c.json({ logs: rows.results ?? [], total: total ?? { n: 0, t: 0, cost: 0 } });
});

const ProviderToggleSchema = z.object({ enabled: z.boolean() });

adminRoutes.patch("/admin/providers/:id", async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;
    const parsed = ProviderToggleSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Body must be { enabled: boolean }" }, 400);
    const res = await c.env.DB.prepare("UPDATE providers SET enabled = ? WHERE id = ?")
        .bind(parsed.data.enabled ? 1 : 0, c.req.param("id"))
        .run();
    if ((res.meta.changes ?? 0) === 0) return c.json({ error: "Provider not found" }, 404);
    return c.json({ ok: true });
});

const KeyCreateSchema = z.object({
    name: z.string().min(1).max(100),
    credit_limit: z.number().nonnegative().optional().default(0),
    quota_limit: z.number().int().nonnegative().optional().default(0)
});

function randomKeySecret(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
    return "sk-sr-" + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

adminRoutes.post("/admin/keys", async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;
    const parsed = KeyCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Body must be { name, credit_limit?, quota_limit? }" }, 400);
    const secret = randomKeySecret();
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
        `INSERT INTO api_keys (id, key_hash, key_prefix, name, enabled, credit_limit, quota_limit, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
    )
        .bind(id, await sha256Hex(secret), secret.slice(0, 12), parsed.data.name, parsed.data.credit_limit, parsed.data.quota_limit, Date.now())
        .run();
    // The plaintext secret is returned exactly once; only its hash is stored.
    return c.json({ ok: true, id, key: secret }, 201);
});

adminRoutes.delete("/admin/keys/:id", async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;
    const res = await c.env.DB.prepare("DELETE FROM api_keys WHERE id = ?")
        .bind(c.req.param("id"))
        .run();
    if ((res.meta.changes ?? 0) === 0) return c.json({ error: "Key not found" }, 404);
    return c.json({ ok: true });
});

const KeyToggleSchema = z.object({ enabled: z.boolean() });

adminRoutes.patch("/admin/keys/:id", async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;
    const parsed = KeyToggleSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Body must be { enabled: boolean }" }, 400);
    const res = await c.env.DB.prepare("UPDATE api_keys SET enabled = ? WHERE id = ?")
        .bind(parsed.data.enabled ? 1 : 0, c.req.param("id"))
        .run();
    if ((res.meta.changes ?? 0) === 0) return c.json({ error: "Key not found" }, 404);
    return c.json({ ok: true });
});
