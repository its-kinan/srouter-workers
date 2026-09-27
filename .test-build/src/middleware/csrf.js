// CSRF defense for cookie-based admin mutations. Ported from SRouter's
// apps/api/src/middleware/CsrfOrigin.ts: SameSite=Lax already blocks
// cross-site POSTs from modern browsers; this adds an explicit Origin/Referer
// check for same-site cross-subdomain requests. Requests without an admin
// session cookie (plain API-key traffic) and non-browser clients (no Origin)
// pass through untouched.
import { getCookie } from "hono/cookie";
import { ADMIN_SESSION_COOKIE } from "../routes/admin.js";
import { apiError } from "../lib/api-error.js";
import { getAllowedOrigin } from "./cors.js";
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export function createCsrfOriginGuard(allowlist) {
    return async (c, next) => {
        if (!UNSAFE_METHODS.has(c.req.method))
            return next();
        if (!getCookie(c, ADMIN_SESSION_COOKIE))
            return next();
        const origin = c.req.header("origin") || c.req.header("referer");
        if (!origin)
            return next();
        let originUrl = null;
        try {
            originUrl = new URL(origin);
        }
        catch {
            originUrl = null;
        }
        if (!originUrl) {
            return apiError(c, 403, "Cross-origin admin mutation is not allowed", "csrf_origin_rejected");
        }
        // Same-origin mutations are inherently CSRF-safe (the browser decides
        // the Origin header; an attacker page cannot forge its own origin).
        const requestHost = new URL(c.req.url).host || c.req.header("host");
        if (originUrl.host === requestHost)
            return next();
        if (!getAllowedOrigin(originUrl.origin, allowlist)) {
            return apiError(c, 403, "Cross-origin admin mutation is not allowed", "csrf_origin_rejected");
        }
        return next();
    };
}
