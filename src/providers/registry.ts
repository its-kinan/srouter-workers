// Provider registry: builds executors from D1 account rows.
//
// Each `providers` row holds its secrets in `secrets_enc` (AES-GCM envelope).
// This module decrypts them into a DecryptedAccount and instantiates the
// matching vendored/new executor. Executors are constructed per request from
// the account pool — no long-lived in-memory registry (Workers are stateless);
// round-robin and circuit-breaker state live in the SwitchState DO.

import type { Env } from "../env.js";
import type { AIProvider, ModelObject } from "../vendor/types/index.js";
import { AntigravityExecutor } from "../vendor/executors/antigravity.js";
import { QoderExecutor, type QoderProviderSpecificData } from "../vendor/executors/qoder.js";
import { CodexExecutor } from "../vendor/executors/codex.js";
import { CommandCodeExecutor } from "../vendor/executors/commandcode.js";
import { OpenAIExecutor } from "../vendor/executors/openai.js";
import {
    AtriaExecutor,
    BAIExecutor,
    ExperientialLabsExecutor,
    GensparkExecutor,
    GMICloudExecutor,
    GoRouterExecutor,
    MiniMaxExecutor,
    NeosantaraExecutor,
    OpenCodeZenExecutor,
    OrcaRouterExecutor,
    TabiTokenExecutor,
    TokenHarborExecutor,
    TokenRouterExecutor
} from "../vendor/executors/thin.js";
import { AnthropicExecutor } from "../vendor/executors/anthropic.js";
import { ClineExecutor } from "../vendor/executors/cline.js";
import { KiroExecutor, type KiroProviderSpecificData } from "../vendor/executors/kiro.js";
import { CodeBuddyExecutor } from "../vendor/executors/codebuddy.js";
import { GrokCliExecutor } from "./grokcli.js";
import { GeminiCliAdapter } from "./geminicli.js";
import { decryptSecretsObject } from "../crypto/secretbox.js";
import {
    parseOperatorOverrides,
    stealthForAccount,
    type StealthHeaders
} from "./fingerprints.js";
import {
    asAdapter,
    routingPrefixes,
    type DecryptedAccount,
    type ProviderAdapter
} from "./types.js";

export interface ProviderRow {
    id: string;
    provider_id: string;
    name: string;
    alias: string | null;
    category: string;
    protocol: string;
    base_url: string | null;
    secrets_enc: string | null;
    account_id: string | null;
    organization_id: string | null;
    provider_specific_data: string | null;
    custom_headers: string | null;
    token_expires_at: number | null;
    last_refreshed_at: number | null;
    enabled: number;
}

interface StoredSecrets {
    api_key?: string;
    access_token?: string;
    refresh_token?: string;
    extra?: Record<string, unknown>;
}

/** Provider types with a working executor. */
export const SUPPORTED_PROVIDERS = [
    "antigravity",
    "qoder",
    "openai_codex",
    "commandcode",
    "atria",
    "bai",
    "opencode_zen",
    "tokenrouter",
    "tokenharbor",
    "tabitoken",
    "gorouter",
    "orcarouter",
    "gmicloud",
    "genspark",
    "experientiallabs",
    "minimax",
    "neosantara",
    "anthropic",
    "cline",
    "kiro",
    "codebuddy",
    "codebuddy-cn",
    "grok-cli",
    "gemini-cli",
    "openai-compatible"
] as const;

export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export function isSupportedProvider(t: string): t is SupportedProvider {
    return (SUPPORTED_PROVIDERS as readonly string[]).includes(t);
}

/** Aliases SRouter/9router users expect for model prefixes. */
const PROVIDER_ALIASES: Record<string, string> = {
    antigravity: "antigravity",
    qoder: "qd",
    openai_codex: "codex",
    commandcode: "commandcode",
    "grok-cli": "gcli",
    "gemini-cli": "gemini-cli",
    experientiallabs: "explabs",
    minimax: "minimax",
    neosantara: "neosantara",
    tokenharbor: "th",
    tokenrouter: "tre",
    tabitoken: "tb",
    gorouter: "gr",
    orcarouter: "orca",
    gmicloud: "gmi",
    genspark: "gs"
};

