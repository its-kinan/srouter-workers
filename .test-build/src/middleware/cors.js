// CORS middleware. Ported from SRouter's apps/api/src/middleware/Cors.ts:
// loopback origins always pass; public origins require SROUTER_CORS_ORIGINS
// (comma-separated). Requests without an Origin header (curl,
// server-to-server) get no CORS headers.
import { cors } from "hono/cors";
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
export function parseAllowedOrigins(envValue) {
    return new Set((envValue ?? "")
        .split(",")
        .map((entry) => entry.trim().replace(/\/+$/, ""))
        .filter(Boolean));
}
/**
 * Returns the origin to echo back, or null when the origin is not allowed.
 * Requests without an Origin header (curl, server-to-server) never need
 * CORS headers, so they also return null.
 */
export function getAllowedOrigin(origin, allowlist) {
    if (!origin)
        return null;
    if (LOOPBACK_ORIGIN.test(origin) || allowlist.has(origin))
        return origin;
    return null;
}
export function createCorsMiddleware(extraOrigins) {
    const allowlist = extraOrigins ?? parseAllowedOrigins();
    return cors({
        origin: (origin) => getAllowedOrigin(origin, allowlist),
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization", "x-api-key", "anthropic-version"],
        exposeHeaders: ["Content-Length", "X-Request-Id", "X-Version"],
        credentials: true
    });
}
