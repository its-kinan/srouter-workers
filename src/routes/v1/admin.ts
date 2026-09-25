// SRouter-compatible admin auth endpoints (dashboard surface).
// Mounted at /v1/admin.
//
//   GET  /status            -> { setupRequired, authenticated } (public, always 200)
//   POST /setup             -> { password, confirmation } -> 201 { authenticated: true } + cookie
//   POST /login             -> { password } -> 200 { authenticated: true } + cookie
//   POST /change-password   -> { current_password, new_password, confirmation }
//
// Passwords use PBKDF2-SHA256 (WebCrypto); SRouter used scrypt, so existing
// hashes are not portable. Sessions: 32-byte base64url token in an HttpOnly
// SameSite=Lax cookie; only the SHA-256 hex is stored in D1 (admin_sessions),
// 7-day TTL.
//
// Workers divergence: the original rejects setup from non-loopback callers
// (403 setup_local_only). A public Worker has no loopback, so setup is
// first-claim-wins — whoever claims it first owns the admin account.

import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { Env } from "../../env.js";
import type { AppHonoEnv } from "../../hono-env.js";
import { hashPassword, sha256Hex, verifyPassword } from "../../crypto/password.js";
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from "../admin.js";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { apiError } from "../../lib/api-error.js";

export const v1AdminRoutes = new Hono<AppHonoEnv>();

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function randomToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createSession(db: D1Database): Promise<string> {
    const token = randomToken();
    const now = Date.now();
    await db
        .prepare("INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
        .bind(await sha256Hex(token), now, now + SESSION_TTL_MS)
        .run();
    return token;
}

function setSessionCookie(c: Context<AppHonoEnv>, token: string, env: Env): void {
    setCookie(c, ADMIN_SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "Lax",
        secure: env.ENVIRONMENT === "production",
        path: "/",
        maxAge: SESSION_TTL_MS / 1000
    });
}

v1AdminRoutes.get("/status", async (c) => {
    const db = c.env.DB;
    const account = await db
        .prepare("SELECT id FROM admin_account WHERE id = 1")
        .first<{ id: number }>();
    return c.json({
        setupRequired: !account,
        authenticated: await verifyAdminSession(db, getCookie(c, ADMIN_SESSION_COOKIE))
    });
});

const SetupSchema = z.object({
    password: z.string().min(1).max(128),
    confirmation: z.string().min(1).max(128)
});

v1AdminRoutes.post("/setup", async (c) => {
    const env = c.env;
    const existing = await env.DB.prepare("SELECT id FROM admin_account WHERE id = 1").first();
    if (existing) {
        return apiError(c, 409, "Admin setup has already been completed", "setup_already_complete");
    }
    const parsed = SetupSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
        return apiError(c, 400, "Password and confirmation are required (max 128 characters)", "invalid_password");
    }
    if (parsed.data.password !== parsed.data.confirmation) {
        return apiError(c, 400, "Password and confirmation do not match", "password_mismatch");
    }
    const now = Date.now();
    try {
        await env.DB.prepare(
            "INSERT INTO admin_account (id, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?)"
        )
            .bind(await hashPassword(parsed.data.password), now, now)
            .run();
    } catch {
        // Lost a race with a concurrent setup request.
        return apiError(c, 409, "Admin setup has already been completed", "setup_already_complete");
    }
    setSessionCookie(c, await createSession(env.DB), env);
    return c.json({ authenticated: true }, 201);
});

// --- login rate limiting (per-isolate in-memory map, like the original's per-process map) ---

const loginAttempts = new Map<string, { count: number; blockedUntil: number }>();
const MAX_LOGIN_FAILURES = 5;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

function clientIp(c: Context<AppHonoEnv>): string {
    return (
        c.req.header("CF-Connecting-IP") ??
        c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
        "unknown"
    );
}

v1AdminRoutes.post("/login", async (c) => {
    const env = c.env;
    const ip = clientIp(c);
    const now = Date.now();
    const attempt = loginAttempts.get(ip);
    if (attempt && attempt.blockedUntil > now) {
        return apiError(c, 429, "Too many failed login attempts. Try again later.", "login_rate_limited");
    }
    // Anti-oracle: schema failure and wrong password produce the identical 401.
    const parsed = z.object({ password: z.string() }).safeParse(await c.req.json().catch(() => null));
    const row = await env.DB.prepare("SELECT password_hash FROM admin_account WHERE id = 1").first<{
        password_hash: string;
    }>();
    const ok =
        !!parsed.success && !!row && (await verifyPassword(parsed.data.password, row.password_hash));
    if (!ok) {
        let entry = loginAttempts.get(ip);
        if (!entry || entry.blockedUntil <= now) entry = { count: 0, blockedUntil: 0 };
        entry.count += 1;
        if (entry.count >= MAX_LOGIN_FAILURES) entry.blockedUntil = now + LOGIN_BLOCK_MS;
        loginAttempts.set(ip, entry);
        return apiError(c, 401, "Invalid credentials", "invalid_credentials");
    }
    loginAttempts.delete(ip);
    setSessionCookie(c, await createSession(env.DB), env);
    return c.json({ authenticated: true });
});

const ChangePasswordSchema = z.object({
    current_password: z.string().min(1),
    new_password: z.string().min(1).max(128),
    confirmation: z.string().min(1).max(128)
});

v1AdminRoutes.post("/change-password", requireAdmin, async (c) => {
    const env = c.env;
    const parsed = ChangePasswordSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
        return apiError(
            c,
            400,
            "current_password, new_password and confirmation are required",
            "invalid_password"
        );
    }
    const { current_password, new_password, confirmation } = parsed.data;
    if (new_password !== confirmation) {
        return apiError(c, 400, "New password and confirmation do not match", "password_mismatch");
    }
    const row = await env.DB.prepare("SELECT password_hash FROM admin_account WHERE id = 1").first<{
        password_hash: string;
    }>();
    if (!row || !(await verifyPassword(current_password, row.password_hash))) {
        return apiError(c, 401, "Current password is incorrect", "invalid_credentials");
    }
    const updated = await env.DB.prepare(
        "UPDATE admin_account SET password_hash = ?, updated_at = ? WHERE id = 1"
    )
        .bind(await hashPassword(new_password), Date.now())
        .run();
    if ((updated.meta.changes ?? 0) === 0) {
        return apiError(c, 500, "Failed to update password", "password_update_failed");
    }
    // Other sessions stay valid, matching the original.
    return c.json({ message: "Admin password updated successfully" });
});

v1AdminRoutes.post("/logout", async (c) => {
    // No web call site (the dashboard has no logout UI), but the original
    // exposes it: revoke this session and clear the cookie.
    const cookieValue = getCookie(c, ADMIN_SESSION_COOKIE);
    if (!(await verifyAdminSession(c.env.DB, cookieValue))) {
        return apiError(c, 401, "Not authenticated", "authentication_required");
    }
    await c.env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?")
        .bind(await sha256Hex(cookieValue!))
        .run()
        .catch(() => {});
    deleteCookie(c, ADMIN_SESSION_COOKIE, { path: "/" });
    return new Response(null, { status: 204 });
});