export function providerAlias(providerType: string, rowAlias?: string | null): string {
    return rowAlias || PROVIDER_ALIASES[providerType] || providerType;
}

function buildExecutor(
    account: DecryptedAccount,
    operatorOverrides?: Record<string, string> | null
): AIProvider | GeminiCliAdapter | GrokCliExecutor {
    // Stealth fingerprint bundle: provider preset (+ operator overrides) as
    // defaults, per-credential custom_headers winning over executor defaults.
    const stealth: StealthHeaders = stealthForAccount(
        account.providerType,
        account.customHeaders,
        operatorOverrides
    );
    const common = {
        id: account.id,
        name: account.name,
        baseUrl: account.baseUrl || undefined,
        apiKey: account.apiKey,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        accountId: account.accountId,
        stealth
    };
    switch (account.providerType) {
        case "antigravity":
            return new AntigravityExecutor({
                ...common,
                projectId: (account.extra.projectId as string | undefined) ?? account.accountId
            });
        case "qoder":
            return new QoderExecutor({
                ...common,
                providerSpecificData: account.extra as QoderProviderSpecificData
            });
        case "openai_codex":
            return new CodexExecutor(common);
        case "commandcode":
            return new CommandCodeExecutor(common);
        case "atria":
            return new AtriaExecutor(common);
        case "bai":
            return new BAIExecutor(common);
        case "opencode_zen":
            return new OpenCodeZenExecutor(common);
        case "tokenrouter":
            return new TokenRouterExecutor(common);
        case "tokenharbor":
            return new TokenHarborExecutor(common);
        case "tabitoken":
            return new TabiTokenExecutor(common);
        case "gorouter":
            return new GoRouterExecutor(common);
        case "orcarouter":
            return new OrcaRouterExecutor(common);
        case "gmicloud":
            return new GMICloudExecutor(common);
        case "genspark":
            return new GensparkExecutor(common);
        case "experientiallabs":
            return new ExperientialLabsExecutor(common);
        case "minimax":
            return new MiniMaxExecutor(common);
        case "neosantara":
            return new NeosantaraExecutor(common);
        case "anthropic":
            return new AnthropicExecutor(common);
        case "cline":
            return new ClineExecutor({
                ...common,
                refreshToken: account.refreshToken
            });
        case "kiro":
            return new KiroExecutor({
                ...common,
                refreshToken: account.refreshToken,
                providerSpecificData: account.extra as KiroProviderSpecificData
            });
        case "codebuddy":
        case "codebuddy-cn":
            return new CodeBuddyExecutor(common);
        case "grok-cli":
            return new GrokCliExecutor(common);
        case "gemini-cli":
            return new GeminiCliAdapter({
                ...common,
                projectId: account.extra.projectId as string | undefined
            });
        case "openai-compatible":
        default:
            return new OpenAIExecutor({
                ...common,
                alias: account.alias
            });
    }
}

/** Decrypt a provider row into a DecryptedAccount. */
export async function decryptAccount(
    row: ProviderRow,
    masterKeyB64: string
): Promise<DecryptedAccount> {
    let secrets: StoredSecrets = {};
    if (row.secrets_enc) {
        secrets = await decryptSecretsObject<StoredSecrets>(row.secrets_enc, masterKeyB64);
    }
    let extra: Record<string, unknown> = secrets.extra ?? {};
    if (row.provider_specific_data) {
        try {
            extra = { ...extra, ...JSON.parse(row.provider_specific_data) };
        } catch {
            // keep decrypted extra
        }
    }
    let customHeaders: Record<string, string> | undefined;
    if (row.custom_headers) {
        try {
            customHeaders = JSON.parse(row.custom_headers);
        } catch {
            customHeaders = undefined;
        }
    }
    return {
        id: row.id,
        providerType: row.provider_id,
        name: row.name,
        alias: row.alias ?? undefined,
        category: row.category === "oauth" ? "oauth" : "api_key",
        protocol: row.protocol,
        baseUrl: row.base_url ?? undefined,
        apiKey: secrets.api_key,
        accessToken: secrets.access_token,
        refreshToken: secrets.refresh_token,
        accountId: row.account_id ?? undefined,
        organizationId: row.organization_id ?? undefined,
        extra,
        customHeaders,
        enabled: row.enabled === 1,
        tokenExpiresAt: row.token_expires_at,
        lastRefreshedAt: row.last_refreshed_at
    };
}

