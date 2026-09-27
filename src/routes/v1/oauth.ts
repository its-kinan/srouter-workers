// OAuth routes for the Cloudflare Workers port (mounted at /v1/auth).
//
// Interactive OAuth flows, ported from SRouter apps/api (controllers/auth.controller.ts,
// logic/auth.logic.ts, services/authHandlers.ts):
//
// PKCE flows (openai, antigravity, claude, qoder):
//   GET  /v1/auth/<provider>/login    — generate PKCE, store encrypted session,
//                                       return authorize URL (or 302 redirect)
//   GET  /v1/auth/<provider>/callback — exchange code+state for tokens, store provider
//   POST /v1/auth/<provider>/callback — same, accepts JSON body {code, state, callback_url}
//
// Device flows (cline, codebuddy, codebuddy-cn, grok-cli, qoder):
//   GET  /v1/auth/<provider>/device   — initiate device auth, return user code + verify URL
//   GET  /v1/auth/<provider>/poll     — poll for token completion (?state= or JSON {state})
//   POST /v1/auth/<provider>/poll
//
// Token import (all providers):
//   POST /v1/auth/:provider/token
//
// Secrets are stored as AES-GCM envelopes (secrets_enc) — never plaintext.
// PKCE code_verifiers are encrypted (code_verifier_enc) — never plaintext.
// The Antigravity Google OAuth client secret comes from the
// ANTIGRAVITY_OAUTH_CLIENT_SECRET Worker secret, never hardcoded.

import { Hono, type Context } from "hono";
import type { AppHonoEnv } from "../../hono-env.js";
import type { Env } from "../../env.js";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { apiError } from "../../lib/api-error.js";
import { encryptSecret, decryptSecret, encryptSecretsObject } from "../../crypto/secretbox.js";
import {
    generatePKCE,
    AuthPollStatus,
    type PKCEPair,
    type OAuthTokenResponse,
    AntigravityOAuth,
    ClaudeOAuth,
    OpenAICodexOAuth,
    QoderOAuth,
    CodeBuddyOAuth,
    CodeBuddyCNOAuth,
    ClineOAuth,
    GrokCliOAuth,
    extractEmailFromJwt,
    CLINE_BASE_URL
} from "../../providers/oauth-flows.js";

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
    "tokenrouter",
    "grok-cli"
]);

/** Providers whose token is stored as an api_key rather than an access_token. */
const API_KEY_GROUP = new Set(["commandcode", "anthropic", "atria", "tokenrouter"]);

const PKCE_PROVIDERS = new Set(["openai", "antigravity", "claude", "qoder"]);
const DEVICE_PROVIDERS = new Set(["cline", "codebuddy", "codebuddy-cn", "grok-cli"]);

const PKCE_SESSION_MAX_AGE_MS = 15 * 60 * 1000;

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

function providerIdFor(authProvider: string): string {
    // Auth route id -> providers.provider_id. "openai" auth = openai_codex accounts.
    if (authProvider === "openai") return "openai_codex";
    return authProvider;
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
        tokenrouter: "TokenRouter",
        "grok-cli": "Grok CLI"
    };
    return names[provider] ?? provider;
}

function successMessage(provider: string): string {
    const messages: Record<string, string> = {
        openai: "Login OpenAI Codex Berhasil!",
        antigravity: "Login Antigravity OAuth Berhasil!",
        claude: "Login Claude Code OAuth Berhasil!",
        qoder: "Login Qoder Berhasil!",
        cline: "Login Cline Berhasil!",
        codebuddy: "Login CodeBuddy Berhasil!",
        "codebuddy-cn": "Login CodeBuddy CN Berhasil!",
        "grok-cli": "Login Grok CLI Berhasil!"
    };
    return messages[provider] ?? `Login ${displayName(provider)} Berhasil!`;
}

// ---------------------------------------------------------------------------
// OAuth session store (D1 oauth_sessions). code_verifier is always encrypted.
// ---------------------------------------------------------------------------

interface OAuthSessionRow {
    state: string;
    code_verifier_enc: string | null;
    device_code: string | null;
    client_id: string;
    redirect_uri: string;
    created_at: number;
    claimed_at: number | null;
}

