// srouter-workers — Cloudflare Workers port of SRouter.
// OpenAI-compatible multi-account gateway: Worker + D1 + Durable Object.
//
// Routes:
//   GET  /health                  liveness (public)
//   GET  /v1/models               aggregated model list (virtual key or admin session)
//   POST /v1/chat/completions     chat completions, SSE or JSON (virtual key or admin session)
//   /v1/admin/*                   SRouter dashboard: setup/login/status (AdminAuthGate)
//   /v1/admin/database/*          DB export/import (export honest, import unsupported)
//   /v1/auth/*                    OAuth device flows + direct token import
//   /v1/providers/*              provider catalog, connections, verify, round-robin
//   /v1/keys/*                    virtual API keys (hash-only at rest)
//   /v1/logs/*                    request logs, stats, analytics, SSE events
//   /v1/settings/*                settings + fallback combos
//   /v1/favorites/*               favorite models
//   /v1/quota                     usage-derived quota view
//   /v1/pricing/models            models.dev pricing dataset
//   /v1/tunnel/*                  honest stubs (tunnels are not portable to Workers)
//   /api/admin/*                  Phase 1 admin surface (legacy shell)
//   /*                            real SRouter React dashboard (static assets + SPA fallback)

import { Hono } from "hono";
import type { Env } from "./env.js";
import type { AppHonoEnv } from "./hono-env.js";
import { chatRoutes } from "./routes/chat.js";
import { modelsRoutes } from "./routes/models.js";
import { adminRoutes } from "./routes/admin.js";
import { v1AdminRoutes } from "./routes/v1/admin.js";
import { v1KeysRoutes } from "./routes/v1/keys.js";
import { v1SettingsRoutes } from "./routes/v1/settings.js";
import { v1FavoritesRoutes } from "./routes/v1/favorites.js";
import { logsRoutes } from "./routes/v1/logs.js";
import { providersRoutes } from "./routes/v1/providers.js";
import { quotaRoutes } from "./routes/v1/quota.js";
import { pricingRoutes } from "./routes/v1/pricing.js";
import { oauthRoutes } from "./routes/v1/oauth.js";
import { tunnelRoutes } from "./routes/v1/tunnel.js";
import { databaseRoutes } from "./routes/v1/database.js";
import { RouterState } from "./router/durable.js";
import { decryptAccount, type ProviderRow } from "./providers/registry.js";
import { refreshOAuthTokens } from "./providers/oauth-refresh.js";
import { DASHBOARD_HTML } from "./dashboard-html.js";
import { encryptSecretsObject } from "./crypto/secretbox.js";

const app = new Hono<AppHonoEnv>();

app.get("/health", (c) => c.json({ ok: true, service: "srouter-workers" }));

app.route("/v1", chatRoutes);
app.route("/v1", modelsRoutes);
// Real SRouter dashboard API surface (Phase 2). Mount order matters only
// relative to the catch-alls inside each module; the modules themselves
// register literal routes before `/:param` routes.
app.route("/v1/admin", v1AdminRoutes);
app.route("/v1/admin/database", databaseRoutes);
app.route("/v1/auth", oauthRoutes);
app.route("/v1/providers", providersRoutes);
app.route("/v1/keys", v1KeysRoutes);
app.route("/v1/logs", logsRoutes);
app.route("/v1/settings", v1SettingsRoutes);
app.route("/v1/favorites", v1FavoritesRoutes);
app.route("/v1/quota", quotaRoutes);
app.route("/v1/pricing", pricingRoutes);
app.route("/v1/tunnel", tunnelRoutes);
app.route("/api", adminRoutes);

app.notFound((c) => {
    // Anything not matched above falls through to the dashboard.
    if (c.req.path.startsWith("/v1/") || c.req.path.startsWith("/api/")) {
        return c.json({ error: { message: "Not found", type: "invalid_request_error" } }, 404);
    }
    // The real SRouter React shell (apps/web/dist/index.html) is inlined into
    // the bundle (see scripts/inline-dashboard.mjs); the JS/CSS chunks are
    // served as Workers Static Assets. Unmatched non-API paths are SPA routes,
    // so serve the shell for client-side routing.
    return new Response(DASHBOARD_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
    });
});

async function refreshOAuthAccount(
    env: Env,
    row: ProviderRow,
    account: { accessToken?: string; refreshToken?: string; extra: Record<string, unknown> }
): Promise<{ accessToken?: string; refreshToken?: string; expiresIn?: number } | null> {
    // SRouter's tokenRefresh service resolves an OAuth client per provider type;
    // qoder device tokens are a documented no-op, grok-cli/gemini-cli land in Phase 2.
    try {
        return await refreshOAuthTokens(row.provider_id, account.refreshToken, env);
    } catch (err) {
        console.error(
            `Token refresh failed for account ${row.id}:`,
            err instanceof Error ? err.message : err
        );
        return null;
    }
}

/**
 * Cron sweeper — replaces SRouter's in-process setInterval token refresher.
 * Runs per minute (see wrangler.toml [triggers]): for each OAuth account whose
 * token expires within 10 minutes (or has no recorded expiry), acquire a
 * per-account refresh lock from the RouterState DO and refresh it.
 */
async function scheduled(env: Env): Promise<void> {
    const rows = await env.DB.prepare(
        `SELECT * FROM providers
         WHERE enabled = 1 AND category = 'oauth'
           AND (token_expires_at IS NULL OR token_expires_at < ?)`
    )
        .bind(Date.now() + 10 * 60 * 1000)
        .all<ProviderRow>();
    const stub = env.ROUTER_STATE.getByName("router");

    await Promise.allSettled(
        (rows.results ?? []).map(async (row) => {
            const lockRes = await stub.fetch(
                new Request("https://do/refresh/try", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ accountId: row.id, ttlMs: 120_000 })
                })
            );
            const { acquired } = (await lockRes.json()) as { acquired: boolean };
            if (!acquired) return;

            const account = await decryptAccount(row, env.MASTER_KEY);
            const refreshed = await refreshOAuthAccount(env, row, account);
            if (!refreshed?.accessToken) {
                console.error(`Token refresh failed for account ${row.id}`);
                return;
            }
            const secretsEnc = await encryptSecretsObject(
                {
                    api_key: account.apiKey,
                    access_token: refreshed.accessToken,
                    refresh_token: refreshed.refreshToken ?? account.refreshToken,
                    extra: account.extra
                },
                env.MASTER_KEY
            );
            const expiresInMs = (refreshed.expiresIn ?? 3600) * 1000;
            await env.DB.prepare(
                `UPDATE providers
                 SET secrets_enc = ?, token_expires_at = ?, last_refreshed_at = ?
                 WHERE id = ?`
            )
                .bind(secretsEnc, Date.now() + expiresInMs, Date.now(), row.id)
                .run();
        })
    );
}

export default {
    fetch: app.fetch,
    scheduled: async (
        _controller: ScheduledController,
        env: Env,
        ctx: ExecutionContext
    ) => {
        ctx.waitUntil(scheduled(env));
    }
};

/** Exported for integration tests (test/dashboard.test.ts). */
export { app };

export { RouterState };
