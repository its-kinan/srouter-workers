// srouter-workers — Cloudflare Workers port of SRouter.
// OpenAI-compatible multi-account gateway: Worker + D1 + Durable Object.
//
// Routes:
//   GET  /health                  liveness (public)
//   GET  /v1/models               aggregated model list (virtual key or admin session)
//   POST /v1/chat/completions     chat completions, SSE or JSON (virtual key or admin session)
//   /api/admin/*                  first-run setup, login/logout, status summary
//   /*                            static dashboard shell (ASSETS)

import { Hono } from "hono";
import type { Env } from "./env.js";
import { chatRoutes } from "./routes/chat.js";
import { modelsRoutes } from "./routes/models.js";
import { adminRoutes } from "./routes/admin.js";
import { RouterState } from "./router/durable.js";
import { decryptAccount, type ProviderRow } from "./providers/registry.js";
import { refreshOAuthTokens } from "./providers/oauth-refresh.js";
import { encryptSecretsObject } from "./crypto/secretbox.js";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "srouter-workers" }));

app.route("/v1", chatRoutes);
app.route("/v1", modelsRoutes);
app.route("/api", adminRoutes);

app.notFound((c) => {
    // Anything not matched above falls through to the static dashboard shell.
    if (c.req.path.startsWith("/v1/") || c.req.path.startsWith("/api/")) {
        return c.json({ error: { message: "Not found", type: "invalid_request_error" } }, 404);
    }
    return c.env.ASSETS.fetch(c.req.raw);
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

export { RouterState };