/** Load all enabled accounts from D1 and decrypt them. */
export interface LoadAccountsOptions {
    /**
     * Only load/decrypt these provider types (e.g. ["tokenharbor"] for a
     * "th/<model>" request). Skips the other ~340 rows entirely.
     */
    providerTypes?: string[];
}

// --- Isolate-local decrypted-account cache ---
// loadAccounts() used to decrypt every enabled row on EVERY request. With
// ~342 accounts that was ~50ms+ of pure AES-GCM CPU per request on top of
// the DO round-trips — the main driver of Cloudflare 1102s under load.
// Now decrypted accounts are cached per isolate and the providers table is
// version-checked with one cheap aggregation query per request.
//
// Version tuple covers everything routing-relevant: row add/delete
// (COUNT/MAX(created_at)), enable/disable (SUM(enabled)). OAuth token
// refreshes intentionally do NOT invalidate: the previous token stays valid
// for up to the TTL, and ensureFreshToken() self-heals per request when a
// token is actually due. Admin edits (rename, custom headers) also settle
// within the TTL bound.
const ACCOUNT_CACHE_TTL_MS = 60_000;

interface AccountCacheEntry {
    accounts: DecryptedAccount[];
    version: string;
    loadedAt: number;
}

/** Cache key "" = full load; otherwise sorted provider list. */
const accountCaches = new Map<string, AccountCacheEntry>();
const accountCacheInflight = new Map<string, Promise<DecryptedAccount[]>>();

/** Lightweight hit/miss counters for cache observability (exposed via /health). */
export const accountCacheStats = { hits: 0, misses: 0 };

/**
 * Drop all isolate-local registry caches (tests only). Production isolates
 * never call this — the TTLs handle freshness.
 */
export function resetRegistryCachesForTests(): void {
    accountCaches.clear();
    accountCacheInflight.clear();
    cachedVersion = null;
}

// The version aggregation is the cheapest preamble read, but it was still a
// D1 round-trip on every loadAccounts() call — including cache hits. Throttle
// it to ~5s per isolate: worst case, a providers-table change takes ≤5s longer
// to be noticed (on top of the 60s account TTL).
const VERSION_CHECK_TTL_MS = 5_000;
let cachedVersion: { version: string; fetchedAt: number } | null = null;

async function providersVersion(db: D1Database): Promise<string> {
    const now = Date.now();
    if (cachedVersion && now - cachedVersion.fetchedAt < VERSION_CHECK_TTL_MS) {
        return cachedVersion.version;
    }
    const row = await db
        .prepare(
            `SELECT COUNT(*) AS n,
                    COALESCE(SUM(enabled), 0) AS e,
                    COALESCE(MAX(created_at), 0) AS c
             FROM providers`
        )
        .first<{ n: number; e: number; c: number }>();
    const version = `${row?.n ?? 0}:${row?.e ?? 0}:${row?.c ?? 0}`;
    cachedVersion = { version, fetchedAt: now };
    return version;
}

async function readAndDecryptAll(
    db: D1Database,
    masterKeyB64: string
): Promise<DecryptedAccount[]> {
    const res = await db
        .prepare("SELECT * FROM providers WHERE enabled = 1")
        .all<ProviderRow>();
    return decryptRows(res.results ?? [], masterKeyB64);
}

async function readAndDecryptSelective(
    db: D1Database,
    masterKeyB64: string,
    providerTypes: string[]
): Promise<DecryptedAccount[]> {
    const placeholders = providerTypes.map(() => "?").join(",");
    const res = await db
        .prepare(
            `SELECT * FROM providers WHERE enabled = 1 AND provider_id IN (${placeholders})`
        )
        .bind(...providerTypes)
        .all<ProviderRow>();
    return decryptRows(res.results ?? [], masterKeyB64);
}