async function cleanupExpiredOAuthSessions(db: D1Database): Promise<void> {
    await db
        .prepare("DELETE FROM oauth_sessions WHERE created_at < ?")
        .bind(Date.now() - PKCE_SESSION_MAX_AGE_MS)
        .run();
}

async function saveOAuthSession(
    db: D1Database,
    masterKey: string,
    session: {
        state: string;
        codeVerifier?: string;
        deviceCode?: string;
        clientId: string;
        redirectUri: string;
    }
): Promise<void> {
    const codeVerifierEnc = session.codeVerifier
        ? await encryptSecret(session.codeVerifier, masterKey)
        : null;
    await db
        .prepare(
            `INSERT OR REPLACE INTO oauth_sessions
                 (state, code_verifier_enc, device_code, client_id, redirect_uri, created_at, claimed_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL)`
        )
        .bind(
            session.state,
            codeVerifierEnc,
            session.deviceCode ?? null,
            session.clientId,
            session.redirectUri,
            Date.now()
        )
        .run();
}

/** Atomically claim a session (sets claimed_at). Returns null if missing/expired/claimed. */
async function claimOAuthSession(
    db: D1Database,
    masterKey: string,
    state: string
): Promise<(OAuthSessionRow & { codeVerifier: string | null }) | null> {
    const claimed = await db
        .prepare(
            `UPDATE oauth_sessions SET claimed_at = ?
             WHERE state = ? AND claimed_at IS NULL AND created_at > ?`
        )
        .bind(Date.now(), state, Date.now() - PKCE_SESSION_MAX_AGE_MS)
        .run();
    if ((claimed.meta.changes ?? 0) === 0) return null;

    const row = await db
        .prepare("SELECT * FROM oauth_sessions WHERE state = ?")
        .bind(state)
        .first<OAuthSessionRow>();
    if (!row) return null;

    let codeVerifier: string | null = null;
    if (row.code_verifier_enc) {
        try {
            codeVerifier = await decryptSecret(row.code_verifier_enc, masterKey);
        } catch {
            codeVerifier = null;
        }
    }
    return { ...row, codeVerifier };
}

async function releaseOAuthSession(db: D1Database, state: string): Promise<void> {
    await db
        .prepare("UPDATE oauth_sessions SET claimed_at = NULL WHERE state = ?")
        .bind(state)
        .run();
}

async function deleteOAuthSession(db: D1Database, state: string): Promise<void> {
    await db.prepare("DELETE FROM oauth_sessions WHERE state = ?").bind(state).run();
}

// ---------------------------------------------------------------------------
// Account identity helpers (ported from auth.logic.ts)
// ---------------------------------------------------------------------------

function extractEmailFromToken(token?: string): string | undefined {
    if (!token || typeof token !== "string" || !token.startsWith("eyJ")) return undefined;
    try {
        const parts = token.split(".");
        if (parts.length < 2) return undefined;
        const payloadB64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
        const decoded = JSON.parse(atob(payloadB64)) as Record<string, unknown>;
        if (typeof decoded.email === "string" && decoded.email.includes("@")) return decoded.email;
        const profile = decoded["https://api.openai.com/profile"] as
            | { email?: string }
            | undefined;
        if (typeof profile?.email === "string") return profile.email;
        const userMetadata = decoded.user_metadata as { email?: string } | undefined;
        if (typeof userMetadata?.email === "string") return userMetadata.email;
        if (
            typeof decoded.preferred_username === "string" &&
            decoded.preferred_username.includes("@")
        ) {
            return decoded.preferred_username;
        }
        if (typeof decoded.unique_name === "string" && decoded.unique_name.includes("@")) {
            return decoded.unique_name;
        }
    } catch {
        return undefined;
    }
    return undefined;
}

function buildAccountIdentity(
    provider: string,
    now: number,
    tokens?: { accessToken?: string; idToken?: string }
): { accountId: string; accountName: string } {
    const email =
        extractEmailFromToken(tokens?.idToken) || extractEmailFromToken(tokens?.accessToken);
    const accountName =
        email || `${displayName(provider)} (Account #${now.toString().slice(-4)})`;
    return {
        accountId: `${providerIdFor(provider)}_${now}`,
        accountName
    };
}

