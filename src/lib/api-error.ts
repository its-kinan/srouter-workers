// OpenAI-style error responses, matching SRouter's conventions:
//   { error: { message, type, code? } }
// where `type` derives from the HTTP status.

import type { Context } from "hono";
import type { AppHonoEnv } from "../hono-env.js";

function typeForStatus(status: number): string {
    if (status === 401) return "authentication_error";
    if (status === 403) return "permission_error";
    if (status === 429) return "rate_limit_error";
    return "invalid_request_error";
}

export function apiError(
    c: Context<AppHonoEnv>,
    status: 400 | 401 | 402 | 403 | 404 | 409 | 422 | 429 | 500 | 501,
    message: string,
    code?: string
) {
    return c.json(
        {
            error: {
                message,
                type: typeForStatus(status),
                ...(code ? { code } : {})
            }
        },
        status
    );
}
