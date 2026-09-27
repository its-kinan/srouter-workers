// Shared Hono environment typing (bindings + context variables).
import type { Env } from "./env.js";

export interface ApiKeyContextRow {
    id: string;
    name: string;
    enabled: number;
    rate_limit: number;
    quota_limit: number;
    usage_tokens: number;
    credit_limit: number;
    usage_cost: number;
    allowed_models: string | null;
}

export interface AppHonoEnv {
    Bindings: Env;
    Variables: {
        authType?: "admin_session" | "api_key";
        apiKeyRow?: ApiKeyContextRow;
        parsedBody?: unknown;
    };
}