async function decryptRows(
    rows: ProviderRow[],
    masterKeyB64: string
): Promise<DecryptedAccount[]> {
    // Chunked parallel decrypt: the old sequential await decrypted ~342 rows
    // one-by-one on cold start. 24-way concurrency cuts wall-clock time
    // without spiking isolate memory with 342 concurrent subtle ops.
    const CONCURRENCY = 24;
    const accounts: DecryptedAccount[] = [];
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
        const chunk = rows.slice(i, i + CONCURRENCY);
        const decrypted = await Promise.all(
            chunk.map(async (row): Promise<DecryptedAccount | null> => {
                try {
                    return await decryptAccount(row, masterKeyB64);
                } catch {
                    // A corrupt envelope must not take down routing for healthy accounts.
                    console.error(`Skipping account ${row.id}: failed to decrypt secrets`);
                    return null;
                }
            })
        );
        for (const account of decrypted) {
            if (account) accounts.push(account);
        }
    }
    return accounts;
}

export async function loadAccounts(
    db: D1Database,
    masterKeyB64: string,
    opts: LoadAccountsOptions = {}
): Promise<DecryptedAccount[]> {
    const types = opts.providerTypes?.length ? [...opts.providerTypes].sort() : [];
    const key = types.join(",");
    const now = Date.now();

    const cached = accountCaches.get(key);
    if (cached && now - cached.loadedAt < ACCOUNT_CACHE_TTL_MS) {
        // One cheap aggregation decides freshness; on match the 342
        // decryptions are skipped entirely.
        // B3: the version check itself is throttled (~5s) below, so a warm
        // isolate does ~zero D1 reads here, not one.
        if ((await providersVersion(db)) === cached.version) {
            cached.loadedAt = now; // extend the TTL while the table is quiet
            accountCacheStats.hits++;
            return cached.accounts;
        }
    }
    accountCacheStats.misses++;

    // Single-flight the reload so a cold isolate under burst doesn't
    // decrypt the table N times concurrently.
    let inflight = accountCacheInflight.get(key);
    if (!inflight) {
        inflight = (async () => {
            const version = await providersVersion(db);
            const accounts =
                types.length > 0
                    ? await readAndDecryptSelective(db, masterKeyB64, types)
                    : await readAndDecryptAll(db, masterKeyB64);
            accountCaches.set(key, { accounts, version, loadedAt: Date.now() });
            return accounts;
        })();
        accountCacheInflight.set(key, inflight);
        inflight.then(
            () => {
                if (accountCacheInflight.get(key) === inflight) {
                    accountCacheInflight.delete(key);
                }
            },
            () => {
                if (accountCacheInflight.get(key) === inflight) {
                    accountCacheInflight.delete(key);
                }
            }
        );
    }
    return inflight;
}

/**
 * Map a model routing prefix ("th", "tokenharbor") to its provider type,
 * using provider ids and their aliases. Returns undefined for unknown
 * prefixes (e.g. row-level custom aliases) — callers must full-load then.
 */
export function providerTypeForPrefix(prefix: string): string | undefined {
    const p = prefix.toLowerCase();
    for (const id of SUPPORTED_PROVIDERS) {
        if (id.toLowerCase() === p) return id;
    }
    for (const [id, alias] of Object.entries(PROVIDER_ALIASES)) {
        if (alias.toLowerCase() === p) return id;
    }
    return undefined;
}

/** An account plus its ready executor, for the request path. */
export interface RoutedAccount {
    account: DecryptedAccount;
    adapter: ProviderAdapter;
}

export function buildAdapter(
    account: DecryptedAccount,
    operatorOverrides?: Record<string, string> | null
): ProviderAdapter {
    const executor = buildExecutor(account, operatorOverrides);
    return asAdapter(executor as AIProvider, account.id);
}