// ---------------------------------------------------------------------------
// Provider persistence
// ---------------------------------------------------------------------------

interface StoredProvider {
    id: string;
    providerId: string;
    name: string;
    category: string;
    protocol: string;
    base_url: string | null;
    account_id: string | null;
    organization_id: string | null;
    enabled: boolean;
    createdAt: number;
}

async function storeOAuthProvider(
    env: Env,
    provider: string,
    opts: {
        name: string;
        baseUrl?: string;
        accessToken: string;
        refreshToken?: string;
        accountId?: string;
        organizationId?: string;
        expiresIn?: number;
        providerSpecificData?: Record<string, unknown>;
    }
): Promise<StoredProvider> {
    const now = Date.now();
    const id = `${providerIdFor(provider)}_${now}`;
    const secrets: Record<string, string> = { access_token: opts.accessToken };
    if (opts.refreshToken) secrets.refresh_token = opts.refreshToken;
    const secretsEnc = await encryptSecretsObject(secrets, env.MASTER_KEY);

    await env.DB.prepare(
        `INSERT INTO providers
             (id, provider_id, name, category, protocol, base_url, secrets_enc,
              account_id, organization_id, provider_specific_data,
              token_expires_at, last_refreshed_at, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    )
        .bind(
            id,
            providerIdFor(provider),
            opts.name,
            "oauth",
            protocolFor(provider),
            opts.baseUrl ?? null,
            secretsEnc,
            opts.accountId ?? null,
            opts.organizationId ?? null,
            opts.providerSpecificData ? JSON.stringify(opts.providerSpecificData) : null,
            opts.expiresIn ? now + opts.expiresIn * 1000 : null,
            now,
            now
        )
        .run();

    return {
        id,
        providerId: providerIdFor(provider),
        name: opts.name,
        category: "oauth",
        protocol: protocolFor(provider),
        base_url: opts.baseUrl ?? null,
        account_id: opts.accountId ?? null,
        organization_id: opts.organizationId ?? null,
        enabled: true,
        createdAt: now
    };
}

// ---------------------------------------------------------------------------
// PKCE provider clients
// ---------------------------------------------------------------------------

interface PKCEClient {
    getAuthorizationUrl(pkce: PKCEPair): string;
    exchangeCodeForTokens(code: string, codeVerifier: string): Promise<OAuthTokenResponse>;
}

function pkceClientFor(
    provider: string,
    env: Env,
    redirectUri: string,
    extra?: { clientId?: string; prompt?: string }
): PKCEClient | null {
    switch (provider) {
        case "antigravity":
            return new AntigravityOAuth({
                clientId: extra?.clientId,
                clientSecret: env.ANTIGRAVITY_OAUTH_CLIENT_SECRET,
                redirectUri,
                prompt: extra?.prompt
            });
        case "claude":
            return new ClaudeOAuth({ clientId: extra?.clientId, redirectUri, prompt: extra?.prompt });
        case "openai":
            return new OpenAICodexOAuth({
                clientId: extra?.clientId,
                redirectUri,
                prompt: extra?.prompt
            });
        case "qoder":
            return new QoderOAuth();
        default:
            return null;
    }
}

function baseUrlFor(provider: string): string | undefined {
    if (provider === "antigravity") return "https://daily-cloudcode-pa.googleapis.com";
    if (provider === "cline") return CLINE_BASE_URL;
    if (provider === "codebuddy") return "https://www.codebuddy.ai/v2/chat/completions";
    if (provider === "codebuddy-cn") return "https://copilot.tencent.com/v2/chat/completions";
    if (provider === "grok-cli") return "https://cli-chat-proxy.grok.com/v1";
    return undefined;
}

/** Derive the callback redirect URI from the incoming request origin. */
function redirectUriFor(c: Context<AppHonoEnv>, provider: string): string {
    const origin = new URL(c.req.url).origin;
    return `${origin}/v1/auth/${provider}/callback`;
}

// ---------------------------------------------------------------------------
// PKCE routes: GET /:provider/login, GET|POST /:provider/callback
// ---------------------------------------------------------------------------

for (const p of ["openai", "antigravity", "claude", "qoder"]) {
    oauthRoutes.get(
        `/${p}/login`,
        requireAdmin,
        async (c: Context<AppHonoEnv>): Promise<Response> => {
            const provider = p;
            try {
                await cleanupExpiredOAuthSessions(c.env.DB);

                const clientId = c.req.query("client_id") || undefined;
                const prompt = c.req.query("prompt") || undefined;
                // Allow an explicit redirect_uri override (dashboard may pass one);
                // otherwise derive from the Worker origin.
                const redirectUri = c.req.query("redirect_uri") || redirectUriFor(c, provider);

                const client = pkceClientFor(provider, c.env, redirectUri, { clientId, prompt });
                if (!client) {
                    return apiError(c, 400, `Unknown OAuth provider: ${provider}`, "unknown_provider");
                }

                const pkce = await generatePKCE();
                await saveOAuthSession(c.env.DB, c.env.MASTER_KEY, {
                    state: pkce.state,
                    codeVerifier: pkce.codeVerifier,
                    clientId: clientId ?? "",
                    redirectUri
                });

                const authorizeUrl = client.getAuthorizationUrl(pkce);
                const result = {
                    authorizeUrl,
                    state: pkce.state,
                    codeVerifier: pkce.codeVerifier,
                    redirectUri
                };
                // The dashboard always requests ?format=json; a bare browser
                // visit gets a 302 to the provider's authorize page.
                if (c.req.query("format") === "json") {
                    return c.json(result);
                }
                return c.redirect(authorizeUrl, 302);
            } catch (error) {
                return apiError(
                    c,
                    400,
                    error instanceof Error ? error.message : String(error),
                    "oauth_login_failed"
                );
            }
        }
    );

    const handleCallback = async (c: Context<AppHonoEnv>): Promise<Response> => {
        const provider = p;
        const rawBody = c.req.method === "POST" ? await c.req.json().catch(() => null) : null;
        const body =
            rawBody && typeof rawBody === "object" ? (rawBody as Record<string, unknown>) : null;

        let code = c.req.query("code") ?? (body?.code as string | undefined);
        let state = c.req.query("state") ?? (body?.state as string | undefined);

        const callbackUrl = body?.callback_url as string | undefined;
        if (callbackUrl) {
            try {
                const url = new URL(callbackUrl);
                code = code ?? url.searchParams.get("code") ?? undefined;
                state = state ?? url.searchParams.get("state") ?? undefined;
            } catch {
                // fall through to the missing-param error below
            }
        }

        if (!code || !state) {
            return apiError(
                c,
                400,
                "Missing required 'code' or 'state' parameters in OAuth callback",
                "missing_oauth_params"
            );
        }

        await cleanupExpiredOAuthSessions(c.env.DB);
        const session = await claimOAuthSession(c.env.DB, c.env.MASTER_KEY, state);
        if (!session) {
            return apiError(c, 400, "Invalid or expired OAuth state parameter", "invalid_oauth_state");
        }
        // Session is single-use; remove it now (restored on exchange failure).
        await deleteOAuthSession(c.env.DB, state);

        const client = pkceClientFor(provider, c.env, session.redirect_uri || redirectUriFor(c, provider));
        if (!client) {
            return apiError(c, 400, `Unknown OAuth provider: ${provider}`, "unknown_provider");
        }

        let rawTokens: OAuthTokenResponse;
        try {
            rawTokens = await client.exchangeCodeForTokens(code, session.codeVerifier ?? "");
        } catch (error) {
            // Allow retry with the same state on transient exchange failures.
            await saveOAuthSession(c.env.DB, c.env.MASTER_KEY, {
                state: session.state,
                codeVerifier: session.codeVerifier ?? undefined,
                clientId: session.client_id,
                redirectUri: session.redirect_uri
            });
            return apiError(
                c,
                500,
                error instanceof Error ? error.message : String(error),
                "oauth_exchange_failed"
            );
        }

        const now = Date.now();
        const { accountId, accountName } = buildAccountIdentity(provider, now, {
            accessToken: rawTokens.accessToken,
            idToken: rawTokens.idToken
        });

        // Provider-specific token mapping (mirrors authHandlers.ts mapOAuthTokens).
        let accountIdOverride: string | undefined;
        let organizationId: string | undefined;
        let providerSpecificData: Record<string, unknown> | undefined;
        if (provider === "openai") {
            accountIdOverride = rawTokens.accountId;
        } else if (provider === "claude") {
            organizationId = rawTokens.organizationId;
        } else if (provider === "qoder") {
            accountIdOverride = rawTokens.accountId;
        }

        const stored = await storeOAuthProvider(c.env, provider, {
            name: accountName,
            baseUrl: baseUrlFor(provider),
            accessToken: rawTokens.accessToken,
            refreshToken: rawTokens.refreshToken,
            accountId: accountIdOverride ?? accountId,
            organizationId,
            expiresIn: rawTokens.expiresIn,
            providerSpecificData
        });

        return c.json({
            success: true,
            message: successMessage(provider),
            provider: stored
        });
    };

    oauthRoutes.get(`/${p}/callback`, requireAdmin, handleCallback);
    oauthRoutes.post(`/${p}/callback`, requireAdmin, handleCallback);
}

// ---------------------------------------------------------------------------
// Device flows: GET /:provider/device, GET|POST /:provider/poll
// ---------------------------------------------------------------------------

async function initiateDeviceFlow(
    c: Context<AppHonoEnv>,
    provider: "cline" | "codebuddy" | "codebuddy-cn" | "grok-cli"
): Promise<Response> {
    try {
        await cleanupExpiredOAuthSessions(c.env.DB);

        if (provider === "grok-cli") {
            const device = await new GrokCliOAuth().requestDeviceCode();
            const stateBytes = crypto.getRandomValues(new Uint8Array(16));
            let s = "";
            for (let i = 0; i < stateBytes.length; i++) s += String.fromCharCode(stateBytes[i]!);
            const state = btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
            await saveOAuthSession(c.env.DB, c.env.MASTER_KEY, {
                state,
                deviceCode: device.deviceCode,
                clientId: "",
                redirectUri: ""
            });
            return c.json({
                authorizeUrl: device.verificationUriComplete ?? device.verificationUri,
                state,
                userCode: device.userCode,
                expiresIn: device.expiresIn,
                interval: device.interval
            });
        }

        if (provider === "cline") {
            const device = await new ClineOAuth().requestDeviceAuthorization();
            // Use a random state key; the WorkOS device_code is stored encrypted-adjacent.
            const stateBytes = crypto.getRandomValues(new Uint8Array(16));
            let s = "";
            for (let i = 0; i < stateBytes.length; i++) s += String.fromCharCode(stateBytes[i]!);
            const state = btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
            await saveOAuthSession(c.env.DB, c.env.MASTER_KEY, {
                state,
                deviceCode: device.deviceCode,
                clientId: "",
                redirectUri: ""
            });
            return c.json({
                authorizeUrl: device.verificationUriComplete ?? device.verificationUri,
                state,
                userCode: device.userCode,
                expiresIn: device.expiresIn,
                interval: device.interval
            });
        }

        const oauth = provider === "codebuddy-cn" ? new CodeBuddyCNOAuth() : new CodeBuddyOAuth();
        const { state, authUrl } = await oauth.requestAuthState();
        await saveOAuthSession(c.env.DB, c.env.MASTER_KEY, {
            state,
            clientId: "",
            redirectUri: ""
        });
        return c.json({ authorizeUrl: authUrl, state });
    } catch (error) {
        return apiError(
            c,
            500,
            `Failed to initiate ${displayName(provider)} login: ${error instanceof Error ? error.message : String(error)}`,
            "device_flow_failed"
        );
    }
}

async function extractPollState(c: Context<AppHonoEnv>): Promise<string | undefined> {
    if (c.req.method !== "POST") return c.req.query("state");
    const body = await c.req.json().catch(() => null);
    if (body && typeof body === "object" && typeof (body as Record<string, unknown>).state === "string") {
        return (body as Record<string, unknown>).state as string;
    }
    return c.req.query("state");
}

async function pollDeviceFlow(
    c: Context<AppHonoEnv>,
    provider: "cline" | "codebuddy" | "codebuddy-cn" | "grok-cli"
): Promise<Response> {
    const state = await extractPollState(c);
    if (!state) {
        return apiError(c, 400, "Missing state parameter", "missing_state");
    }

    const session = await claimOAuthSession(c.env.DB, c.env.MASTER_KEY, state);
    if (!session) {
        return c.json({ status: AuthPollStatus.PENDING, error: "Session expired or not found" });
    }

    if (provider === "grok-cli") {
        if (!session.device_code) {
            await releaseOAuthSession(c.env.DB, state);
            return c.json({ status: AuthPollStatus.PENDING, error: "Session expired or not found" });
        }
        const oauth = new GrokCliOAuth();
        const result = await oauth.pollDeviceToken(session.device_code);
        if (result.status !== AuthPollStatus.OK || !result.accessToken) {
            await releaseOAuthSession(c.env.DB, state);
            return c.json({ status: AuthPollStatus.PENDING, error: result.error });
        }
        await deleteOAuthSession(c.env.DB, state);

        // Identity: id_token email > access_token email > /v1/user profile.
        const profile = await oauth.fetchUserProfile(result.accessToken);
        const email =
            extractEmailFromJwt(result.idToken) ||
            extractEmailFromJwt(result.accessToken) ||
            profile?.email;
        const now = Date.now();
        const accountName =
            (email && `Grok CLI (${email})`) ||
            (profile?.displayName && `Grok CLI (${profile.displayName})`) ||
            `Grok CLI (Account #${now.toString().slice(-4)})`;

        const stored = await storeOAuthProvider(c.env, provider, {
            name: accountName,
            baseUrl: baseUrlFor(provider),
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            accountId: profile?.userId,
            expiresIn: result.expiresIn,
            providerSpecificData: {
                authMethod: "device_code",
                idToken: result.idToken ?? null,
                email: email ?? null,
                userId: profile?.userId ?? null,
                hasGrokCodeAccess: profile?.hasGrokCodeAccess ?? null,
                subscriptionTier: profile?.subscriptionTier ?? null
            }
        });
        return c.json({ status: AuthPollStatus.OK, provider: stored });
    }

    if (provider === "cline") {
        if (!session.device_code) {
            await releaseOAuthSession(c.env.DB, state);
            return c.json({ status: AuthPollStatus.PENDING, error: "Session expired or not found" });
        }
        const result = await new ClineOAuth().pollDeviceToken(session.device_code);
        if (result.status !== AuthPollStatus.OK || !result.accessToken) {
            await releaseOAuthSession(c.env.DB, state);
            return c.json({ status: AuthPollStatus.PENDING, error: result.error });
        }
        await deleteOAuthSession(c.env.DB, state);

        const now = Date.now();
        const accountName =
            result.name || result.email || `Cline (Account #${now.toString().slice(-4)})`;
        const stored = await storeOAuthProvider(c.env, provider, {
            name: accountName,
            baseUrl: baseUrlFor(provider),
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            accountId: result.accountId,
            expiresIn: result.expiresIn,
            providerSpecificData: { authMethod: "workos-device", email: result.email || "" }
        });
        return c.json({ status: AuthPollStatus.OK, provider: stored });
    }

    const oauth = provider === "codebuddy-cn" ? new CodeBuddyCNOAuth() : new CodeBuddyOAuth();
    let poll: {
        status: AuthPollStatus;
        accessToken?: string;
        refreshToken?: string;
        expiresIn?: number;
        error?: string;
    };
    try {
        poll = await oauth.pollToken(state);
    } catch (err) {
        await releaseOAuthSession(c.env.DB, state);
        return c.json({
            status: AuthPollStatus.PENDING,
            error: err instanceof Error ? err.message : String(err)
        });
    }
    if (poll.status !== AuthPollStatus.OK || !poll.accessToken) {
        await releaseOAuthSession(c.env.DB, state);
        return c.json({ status: AuthPollStatus.PENDING, error: poll.error });
    }
    await deleteOAuthSession(c.env.DB, state);

    const now = Date.now();
    const stored = await storeOAuthProvider(c.env, provider, {
        name: `${displayName(provider)} (Account #${now.toString().slice(-4)})`,
        baseUrl: baseUrlFor(provider),
        accessToken: poll.accessToken,
        refreshToken: poll.refreshToken,
        expiresIn: poll.expiresIn
    });
    return c.json({ status: AuthPollStatus.OK, provider: stored });
}

for (const p of ["cline", "codebuddy", "codebuddy-cn", "grok-cli"] as const) {
    oauthRoutes.get(`/${p}/device`, requireAdmin, (c) => initiateDeviceFlow(c, p));
    oauthRoutes.get(`/${p}/poll`, requireAdmin, (c) => pollDeviceFlow(c, p));
    oauthRoutes.post(`/${p}/poll`, requireAdmin, (c) => pollDeviceFlow(c, p));
}

// ---------------------------------------------------------------------------
// Qoder device-style poll endpoints (Qoder also has a PKCE /login + /callback).
// ---------------------------------------------------------------------------

async function pollQoderDevice(c: Context<AppHonoEnv>): Promise<Response> {
    const state = await extractPollState(c);
    if (!state) {
        return apiError(c, 400, "Missing state parameter", "missing_state");
    }

    const session = await claimOAuthSession(c.env.DB, c.env.MASTER_KEY, state);
    if (!session) {
        return c.json({ status: AuthPollStatus.PENDING, error: "Session expired or not found" });
    }

    const qoderOAuth = new QoderOAuth();
    let poll: {
        status: AuthPollStatus;
        accessToken?: string;
        refreshToken?: string;
        userId?: string;
        expiresIn?: number;
    };
    try {
        poll = await qoderOAuth.pollDeviceToken({
            nonce: state,
            codeVerifier: session.codeVerifier ?? ""
        });
    } catch (err) {
        await releaseOAuthSession(c.env.DB, state);
        return c.json({
            status: AuthPollStatus.PENDING,
            error: err instanceof Error ? err.message : String(err)
        });
    }

    if (poll.status !== AuthPollStatus.OK || !poll.accessToken) {
        await releaseOAuthSession(c.env.DB, state);
        return c.json({ status: AuthPollStatus.PENDING });
    }
    await deleteOAuthSession(c.env.DB, state);

    const userInfo = await qoderOAuth.fetchUserInfo(poll.accessToken);
    const now = Date.now();
    const accountName = userInfo.name
        ? `Qoder (${userInfo.name})`
        : `Qoder (Account #${now.toString().slice(-4)})`;
    const userId = poll.userId || userInfo.id;

    const stored = await storeOAuthProvider(c.env, "qoder", {
        name: accountName,
        accessToken: poll.accessToken,
        refreshToken: poll.refreshToken,
        accountId: userId || undefined,
        expiresIn: poll.expiresIn,
        providerSpecificData: {
            authMethod: "device",
            userId: userId || "",
            email: userInfo.email || "",
            name: userInfo.name || "",
            organizationId: userInfo.organizationId || ""
        }
    });
    return c.json({ status: AuthPollStatus.OK, provider: stored });
}

oauthRoutes.get("/qoder/poll", requireAdmin, pollQoderDevice);
oauthRoutes.post("/qoder/poll", requireAdmin, pollQoderDevice);

// ---------------------------------------------------------------------------
// POST /v1/auth/:provider/token — direct token import (portable).
// ---------------------------------------------------------------------------

oauthRoutes.post("/:provider/token", requireAdmin, async (c) => {
    const raw = c.req.param("provider") ?? "";
    const provider = authProviderIdOf(raw);

    if (!TOKEN_IMPORT_PROVIDERS.has(provider)) {
        return apiError(c, 400, `Token import not supported for provider "${raw}"`, "unknown_provider");
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
