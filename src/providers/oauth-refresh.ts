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
}

const ANTIGRAVITY_OAUTH_CLIENT_ID =
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const ANTIGRAVITY_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";

async function refreshGoogle(
    refreshToken: string,
    clientSecret: string
): Promise<RefreshedTokens> {
    const res = await fetch(ANTIGRAVITY_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
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

async function refreshCodex(refreshToken: string): Promise<RefreshedTokens> {
    const res = await fetch(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: CODEX_OAUTH_CLIENT_ID,
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

/**
 * Refresh an OAuth account's access token. Returns null when the provider
 * type has no refresh flow in Phase 1 (qoder device tokens are a documented
 * no-op in SRouter too; grok-cli/gemini-cli arrive in Phase 2).
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
            return refreshGoogle(refreshToken, secrets.ANTIGRAVITY_OAUTH_CLIENT_SECRET);
        }
        case "openai_codex":
            return refreshCodex(refreshToken);
        default:
            return null;
    }
}
