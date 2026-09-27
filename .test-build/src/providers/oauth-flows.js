// Interactive OAuth flow clients for the Cloudflare Workers port.
// Ported from SRouter packages/providers/src/oauth/* (antigravity, claude,
// openai/codex, qoder, codebuddy, cline) with node:crypto replaced by
// WebCrypto. These power the dashboard's interactive login/device flows
// (GET /v1/auth/<provider>/login, /callback, /device, /poll).
//
// Public client IDs and endpoint URLs are copied from SRouter's public
// constants package. Client SECRETS are never hardcoded here — the
// Antigravity Google OAuth client secret comes from the
// ANTIGRAVITY_OAUTH_CLIENT_SECRET Worker secret.
export const AuthPollStatus = {
    PENDING: "pending",
    OK: "ok"
};
function base64UrlEncode(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++)
        s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** Generates PKCE code_verifier and S256 code_challenge (WebCrypto). */
export async function generatePKCE() {
    const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
    const stateBytes = crypto.getRandomValues(new Uint8Array(16));
    const codeVerifier = base64UrlEncode(verifierBytes);
    const state = base64UrlEncode(stateBytes);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
    const codeChallenge = base64UrlEncode(new Uint8Array(hash));
    return { codeVerifier, codeChallenge, state };
}
function buildQuery(params) {
    return Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&");
}
// ---------------------------------------------------------------------------
// Antigravity (Google OAuth)
// ---------------------------------------------------------------------------
export const ANTIGRAVITY_OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const ANTIGRAVITY_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const ANTIGRAVITY_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const ANTIGRAVITY_OAUTH_SCOPE = "openid profile email https://www.googleapis.com/auth/cloud-platform";
export const ANTIGRAVITY_OAUTH_PROMPT = "consent";
export class AntigravityOAuth {
    clientId;
    clientSecret;
    redirectUri;
    scope;
    authorizeUrl;
    tokenUrl;
    prompt;
    constructor(options = {}) {
        this.clientId = options.clientId ?? ANTIGRAVITY_OAUTH_CLIENT_ID;
        this.clientSecret = options.clientSecret;
        this.redirectUri = options.redirectUri ?? "";
        this.scope = options.scope ?? ANTIGRAVITY_OAUTH_SCOPE;
        this.authorizeUrl = options.authorizeUrl ?? ANTIGRAVITY_OAUTH_AUTHORIZE_URL;
        this.tokenUrl = options.tokenUrl ?? ANTIGRAVITY_OAUTH_TOKEN_URL;
        this.prompt = options.prompt ?? ANTIGRAVITY_OAUTH_PROMPT;
    }
    getAuthorizationUrl(pkce) {
        const params = {
            response_type: "code",
            client_id: this.clientId,
            redirect_uri: this.redirectUri,
            scope: this.scope,
            code_challenge: pkce.codeChallenge,
            code_challenge_method: "S256",
            state: pkce.state,
            access_type: "offline"
        };
        if (this.prompt)
            params.prompt = this.prompt;
        return `${this.authorizeUrl}?${buildQuery(params)}`;
    }
    async exchangeCodeForTokens(code, codeVerifier) {
        const params = {
            grant_type: "authorization_code",
            client_id: this.clientId,
            code,
            code_verifier: codeVerifier,
            redirect_uri: this.redirectUri
        };
        if (this.clientSecret)
            params.client_secret = this.clientSecret;
        const res = await fetch(this.tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(params)
        });
        if (!res.ok) {
            throw new Error(`Antigravity OAuth Exchange Failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
        }
        const data = (await res.json());
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            idToken: data.id_token,
            expiresIn: data.expires_in,
            tokenType: data.token_type ?? "Bearer"
        };
    }
}
// ---------------------------------------------------------------------------
// Claude Code OAuth
// ---------------------------------------------------------------------------
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const CLAUDE_OAUTH_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
export const CLAUDE_OAUTH_SCOPE = "org:create_api_key user:profile user:inference";
export class ClaudeOAuth {
    clientId;
    redirectUri;
    scope;
    authorizeUrl;
    tokenUrl;
    prompt;
    constructor(options = {}) {
        this.clientId = options.clientId ?? CLAUDE_OAUTH_CLIENT_ID;
        this.redirectUri = options.redirectUri ?? "";
        this.scope = options.scope ?? CLAUDE_OAUTH_SCOPE;
        this.authorizeUrl = options.authorizeUrl ?? CLAUDE_OAUTH_AUTHORIZE_URL;
        this.tokenUrl = options.tokenUrl ?? CLAUDE_OAUTH_TOKEN_URL;
        this.prompt = options.prompt;
    }
    getAuthorizationUrl(pkce) {
        const params = {
            response_type: "code",
            client_id: this.clientId,
            redirect_uri: this.redirectUri,
            scope: this.scope,
            code_challenge: pkce.codeChallenge,
            code_challenge_method: "S256",
            state: pkce.state
        };
        if (this.prompt)
            params.prompt = this.prompt;
        return `${this.authorizeUrl}?${buildQuery(params)}`;
    }
    async exchangeCodeForTokens(code, codeVerifier) {
        const res = await fetch(this.tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                grant_type: "authorization_code",
                client_id: this.clientId,
                code,
                code_verifier: codeVerifier,
                redirect_uri: this.redirectUri
            })
        });
        if (!res.ok) {
            throw new Error(`Claude OAuth Exchange Failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
        }
        const data = (await res.json());
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            idToken: data.id_token,
            expiresIn: data.expires_in,
            tokenType: data.token_type ?? "Bearer",
            organizationId: data.organization_id
        };
    }
}
// ---------------------------------------------------------------------------
// OpenAI Codex OAuth
// ---------------------------------------------------------------------------
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_OAUTH_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
export const CODEX_OAUTH_ORIGINATOR = "codex_cli_rs";
export class OpenAICodexOAuth {
    clientId;
    redirectUri;
    scope;
    authorizeUrl;
    tokenUrl;
    prompt;
    originator;
    constructor(options = {}) {
        this.clientId = options.clientId ?? CODEX_OAUTH_CLIENT_ID;
        this.redirectUri = options.redirectUri ?? "";
        this.scope = options.scope ?? CODEX_OAUTH_SCOPE;
        this.authorizeUrl = options.authorizeUrl ?? CODEX_OAUTH_AUTHORIZE_URL;
        this.tokenUrl = options.tokenUrl ?? CODEX_OAUTH_TOKEN_URL;
        this.prompt = options.prompt;
        this.originator = options.originator ?? CODEX_OAUTH_ORIGINATOR;
    }
    getAuthorizationUrl(pkce) {
        const params = {
            response_type: "code",
            client_id: this.clientId,
            redirect_uri: this.redirectUri,
            scope: this.scope,
            code_challenge: pkce.codeChallenge,
            code_challenge_method: "S256",
            state: pkce.state,
            id_token_add_organizations: "true",
            codex_cli_simplified_flow: "true",
            originator: this.originator
        };
        if (this.prompt)
            params.prompt = this.prompt;
        return `${this.authorizeUrl}?${buildQuery(params)}`;
    }
    async exchangeCodeForTokens(code, codeVerifier) {
        const res = await fetch(this.tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                client_id: this.clientId,
                code,
                code_verifier: codeVerifier,
                redirect_uri: this.redirectUri
            })
        });
        if (!res.ok) {
            throw new Error(`OpenAI OAuth Exchange Failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
        }
        const data = (await res.json());
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            idToken: data.id_token,
            expiresIn: data.expires_in,
            tokenType: data.token_type ?? "Bearer",
            accountId: data.chatgpt_account_id ||
                data.account_id ||
                extractAccountIdFromIdToken(data.id_token)
        };
    }
}
function extractAccountIdFromIdToken(idToken) {
    if (!idToken || typeof idToken !== "string")
        return undefined;
    const parts = idToken.split(".");
    if (parts.length < 2)
        return undefined;
    try {
        const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const payload = JSON.parse(atob(b64));
        return payload["https://api.openai.com/auth"]?.user_id || payload.user_id || payload.sub;
    }
    catch {
        return undefined;
    }
}
// ---------------------------------------------------------------------------
// Qoder (device-style flow via browser)
// ---------------------------------------------------------------------------
export const QODER_OPENAPI_BASE = "https://openapi.qoder.sh";
export const QODER_LOGIN_URL = "https://qoder.com/device/selectAccounts";
export const QODER_DEVICE_TOKEN_URL = `${QODER_OPENAPI_BASE}/api/v1/deviceToken/poll`;
export const QODER_USERINFO_URL = `${QODER_OPENAPI_BASE}/api/v1/userinfo`;
export class QoderOAuth {
    loginUrl;
    deviceTokenUrl;
    userInfoUrl;
    constructor(options = {}) {
        this.loginUrl = options.loginUrl ?? QODER_LOGIN_URL;
        this.deviceTokenUrl = options.deviceTokenUrl ?? QODER_DEVICE_TOKEN_URL;
        this.userInfoUrl = options.userInfoUrl ?? QODER_USERINFO_URL;
    }
    getAuthorizationUrl(pkce, machineId = "srouter-device") {
        const params = new URLSearchParams({
            challenge: pkce.codeChallenge,
            challenge_method: "S256",
            machine_id: machineId,
            nonce: pkce.state
        });
        return `${this.loginUrl}?${params.toString()}`;
    }
    async pollDeviceToken(params) {
        const url = `${this.deviceTokenUrl}?nonce=${encodeURIComponent(params.nonce)}&verifier=${encodeURIComponent(params.codeVerifier)}&challenge_method=S256`;
        const response = await fetch(url, {
            method: "GET",
            headers: { Accept: "application/json", "User-Agent": "qodercli/1.0.0" }
        });
        if (response.status === 202 || response.status === 404) {
            return { status: AuthPollStatus.PENDING };
        }
        if (!response.ok) {
            throw new Error(`Qoder device token poll failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
        }
        const body = (await response.json());
        if (!body.token) {
            throw new Error("Qoder device token poll returned empty token");
        }
        let expiresIn = 30 * 24 * 60 * 60;
        if (typeof body.expires_in === "number" && body.expires_in > 0) {
            expiresIn = body.expires_in;
        }
        else if (body.expires_at) {
            const parsed = typeof body.expires_at === "number" ? body.expires_at : Date.parse(body.expires_at);
            if (!Number.isNaN(parsed) && parsed > Date.now()) {
                expiresIn = Math.floor((parsed - Date.now()) / 1000);
            }
        }
        return {
            status: AuthPollStatus.OK,
            accessToken: body.token,
            refreshToken: body.refresh_token,
            userId: body.user_id,
            expiresIn
        };
    }
    async fetchUserInfo(accessToken) {
        try {
            const response = await fetch(this.userInfoUrl, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: "application/json",
                    "User-Agent": "qodercli/1.0.0"
                }
            });
            if (!response.ok)
                return { id: "", name: "", email: "", organizationId: "" };
            const body = (await response.json());
            return {
                id: body.id || body.userId || body.user_id || "",
                name: (body.name || body.username || "").trim(),
                email: (body.email || "").trim(),
                organizationId: (body.organization_id || "").trim()
            };
        }
        catch {
            return { id: "", name: "", email: "", organizationId: "" };
        }
    }
    async exchangeCodeForTokens(code, codeVerifier) {
        const poll = await this.pollDeviceToken({ nonce: code, codeVerifier });
        if (poll.status !== AuthPollStatus.OK || !poll.accessToken) {
            throw new Error("Qoder authorization is still pending or was denied");
        }
        const userInfo = await this.fetchUserInfo(poll.accessToken);
        return {
            accessToken: poll.accessToken,
            refreshToken: poll.refreshToken,
            expiresIn: poll.expiresIn,
            tokenType: "Bearer",
            accountId: poll.userId || userInfo.id
        };
    }
}
// ---------------------------------------------------------------------------
// CodeBuddy (device-style flow)
// ---------------------------------------------------------------------------
export const CODEBUDDY_AUTH_STATE_URL = "https://www.codebuddy.ai/v2/plugin/auth/state";
export const CODEBUDDY_AUTH_TOKEN_URL = "https://www.codebuddy.ai/v2/plugin/auth/token";
export const CODEBUDDY_AUTH_REFRESH_URL = "https://www.codebuddy.ai/v2/plugin/auth/token/refresh";
export const CODEBUDDY_AUTH_PLATFORM = "ide";
export const CODEBUDDY_AUTH_USER_AGENT = "IDE/2.63.2 CodeBuddy/2.63.2";
export const CODEBUDDY_CN_AUTH_STATE_URL = "https://copilot.tencent.com/v2/plugin/auth/state";
export const CODEBUDDY_CN_AUTH_TOKEN_URL = "https://copilot.tencent.com/v2/plugin/auth/token";
export const CODEBUDDY_CN_AUTH_REFRESH_URL = "https://copilot.tencent.com/v2/plugin/auth/token/refresh";
export const CODEBUDDY_CN_ORIGIN = "https://www.codebuddy.cn";
export const CODEBUDDY_CN_DOMAIN = "www.codebuddy.cn";
export const CODEBUDDY_CN_USER_AGENT = "CLI/2.96.0 CodeBuddy/2.96.0";
export class CodeBuddyOAuth {
    stateUrl;
    tokenUrl;
    refreshUrl;
    platform;
    userAgent;
    origin;
    domain;
    ioa;
    refreshBearer;
    constructor(options = {}) {
        this.stateUrl = options.stateUrl ?? CODEBUDDY_AUTH_STATE_URL;
        this.tokenUrl = options.tokenUrl ?? CODEBUDDY_AUTH_TOKEN_URL;
        this.refreshUrl = options.refreshUrl ?? CODEBUDDY_AUTH_REFRESH_URL;
        this.platform = options.platform ?? CODEBUDDY_AUTH_PLATFORM;
        this.userAgent = options.userAgent ?? CODEBUDDY_AUTH_USER_AGENT;
        this.origin = options.origin ?? "https://www.codebuddy.ai";
        this.domain = options.domain ?? new URL(this.origin).host;
        this.ioa = options.ioa ?? false;
        this.refreshBearer = options.refreshBearer ?? false;
    }
    async requestAuthState() {
        const params = new URLSearchParams({ platform: this.platform });
        if (this.ioa)
            params.set("ioa", "1");
        const url = `${this.stateUrl}?${params}`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                "User-Agent": this.userAgent,
                Origin: this.origin,
                Referer: `${this.origin}/`,
                "X-Requested-With": "XMLHttpRequest",
                "X-Domain": this.domain,
                "X-No-Authorization": "true",
                "X-No-User-Id": "true",
                "X-Product": "SaaS"
            },
            body: "{}"
        });
        if (!response.ok) {
            throw new Error(`CodeBuddy state request failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
        }
        const data = (await response.json());
        if (data.code !== 0 || !data.data?.state || !data.data?.authUrl) {
            throw new Error(`CodeBuddy state error: ${data.msg || "missing state/authUrl"}`);
        }
        return { state: data.data.state, authUrl: data.data.authUrl };
    }
    async pollToken(state) {
        const url = `${this.tokenUrl}?state=${encodeURIComponent(state)}`;
        const response = await fetch(url, {
            method: "GET",
            headers: {
                Accept: "application/json",
                "User-Agent": this.userAgent,
                Origin: this.origin,
                Referer: `${this.origin}/`,
                "X-Requested-With": "XMLHttpRequest",
                "X-Domain": this.domain,
                "X-No-Authorization": "true",
                "X-No-User-Id": "true",
                "X-No-Enterprise-Id": "true",
                "X-No-Department-Info": "true",
                "X-Product": "SaaS"
            }
        });
        if (response.status === 202 || response.status === 404) {
            return { status: AuthPollStatus.PENDING };
        }
        if (!response.ok) {
            return { status: AuthPollStatus.PENDING, error: `Request failed (${response.status})` };
        }
        const data = (await response.json());
        if (data.code === 0 && data.data?.accessToken) {
            return {
                status: AuthPollStatus.OK,
                accessToken: data.data.accessToken,
                refreshToken: data.data.refreshToken || "",
                expiresIn: data.data.expiresIn || 86400
            };
        }
        if (data.code === 11217) {
            return { status: AuthPollStatus.PENDING };
        }
        return { status: AuthPollStatus.PENDING, error: data.msg || "unknown_error" };
    }
}
export class CodeBuddyCNOAuth extends CodeBuddyOAuth {
    constructor(options = {}) {
        super({
            stateUrl: CODEBUDDY_CN_AUTH_STATE_URL,
            tokenUrl: CODEBUDDY_CN_AUTH_TOKEN_URL,
            refreshUrl: CODEBUDDY_CN_AUTH_REFRESH_URL,
            origin: CODEBUDDY_CN_ORIGIN,
            domain: CODEBUDDY_CN_DOMAIN,
            userAgent: CODEBUDDY_CN_USER_AGENT,
            platform: "CLI",
            ioa: true,
            refreshBearer: true,
            ...options
        });
    }
}
// ---------------------------------------------------------------------------
// Cline (WorkOS device flow)
// ---------------------------------------------------------------------------
export const CLINE_BASE_URL = "https://api.cline.bot/api/v1";
export const CLINE_API_ROOT = "https://api.cline.bot";
export const CLINE_WORKOS_BASE_URL = "https://api.workos.com";
export const CLINE_WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";
export class ClineOAuth {
    async requestDeviceAuthorization() {
        const response = await fetch(`${CLINE_WORKOS_BASE_URL}/user_management/authorize/device`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: CLINE_WORKOS_CLIENT_ID })
        });
        const data = (await response.json().catch(() => ({})));
        if (!response.ok || !data.device_code || !data.user_code || !data.verification_uri) {
            throw new Error(`Cline device authorization failed (${response.status})`);
        }
        return {
            deviceCode: data.device_code,
            userCode: data.user_code,
            verificationUri: data.verification_uri,
            verificationUriComplete: data.verification_uri_complete,
            expiresIn: data.expires_in ?? 300,
            interval: data.interval ?? 5
        };
    }
    async pollDeviceToken(deviceCode) {
        const response = await fetch(`${CLINE_WORKOS_BASE_URL}/user_management/authenticate`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                device_code: deviceCode,
                client_id: CLINE_WORKOS_CLIENT_ID
            })
        });
        const data = (await response.json().catch(() => ({})));
        if (!response.ok) {
            if (data.error === "authorization_pending" || data.error === "slow_down") {
                return { status: AuthPollStatus.PENDING };
            }
            return { status: AuthPollStatus.PENDING, error: data.error_description || data.error };
        }
        if (!data.access_token || !data.refresh_token) {
            return { status: AuthPollStatus.PENDING, error: "Invalid WorkOS token response" };
        }
        const registered = await fetch(`${CLINE_API_ROOT}/api/v1/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                accessToken: data.access_token,
                refreshToken: data.refresh_token
            })
        });
        const payload = (await registered.json().catch(() => ({})));
        const token = payload.data;
        if (!registered.ok || !payload.success || !token?.accessToken || !token.refreshToken) {
            return {
                status: AuthPollStatus.PENDING,
                error: `Cline token registration failed (${registered.status})`
            };
        }
        const expiresAt = token.expiresAt ? Date.parse(token.expiresAt) : NaN;
        return {
            status: AuthPollStatus.OK,
            accessToken: `workos:${token.accessToken}`,
            refreshToken: token.refreshToken,
            expiresIn: !Number.isNaN(expiresAt)
                ? Math.max(1, Math.floor((expiresAt - Date.now()) / 1000))
                : undefined,
            accountId: token.userInfo?.clineUserId ?? undefined,
            email: token.userInfo?.email,
            name: token.userInfo?.name
        };
    }
}
