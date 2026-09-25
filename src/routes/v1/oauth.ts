// OAuth routes for the Cloudflare Workers port (mounted at /v1/auth).
//
// Only direct token import is portable here:
//   POST /v1/auth/:provider/token
// The credential is stored as an AES-GCM envelope (secrets_enc) — never
// plaintext — and a providers row is upserted, mirroring the original's
// token-import path (which stored plaintext).
//
// All interactive OAuth flows (PKCE login/callback, device flows) need either
// a localhost OAuth listener or provider-specific device clients and are not
// available on Workers; they return 501 with a pointer to token import.

import { Hono, type Context } from "hono";
import type { AppHonoEnv } from "../../hono-env.js";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { apiError } from "../../lib/api-error.js";
import { encryptSecretsObject } from "../../crypto/secretbox.js";

export const oauthRoutes = new Hono<AppHonoEnv>();

/** Providers whose credentials can be imported directly as a token. */
const TOKEN_IMPORT_PROVIDERS = new Set([
    "openai",
    "antigravity",
    "claude",
    "cline",
    "codebuddy",
    "codebuddy-cn",
    "qoder",
    "commandcode",
    "anthropic",
    "atria",
    "tokenrouter"
]);

/** Providers whose token is stored as an api_key rather than an access_token. */
const API_KEY_GROUP = new Set(["commandcode", "anthropic", "atria", "tokenrouter"]);

function oauthNotSupported(c: Context<AppHonoEnv>, flow: string) {
    return apiError(
        c,
        501,
        `OAuth ${flow} is not supported on the Cloudflare Workers port. Use token import (POST /v1/auth/<provider>/token) instead.`,
        "oauth_not_supported"
    );
}

/**
 * Mirror of the dashboard's authProviderIdOf() (apps/web/src/utils/provider-oauth.utils.ts):
 * dashboard provider ids -> auth ids, e.g. openai_codex -> openai, grok-cli -> grok.
 */
function authProviderIdOf(providerId: string): string {
    const id = providerId.toLowerCase();
    if (id === "codebuddy-cn") return "codebuddy-cn";
    return id.split("_")[0].split("-")[0];
}

function protocolFor(provider: string): string {
    if (provider === "claude" || provider === "anthropic") return "anthropic";
    return "openai";
}

function displayName(provider: string): string {
    const names: Record<string, string> = {
        openai: "OpenAI Codex",
        antigravity: "Antigravity",
        claude: "Claude",
        cline: "Cline",
        codebuddy: "CodeBuddy",
        "codebuddy-cn": "CodeBuddy CN",
        qoder: "Qoder",
        commandcode: "CommandCode",
        anthropic: "Anthropic",
        atria: "Atria",
        tokenrouter: "TokenRouter"
    };
    return names[provider] ?? provider;
}

// ---------------------------------------------------------------------------
// Interactive OAuth flows — not portable to Workers (501).
// Registered before the parametric /:provider/token route.
// ---------------------------------------------------------------------------

const PKCE_PROVIDERS = ["openai", "antigravity", "claude", "qoder"];
for (const p of PKCE_PROVIDERS) {
    oauthRoutes.get(`/${p}/login`, requireAdmin, (c) => oauthNotSupported(c, `PKCE login for ${p}`));
    oauthRoutes.get(`/${p}/callback`, requireAdmin, (c) => oauthNotSupported(c, `OAuth callback for ${p}`));
    oauthRoutes.post(`/${p}/callback`, requireAdmin, (c) => oauthNotSupported(c, `OAuth callback for ${p}`));
}

const DEVICE_PROVIDERS = ["cline", "codebuddy", "codebuddy-cn"];
for (const p of DEVICE_PROVIDERS) {
    oauthRoutes.get(`/${p}/device`, requireAdmin, (c) => oauthNotSupported(c, `device flow for ${p}`));
    oauthRoutes.get(`/${p}/poll`, requireAdmin, (c) => oauthNotSupported(c, `device polling for ${p}`));
    oauthRoutes.post(`/${p}/poll`, requireAdmin, (c) => oauthNotSupported(c, `device polling for ${p}`));
}

// Qoder's device-style poll endpoints.
oauthRoutes.get("/qoder/poll", requireAdmin, (c) => oauthNotSupported(c, "device polling for qoder"));
oauthRoutes.post("/qoder/poll", requireAdmin, (c) => oauthNotSupported(c, "device polling for qoder"));

// ---------------------------------------------------------------------------
// POST /v1/auth/:provider/token — direct token import (portable).
// ---------------------------------------------------------------------------

oauthRoutes.post("/:provider/token", requireAdmin, async (c) => {
    const raw = c.req.param("provider") ?? "";
    const provider = authProviderIdOf(raw);

    if (!TOKEN_IMPORT_PROVIDERS.has(provider)) {
        return oauthNotSupported(c, `token import for provider "${raw}"`);
    }

    let body: Record<string, unknown>;
    try {
        body = (await c.req.json()) as Record<string, unknown>;
    } catch {
        body = {};
    }

    const accessToken = (body.access_token ?? body.accessToken) as string | undefined;
    const refreshToken = (body.refresh_token ?? body.refreshToken) as string | undefined;
    const baseUrl = body.base_url as string | undefined;
    const name = typeof body.name === "string" ? body.name.trim() : "";

    if (!accessToken || typeof accessToken !== "string" || !accessToken.trim()) {
        return apiError(c, 400, "access_token is required", "missing_access_token");
    }

    const asApiKey = API_KEY_GROUP.has(provider);
    const secrets: Record<string, string> = asApiKey
        ? { api_key: accessToken.trim() }
        : { access_token: accessToken.trim() };
    if (refreshToken && typeof refreshToken === "string" && refreshToken.trim()) {
        secrets.refresh_token = refreshToken.trim();
    }

    const env = c.env;
    const secretsEnc = await encryptSecretsObject(secrets, env.MASTER_KEY);

    const id = `${provider}_${Date.now()}`;
    const now = Date.now();
    const category = asApiKey ? "api_key" : "oauth";
    const protocol = protocolFor(provider);
    const providerName = name || `${displayName(provider)} (token import)`;

    await env.DB.prepare(
        `INSERT INTO providers
             (id, provider_id, name, category, protocol, base_url, secrets_enc, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
    )
        .bind(id, provider, providerName, category, protocol, baseUrl ?? null, secretsEnc, now)
        .run();

    return c.json(
        {
            success: true,
            message: `${displayName(provider)} access token imported and stored encrypted.`,
            provider: {
                id,
                providerId: provider,
                name: providerName,
                category,
                protocol,
                base_url: baseUrl ?? null,
                enabled: true,
                createdAt: now
            }
        },
        201
    );
});
