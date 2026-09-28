// Stealth request fingerprints: per-provider header presets that make upstream
// requests look like they come from each provider's official client.
//
// Adapted from vane's three-layer header system (internal/proxy/headers.go):
//   1. Provider preset defaults (this file)
//   2. Operator-level overrides (STEALTH_HEADER_OVERRIDES env, JSON object)
//   3. Per-credential custom_headers from the providers D1 row (wins)
//
// Auth headers (Authorization, x-goog-api-key, etc.) are NEVER part of stealth:
// they are set last by each executor and always win. Stealth is purely additive
// fingerprinting — it fills in client-identity headers, never credentials.

/** Headers that stealth must never set or override. Executors own these. */
const PROTECTED_HEADERS = new Set(
    [
        "authorization",
        "x-goog-api-key",
        "x-goog-api-client",
        "proxy-authorization",
        "cookie",
        "set-cookie"
    ].map((h) => h.toLowerCase())
);

/**
 * Per-provider fingerprint presets, harvested from the official clients each
 * executor mimics. Values mirror what the executors already send so default
 * behavior is unchanged — this centralizes them and fills gaps (e.g. the
 * generic "SRouter/1.0.0" User-Agent on openai-compatible).
 */
export const PROVIDER_FINGERPRINTS: Record<string, Record<string, string>> = {
    "grok-cli": {
        "User-Agent": "grok-shell/0.2.99 (linux; x86_64)",
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-version": "0.2.99",
        "x-grok-client-identifier": "grok-shell"
    },
    antigravity: {
        "User-Agent": "antigravity/ide/2.1.1 darwin/arm64"
    },
    qoder: {
        "User-Agent": "qodercli/1.0.0",
        "Cosy-Version": "1.0.0",
        "Cosy-ClientType": "5"
    },
    openai_codex: {
        "User-Agent": "codex_cli_rs/0.136.0",
        originator: "codex_cli_rs"
    },
    anthropic: {
        "User-Agent": "claude-cli/2.1.92 (external, sdk-cli)",
        "X-App": "cli",
        "Anthropic-Dangerous-Direct-Browser-Access": "true",
        "X-Stainless-Helper-Method": "stream",
        "X-Stainless-Retry-Count": "0",
        "X-Stainless-Runtime-Version": "v24.14.0",
        "X-Stainless-Package-Version": "0.80.0",
        "X-Stainless-Runtime": "node",
        "X-Stainless-Lang": "js",
        "X-Stainless-Arch": "arm64",
        "X-Stainless-Os": "MacOS",
        "X-Stainless-Timeout": "600"
    },
    cline: {
        "User-Agent": "Cline/3.0.62",
        "HTTP-Referer": "https://cline.bot",
        "X-Title": "Cline",
        "X-IS-MULTIROOT": "false",
        "X-CLIENT-TYPE": "cline-sdk",
        "X-CLIENT-VERSION": "3.0.62",
        "X-PLATFORM": "cli",
        "X-PLATFORM-VERSION": "3.0.62",
        "X-CORE-VERSION": "0.0.83"
    },
    codebuddy: {
        "User-Agent": "IDE/2.108.1 CodeBuddy/2.108.1",
        "X-Product": "SaaS",
        "x-requested-with": "XMLHttpRequest",
        "x-codebuddy-request": "1"
    },
    "codebuddy-cn": {
        "User-Agent": "CLI/2.96.0 CodeBuddy/2.96.0",
        "X-Product": "SaaS",
        "x-requested-with": "XMLHttpRequest",
        "x-codebuddy-request": "1"
    },
    kiro: {
        "User-Agent": "kiro-cli/0.1.0 (linux; x86_64)"
    },
    atria: {
        "User-Agent": "Atria/1.0",
        Accept: "application/json"
    },
    commandcode: {
        "User-Agent": "CommandCode/1.0"
    },
    // Thin OpenAI-compatible wrappers: keep a neutral fingerprint. Operators
    // can override per-credential via custom_headers.
    bai: { "User-Agent": "SRouter/1.0" },
    opencode_zen: { "User-Agent": "SRouter/1.0" },
    tokenrouter: { "User-Agent": "SRouter/1.0" },
    tokenharbor: { "User-Agent": "SRouter/1.0" },
    tabitoken: { "User-Agent": "SRouter/1.0" },
    gorouter: { "User-Agent": "SRouter/1.0" },
    orcarouter: { "User-Agent": "SRouter/1.0" },
    gmicloud: { "User-Agent": "SRouter/1.0" },
    genspark: { "User-Agent": "SRouter/1.0" },
    experientiallabs: { "User-Agent": "SRouter/1.0" },
    minimax: { "User-Agent": "SRouter/1.0" },
    neosantara: { "User-Agent": "SRouter/1.0" },
    "openai-compatible": { "User-Agent": "SRouter/1.0" },
    "gemini-cli": {
        "User-Agent": "gemini-cli/0.1.0 (linux; x86_64)"
    }
};

