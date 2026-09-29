// OAuth token refresh for the cron sweeper.
// Ported from SRouter packages/providers/src/oauth/* (refreshTokens methods).
// Public client ids are copied from SRouter's public constants package.
// The Antigravity Google OAuth client SECRET is never committed: it must be
// set as a Worker secret (ANTIGRAVITY_OAUTH_CLIENT_SECRET); without it,
// Antigravity accounts are skipped by the sweeper and logged.

export interface RefreshedTokens {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
}

interface EnvSecrets {
    ANTIGRAVITY_OAUTH_CLIENT_SECRET?: string;
    ANTIGRAVITY_OAUTH_CLIENT_ID?: string;
    CODEX_OAUTH_CLIENT_ID?: string;
}

const ANTIGRAVITY_OAUTH_CLIENT_ID =
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const ANTIGRAVITY_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";

async function refreshGoogle(
    refreshToken: string,
    clientId: string,
    clientSecret: string
): Promise<RefreshedTokens> {
    const res = await fetch(ANTIGRAVITY_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken
        })
    });
    if (!res.ok) {
        throw new Error(
            `Antigravity OAuth refresh failed (${res.status}): ${(await res.text()).slice(0, 200)}`
        );
    }
    const data = (await res.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
    };
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? refreshToken,
        expiresIn: data.expires_in
    };
}

async function refreshCodex(refreshToken: string, clientId: string): Promise<RefreshedTokens> {
    const res = await fetch(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: clientId,
            refresh_token: refreshToken
        })
    });
    if (!res.ok) {
        throw new Error(
            `Codex OAuth refresh failed (${res.status}): ${(await res.text()).slice(0, 200)}`
        );
    }
    const data = (await res.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
    };
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? refreshToken,
        expiresIn: data.expires_in
    };
}

import { GrokCliOAuth } from "./oauth-flows.js";
import { routerShardName } from "../router/durable.js";

/**
 * Refresh an OAuth account's access token. Returns null when the provider
 * type has no refresh flow (qoder device tokens are a documented no-op in
 * SRouter too).
 */
export async function refreshOAuthTokens(
    providerType: string,
    refreshToken: string | undefined,
    secrets: EnvSecrets
): Promise<RefreshedTokens | null> {
    if (!refreshToken) return null;
    switch (providerType) {
        case "antigravity": {
            if (!secrets.ANTIGRAVITY_OAUTH_CLIENT_SECRET) {
                console.warn(
                    "Skipping Antigravity token refresh: ANTIGRAVITY_OAUTH_CLIENT_SECRET not set"
                );
                return null;
            }
            // Use the bring-your-own client ID when configured, so refresh matches
            // the client the authorize step used.
            return refreshGoogle(
                refreshToken,
                secrets.ANTIGRAVITY_OAUTH_CLIENT_ID || ANTIGRAVITY_OAUTH_CLIENT_ID,
                secrets.ANTIGRAVITY_OAUTH_CLIENT_SECRET
            );
        }
        case "openai_codex":
            return refreshCodex(refreshToken, secrets.CODEX_OAUTH_CLIENT_ID || CODEX_OAUTH_CLIENT_ID);
        case "grok-cli": {
            const refreshed = await new GrokCliOAuth().refreshTokens(refreshToken);
            return {
                accessToken: refreshed.accessToken,
                refreshToken: refreshed.refreshToken,
                expiresIn: refreshed.expiresIn
            };
        }
        default:
            return null;
    }
}

// Matches SRouter's REFRESH_LEAD_MS (5 minutes): refresh when the token
// expires within 5 minutes, or when no expiry is known and the token has
// never been refreshed (or was refreshed > 12h ago).
const REFRESH_LEAD_MS = 5 * 60 * 1000;
const STALE_REFRESH_MS = 12 * 60 * 60 * 1000;

export function isDueForRefresh(
    tokenExpiresAt: number | null,
    lastRefreshedAt: number | null,
    hasRefreshToken: boolean
): boolean {
    if (!hasRefreshToken) return false;
    const now = Date.now();
    if (tokenExpiresAt == null) {
        return lastRefreshedAt == null || now - lastRefreshedAt > STALE_REFRESH_MS;
    }
    return tokenExpiresAt - now < REFRESH_LEAD_MS;
}

export interface EnsureFreshTokenDeps {
    DB: D1Database;
    ROUTER_STATE: DurableObjectNamespace;
    MASTER_KEY: string;
    ANTIGRAVITY_OAUTH_CLIENT_SECRET?: string;
    ANTIGRAVITY_OAUTH_CLIENT_ID?: string;
    CODEX_OAUTH_CLIENT_ID?: string;
}

/**
 * Lazy token refresh — ported from SRouter's ensureFreshToken.
 * Called before routing to a provider account. If the account's OAuth token
 * is expired or expiring soon, refreshes it (with DO-distributed lock to
 * prevent concurrent refreshes) and updates D1.
 * Returns the (possibly refreshed) access token, or the original if no
 * refresh was needed/possible.
 */
export async function ensureFreshToken(
    deps: EnsureFreshTokenDeps,
    accountId: string,
    providerType: string,
    currentAccessToken: string | undefined,
    refreshToken: string | undefined,
    tokenExpiresAt: number | null,
    lastRefreshedAt: number | null,
    encryptFn: (secrets: Record<string, unknown>) => Promise<string>
): Promise<string | undefined> {
    if (!isDueForRefresh(tokenExpiresAt, lastRefreshedAt, !!refreshToken)) {
        return currentAccessToken;
    }

    // Acquire per-account refresh lock from the account's provider RouterState
    // shard (not the old global "router" name — shards are per provider).
    const stub = deps.ROUTER_STATE.getByName(routerShardName(providerType));
    const lockRes = await stub.fetch(
        new Request("https://do/refresh/try", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId, ttlMs: 120_000 })
        })
    );
    const { acquired } = (await lockRes.json()) as { acquired: boolean };
    if (!acquired) {
        // Another isolate is refreshing; use the current token.
        return currentAccessToken;
    }

    try {
        const refreshed = await refreshOAuthTokens(providerType, refreshToken, deps);
        if (!refreshed?.accessToken) {
            return currentAccessToken;
        }
        const secretsEnc = await encryptFn({
            access_token: refreshed.accessToken,
            refresh_token: refreshed.refreshToken ?? refreshToken,
        });
        const expiresInMs = (refreshed.expiresIn ?? 3600) * 1000;
        await deps.DB.prepare(
            `UPDATE providers
             SET secrets_enc = ?, token_expires_at = ?, last_refreshed_at = ?
             WHERE id = ?`
        )
            .bind(secretsEnc, Date.now() + expiresInMs, Date.now(), accountId)
            .run();
        return refreshed.accessToken;
    } catch (err) {
        console.error(
            `Lazy token refresh failed for account ${accountId}:`,
            err instanceof Error ? err.message : err
        );
        return currentAccessToken;
    }
}