/**
 * Account pinning: model ids may carry a "#selector" suffix to restrict
 * routing to a single account, e.g. "antigravity/gemini-flash#acc_abc123".
 * The pin is parsed from the LAST "#" (a model name could theoretically
 * contain one). An empty pin ("model#") is treated as no pin.
 */
export function parseAccountPin(model: string): { model: string; pin: string | null } {
    const hash = model.lastIndexOf("#");
    if (hash < 0) return { model, pin: null };
    const pin = model.slice(hash + 1).trim();
    if (!pin) return { model: model.slice(0, hash), pin: null };
    return { model: model.slice(0, hash), pin };
}

/**
 * Whether an account is selected by a pin. Account ids match exactly;
 * name and alias match case-insensitively (names are not unique, so all
 * name matches are kept by the caller).
 */
export function accountMatchesPin(account: DecryptedAccount, pin: string): boolean {
    if (account.id === pin) return true;
    const needle = pin.toLowerCase();
    if (account.name && account.name.toLowerCase() === needle) return true;
    if (account.alias && account.alias.toLowerCase() === needle) return true;
    return false;
}

/**
 * Find candidate accounts for a model id.
 * Matches "<prefix>/<rest>" against each account's routing prefixes
 * (provider type + alias), mirroring SRouter's prefix routing. Bare model ids
 * (no prefix) match accounts whose listModels() advertises them — resolved by
 * the caller via the DO-cached model list.
 *
 * When `pin` is set, only accounts selected by the pin are returned.
 */
export function candidateAccountsForPrefix(
    model: string,
    accounts: DecryptedAccount[],
    pin?: string | null
): DecryptedAccount[] {
    const slash = model.indexOf("/");
    if (slash < 0) return [];
    const prefix = model.slice(0, slash).toLowerCase();
    return accounts.filter(
        (a) =>
            routingPrefixes(a.providerType, providerAlias(a.providerType, a.alias)).some(
                (p) => p.toLowerCase() === prefix
            ) && (!pin || accountMatchesPin(a, pin))
    );
}

/**
 * Strip the "<prefix>/" routing prefix before handing the model to upstream.
 * The account-pin "#selector" suffix is stripped as well — it must never
 * leak upstream.
 */
export function stripRoutingPrefix(model: string, account: DecryptedAccount): string {
    const cleanModel = parseAccountPin(model).model;
    const prefixes = routingPrefixes(
        account.providerType,
        providerAlias(account.providerType, account.alias)
    );
    for (const p of prefixes) {
        if (cleanModel.toLowerCase().startsWith(p.toLowerCase() + "/")) {
            return cleanModel.slice(p.length + 1);
        }
    }
    return cleanModel;
}

/**
 * Per-account cap for listModels(). Promise.allSettled waits for EVERY
 * account, so one slow or hanging upstream (no fetch timeout in several
 * executors) used to stall the entire aggregation — observed 100s+ for
 * /v1/models, which then fails the request. A timed-out account is skipped
 * like any other listModels failure; its static fallback (if any) is lost
 * for this refresh, but the next refresh (or DO TTL expiry) retries it.
 */
export const LIST_MODELS_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
    });
}

/** Aggregate model list across accounts: "<alias>/<bareId>". */
export async function listAllModels(
    accounts: DecryptedAccount[],
    timeoutMs: number = LIST_MODELS_TIMEOUT_MS
): Promise<ModelObject[]> {
    const seen = new Set<string>();
    const out: ModelObject[] = [];
    const settled = await Promise.allSettled(
        accounts.map(async (a) => ({
            account: a,
            models: await withTimeout(
                buildAdapter(a).listModels(),
                timeoutMs,
                `listModels(${a.id})`
            )
        }))
    );
    for (const r of settled) {
        if (r.status !== "fulfilled") continue;
        const alias = providerAlias(r.value.account.providerType, r.value.account.alias);
        for (const m of r.value.models) {
            const bare = m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.id;
            const id = `${alias}/${bare}`;
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ id, object: "model", owned_by: alias });
        }
    }
    return out;
}