/** Strip any protected (credential-bearing) headers from a stealth map. */
export function sanitizeStealthHeaders(
    headers: Record<string, string> | undefined | null
): Record<string, string> {
    const out: Record<string, string> = {};
    if (!headers || typeof headers !== "object") return out;
    for (const [k, v] of Object.entries(headers)) {
        if (typeof v !== "string") continue;
        if (PROTECTED_HEADERS.has(k.toLowerCase())) continue;
        out[k] = v;
    }
    return out;
}

/**
 * Resolve the stealth header map for a provider account (vane's 3-layer merge):
 *   preset -> operator overrides -> per-credential custom_headers.
 * Later layers win. Protected headers are stripped at every layer.
 */
export function resolveStealthHeaders(
    providerType: string,
    perCredential?: Record<string, string> | null,
    operatorOverrides?: Record<string, string> | null
): Record<string, string> {
    const preset = PROVIDER_FINGERPRINTS[providerType] ?? {};
    return {
        ...sanitizeStealthHeaders(preset),
        ...sanitizeStealthHeaders(operatorOverrides),
        ...sanitizeStealthHeaders(perCredential)
    };
}

/**
 * Parse the STEALTH_HEADER_OVERRIDES env var (JSON object, optional).
 * Shape: { "<providerType>": { "Header": "value" }, ... } or a flat
 * { "Header": "value" } applied to all providers.
 */
export function parseOperatorOverrides(
    raw: string | undefined | null
): { perProvider: Record<string, Record<string, string>>; global: Record<string, string> } {
    const empty = { perProvider: {}, global: {} };
    if (!raw || !raw.trim()) return empty;
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const perProvider: Record<string, Record<string, string>> = {};
        const global: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (v && typeof v === "object" && !Array.isArray(v)) {
                perProvider[k] = sanitizeStealthHeaders(v as Record<string, string>);
            } else if (typeof v === "string") {
                const s = sanitizeStealthHeaders({ [k]: v });
                Object.assign(global, s);
            }
        }
        return { perProvider, global };
    } catch {
        return empty;
    }
}

/**
 * Merge stealth headers into an executor's header map.
 *
 * Precedence (lowest to highest):
 *   1. stealth.preset — provider preset + operator overrides (fills gaps)
 *   2. executorDefaults — the executor's own hardcoded headers
 *   3. stealth.perCredential — per-account custom_headers (always wins)
 *
 * Auth headers must be set by the caller AFTER this returns — they always win
 * and are never part of stealth (see PROTECTED_HEADERS).
 */
export function applyStealth(
    executorDefaults: Record<string, string>,
    stealth?: StealthHeaders | null
): Record<string, string> {
    if (!stealth) return { ...executorDefaults };
    return {
        ...sanitizeStealthHeaders(stealth.preset),
        ...executorDefaults,
        ...sanitizeStealthHeaders(stealth.perCredential)
    };
}

/** Stealth header bundle passed from the registry to each executor. */
export interface StealthHeaders {
    /** Provider preset + operator overrides. Fills gaps in executor defaults. */
    preset: Record<string, string>;
    /** Per-credential custom_headers from the providers D1 row. Wins over all. */
    perCredential?: Record<string, string> | null;
}

/**
 * Build the StealthHeaders bundle for an account.
 * Pure helper so the registry stays thin.
 */
export function stealthForAccount(
    providerType: string,
    perCredential?: Record<string, string> | null,
    operatorOverrides?: Record<string, string> | null
): StealthHeaders {
    return {
        preset: resolveStealthHeaders(providerType, null, operatorOverrides),
        perCredential: sanitizeStealthHeaders(perCredential)
    };
}
