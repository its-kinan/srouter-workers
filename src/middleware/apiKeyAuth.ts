// Virtual API key authentication middleware.
// Mirrors SRouter's ApiKeyAuth: an admin session cookie bypasses key auth;
// otherwise the request must carry a valid virtual key (Authorization: Bearer
// or x-api-key). Keys are looked up by SHA-256 hash — only the hash is stored.
//
// Phase 1 enforces: enabled, credit limit, lifetime token quota.
// Per-key rate limits (rate_limit column) arrive in a later phase.

import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import type { ApiKeyContextRow, AppHonoEnv } from "../hono-env.js";
import { sha256Hex } from "../crypto/password.js";
import { verifyAdminSession, ADMIN_SESSION_COOKIE } from "../routes/admin.js";

export type ApiKeyRow = ApiKeyContextRow;

export async function apiKeyAuth(c: Context<AppHonoEnv>, next: Next) {
    const env = c.env;

    if (await verifyAdminSession(env.DB, getCookie(c, ADMIN_SESSION_COOKIE))) {
        c.set("authType", "admin_session");
        return next();
    }

    const header = c.req.header("Authorization") || c.req.header("authorization") || "";
    const xApiKey = c.req.header("x-api-key") || c.req.header("X-Api-Key") || "";
    let presented: string | null = null;
    if (xApiKey) presented = xApiKey.trim();
    else if (header.toLowerCase().startsWith("bearer ")) presented = header.slice(7).trim();
    else if (header) presented = header.trim();

    if (!presented) {
        return c.json(
            {
                error: {
                    message:
                        "Missing SRouter API Key. Provide it via 'Authorization: Bearer <key>' or 'x-api-key'.",
                    type: "invalid_request_error",
                    code: "missing_api_key"
                }
            },
            401
        );
    }

    const keyHash = await sha256Hex(presented);
    const row = await env.DB.prepare("SELECT * FROM api_keys WHERE key_hash = ?").bind(keyHash).first<ApiKeyRow>();

    if (!row) {
        return c.json(
            {
                error: {
                    message: "Invalid SRouter API Key",
                    type: "invalid_request_error",
                    code: "invalid_api_key"
                }
            },
            401
        );
    }
    if (!row.enabled) {
        return c.json(
            {
                error: {
                    message: "The provided SRouter API Key is disabled",
                    type: "invalid_request_error",
                    code: "api_key_disabled"
                }
            },
            401
        );
    }
    if (row.credit_limit > 0 && row.usage_cost >= row.credit_limit) {
        return c.json(
            {
                error: {
                    message: "Insufficient credit balance. Your credit limit has been reached.",
                    type: "insufficient_quota",
                    code: "insufficient_credit"
                }
            },
            402
        );
    }
    if (row.quota_limit > 0 && row.usage_tokens >= row.quota_limit) {
        return c.json(
            {
                error: {
                    message: "Token quota exceeded. Your lifetime token limit has been reached.",
                    type: "insufficient_quota",
                    code: "quota_exceeded"
                }
            },
            429
        );
    }

    // Model allow-list (SRouter's EnforceModelAccess, folded in for Phase 1)
    if (row.allowed_models) {
        try {
            const allowed = JSON.parse(row.allowed_models) as string[];
            const body = (await c.req.json().catch(() => null)) as { model?: string } | null;
            // Re-attach the parsed body for downstream handlers
            if (body) c.set("parsedBody", body);
            if (body?.model && !allowed.some((m) => body.model === m || body.model!.startsWith(m + "/"))) {
                return c.json(
                    {
                        error: {
                            message: `Model "${body.model}" is not allowed for this API key.`,
                            type: "invalid_request_error",
                            code: "model_not_allowed"
                        }
                    },
                    403
                );
            }
        } catch {
            // malformed allow-list: fail open to key auth, admin can fix via dashboard
        }
    }

    c.set("authType", "api_key");
    c.set("apiKeyRow", row);
    return next();
}
