// Admin-only guard. Mirrors SRouter's RequireAdmin: a valid admin session
// cookie is required. Rejects with 401 (never 403) — authorization is binary.

import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import type { AppHonoEnv } from "../hono-env.js";
import { verifyAdminSession, ADMIN_SESSION_COOKIE } from "../routes/admin.js";
import { apiError } from "../lib/api-error.js";

export async function requireAdmin(c: Context<AppHonoEnv>, next: Next) {
    const ok = await verifyAdminSession(c.env.DB, getCookie(c, ADMIN_SESSION_COOKIE));
    if (!ok) {
        return apiError(c, 401, "Admin authentication is required", "authentication_required");
    }
    c.set("authType", "admin_session");
    return next();
}
