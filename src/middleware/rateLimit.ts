// Fixed-window per-key rate limiter, ported 1:1 from SRouter's
// apps/api/src/middleware/RateLimit.ts.
//
// `rate_limit` on the API key row is requests per minute; 0 (default) = unlimited.
// Keyed by API key id + client address. Must run after apiKeyAuth so `apiKeyRow`
// is populated.
//
// Note: on Workers this is per-isolate in-memory (like the original's single
// process), so it's approximate under high concurrency — same tradeoff as upstream.

import type { Context, Next } from "hono";
import type { ApiKeyRow } from "./apiKeyAuth.js";

const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;

interface WindowEntry {
    count: number;
    resetAt: number;
}

const windows = new Map<string, WindowEntry>();

function getClientAddress(c: Context): string {
    return (
        c.req.header("cf-connecting-ip") ||
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
        "unknown"
    );
}

export async function rateLimit(c: Context, next: Next) {
    const row = c.get("apiKeyRow") as ApiKeyRow | undefined;
    const limit = row?.rate_limit ?? 0;
    // Admin sessions and unlimited keys bypass.
    if (!row || limit <= 0) return next();

    const now = Date.now();
    if (windows.size > MAX_TRACKED_KEYS) {
        for (const [k, e] of windows) {
            if (e.resetAt <= now) windows.delete(k);
        }
    }

    const windowKey = `${row.id}:${getClientAddress(c)}`;
    const entry = windows.get(windowKey);

    if (!entry || entry.resetAt <= now) {
        windows.set(windowKey, { count: 1, resetAt: now + WINDOW_MS });
        return next();
    }

    entry.count += 1;
    if (entry.count > limit) {
        const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        c.header("Retry-After", String(retryAfterSec));
        return c.json(
            {
                error: {
                    message: `Rate limit exceeded: this API key allows ${limit} request${limit === 1 ? "" : "s"} per minute.`,
                    type: "rate_limit_error",
                    code: "rate_limit_exceeded"
                }
            },
            429
        );
    }

    return next();
}
