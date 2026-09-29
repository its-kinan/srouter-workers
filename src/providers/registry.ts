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

/**
 * Plaintext account metadata — everything routing needs EXCEPT secrets.
 * Loading this is cheap (D1 reads + JSON.parse, no AES-GCM), so the hot
 * request path works with metas and decrypts secrets lazily, per attempted
 * account, via decryptAccountSecrets().
 *
 * All non-identifier fields are optional so a DecryptedAccount remains
 * structurally assignable (selection helpers accept either).
 */
export interface AccountMeta {
    id: string;
    providerType: string;
    name: string;
    alias?: string;
    category: "oauth" | "api_key";
    protocol: string;
    baseUrl?: string;
    accountId?: string;
    organizationId?: string;
    customHeaders?: Record<string, string>;
    /** Parsed plaintext provider_specific_data (secrets.extra merges at decrypt). */
    publicExtra?: Record<string, unknown>;
    enabled: boolean;
    tokenExpiresAt?: number | null;
    lastRefreshedAt?: number | null;
    /** Encrypted secrets envelope — decrypted lazily per attempt. */
    secretsEnc?: string | null;
}

/** Build plaintext metadata from a row — no decryption, minimal CPU. */
export function metaForRow(row: ProviderRow): AccountMeta {
    let publicExtra: Record<string, unknown> | undefined;
    if (row.provider_specific_data) {
        try {
            publicExtra = JSON.parse(row.provider_specific_data) as Record<string, unknown>;
        } catch {
            publicExtra = undefined;
        }
    }
    let customHeaders: Record<string, string> | undefined;
    if (row.custom_headers) {
        try {
            customHeaders = JSON.parse(row.custom_headers) as Record<string, string>;
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
        accountId: row.account_id ?? undefined,
        organizationId: row.organization_id ?? undefined,
        customHeaders,
        publicExtra,
        enabled: row.enabled === 1,
        tokenExpiresAt: row.token_expires_at,
        lastRefreshedAt: row.last_refreshed_at,
        secretsEnc: row.secrets_enc
    };
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
    return decryptMeta(metaForRow(row), masterKeyB64);
}

/**
 * Decrypt an AccountMeta's secrets into a full DecryptedAccount.
 * Plaintext fields come from the meta; secrets.extra merges under the
 * plaintext provider_specific_data (same precedence as decryptAccount).
 * Throws on a corrupt/missing envelope — callers that must tolerate bad
 * rows (catalog) catch per-account.
 */
export async function decryptMeta(
    meta: AccountMeta,
    masterKeyB64: string
): Promise<DecryptedAccount> {
    let secrets: StoredSecrets = {};
    if (meta.secretsEnc) {
        secrets = await decryptSecretsObject<StoredSecrets>(meta.secretsEnc, masterKeyB64);
    }
    const extra: Record<string, unknown> = {
        ...secrets.extra,
        ...(meta.publicExtra ?? {})
    };
    return {
        id: meta.id,
        providerType: meta.providerType,
        name: meta.name,
        alias: meta.alias,
        category: meta.category,
        protocol: meta.protocol,
        baseUrl: meta.baseUrl,
        apiKey: secrets.api_key,
        accessToken: secrets.access_token,
        refreshToken: secrets.refresh_token,
        accountId: meta.accountId,
        organizationId: meta.organizationId,
        extra,
        customHeaders: meta.customHeaders,
        enabled: meta.enabled,
        tokenExpiresAt: meta.tokenExpiresAt,
        lastRefreshedAt: meta.lastRefreshedAt,
        secretsEnc: meta.secretsEnc
    };
}

/** Load account metadata (no secrets) — the hot-path loader. */
export interface LoadAccountsOptions {
    /**
     * Only load these provider types (e.g. ["tokenharbor"] for a
     * "th/<model>" request). Skips the other ~340 rows entirely.
     */
    providerTypes?: string[];
}

// --- Isolate-local account-metadata cache ---
// The request path used to decrypt every enabled row on EVERY cold request.
// With ~342 accounts that was ~50ms+ of pure AES-GCM CPU — the main driver
// of Cloudflare 1102s ("Worker exceeded resource limits", surfaced as 503)
// on the Free plan's 10ms CPU budget. Now only plaintext metadata is loaded
// and cached per isolate; secrets are decrypted lazily per attempted
// account via decryptAccountSecrets() — typically 1 decrypt (~0.1ms)
// instead of ~342 (~50ms).
//
// Version tuple covers everything routing-relevant: row add/delete
// (COUNT/MAX(created_at)), enable/disable (SUM(enabled)). OAuth token
// refreshes intentionally do NOT invalidate: the previous token stays valid
// for up to the TTL, and ensureFreshToken() self-heals per request when a
// token is actually due. Admin edits (rename, custom headers) also settle
// within the TTL bound.
const ACCOUNT_CACHE_TTL_MS = 60_000;

interface AccountCacheEntry {
    metas: AccountMeta[];
    version: string;
    loadedAt: number;
    /**
     * Memoized fully-decrypted array for loadAccounts(). Same cache-hit
     * contract as before: repeat calls within the TTL return the same
     * array instance. Keyed on master key so tests with distinct keys
     * can't cross-contaminate.
     */
    decryptedByKey?: { masterKey: string; accounts: DecryptedAccount[] };
}

function metaCacheKey(opts: LoadAccountsOptions): string {
    const types = opts.providerTypes?.length ? [...opts.providerTypes].sort() : [];
    return types.join(",");
}

/** Cache key "" = full load; otherwise sorted provider list. */
const metaCaches = new Map<string, AccountCacheEntry>();
const metaCacheInflight = new Map<string, Promise<AccountMeta[]>>();

/** Lightweight hit/miss counters for cache observability (exposed via /health). */
export const accountCacheStats = { hits: 0, misses: 0 };

/**
 * Per-account decrypted-secrets cache. A request that fails over across N
 * accounts decrypts each once; the 60s TTL matches the metadata cache so a
 * providers-table change (which bumps the version and reloads metas) also
 * drops any secrets decrypted from the old rows.
 */
const SECRET_CACHE_TTL_MS = 60_000;
const secretCache = new Map<string, { account: DecryptedAccount; cachedAt: number }>();

/**
 * Drop all isolate-local registry caches (tests only). Production isolates
 * never call this — the TTLs handle freshness.
 */
export function resetRegistryCachesForTests(): void {
    metaCaches.clear();
    metaCacheInflight.clear();
    secretCache.clear();
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

async function readMetas(
    db: D1Database,
    providerTypes: string[]
): Promise<AccountMeta[]> {
    let res;
    if (providerTypes.length > 0) {
        const placeholders = providerTypes.map(() => "?").join(",");
        res = await db
            .prepare(
                `SELECT * FROM providers WHERE enabled = 1 AND provider_id IN (${placeholders})`
            )
            .bind(...providerTypes)
            .all<ProviderRow>();
    } else {
        res = await db.prepare("SELECT * FROM providers WHERE enabled = 1").all<ProviderRow>();
    }
    return (res.results ?? []).map(metaForRow);
}

/**
 * Load plaintext account metadata for the hot request path. No AES-GCM —
 * a cold isolate pays two D1 round-trips (version + rows) and JSON.parse,
 * ~1-3ms of CPU instead of ~50ms of decryption.
 */
export async function loadAccountMetas(
    db: D1Database,
    opts: LoadAccountsOptions = {}
): Promise<AccountMeta[]> {
    const key = metaCacheKey(opts);
    const now = Date.now();

    const cached = metaCaches.get(key);
    if (cached && now - cached.loadedAt < ACCOUNT_CACHE_TTL_MS) {
        // One cheap aggregation decides freshness; on match the D1 row
        // read is skipped entirely.
        // B3: the version check itself is throttled (~5s) below, so a warm
        // isolate does ~zero D1 reads here, not one.
        if ((await providersVersion(db)) === cached.version) {
            cached.loadedAt = now; // extend the TTL while the table is quiet
            accountCacheStats.hits++;
            return cached.metas;
        }
    }
    accountCacheStats.misses++;

    // Single-flight the reload so a cold isolate under burst doesn't
    // read the table N times concurrently.
    let inflight = metaCacheInflight.get(key);
    if (!inflight) {
        inflight = (async () => {
            const version = await providersVersion(db);
            const metas = await readMetas(db, key.length > 0 ? key.split(",") : []);
            metaCaches.set(key, { metas, version, loadedAt: Date.now() });
            // Metas reloaded from new rows — drop secrets decrypted from
            // the old ones so a changed/disabled account can't linger.
            secretCache.clear();
            return metas;
        })();
        metaCacheInflight.set(key, inflight);
        inflight.then(
            () => {
                if (metaCacheInflight.get(key) === inflight) {
                    metaCacheInflight.delete(key);
                }
            },
            () => {
                if (metaCacheInflight.get(key) === inflight) {
                    metaCacheInflight.delete(key);
                }
            }
        );
    }
    return inflight;
}

/**
 * Decrypt one account's secrets, lazily, at attempt time. Results are
 * cached per isolate (60s) so failover across N accounts decrypts each
 * once. Throws on a corrupt/missing envelope — the request path treats
 * that as a per-account failure and moves to the next candidate.
 */
export async function decryptAccountSecrets(
    meta: AccountMeta,
    masterKeyB64: string
): Promise<DecryptedAccount> {
    const now = Date.now();
    const cached = secretCache.get(meta.id);
    if (cached && now - cached.cachedAt < SECRET_CACHE_TTL_MS) {
        return cached.account;
    }
    const account = await decryptMeta(meta, masterKeyB64);
    secretCache.set(meta.id, { account, cachedAt: now });
    return account;
}

/**
 * Load all enabled accounts WITH secrets decrypted (catalog rebuild,
 * admin views). Preserves the old chunked parallel decrypt: 24-way
 * concurrency cuts wall-clock time without spiking isolate memory, and a
 * corrupt envelope skips just that account instead of failing the load.
 * Prefer loadAccountMetas() + decryptAccountSecrets() on the request path.
 */
export async function loadAccounts(
    db: D1Database,
    masterKeyB64: string,
    opts: LoadAccountsOptions = {}
): Promise<DecryptedAccount[]> {
    const metas = await loadAccountMetas(db, opts);
    // Cache-hit contract: repeat loads within the TTL return the same
    // array instance (perf-caches.test.ts pins this).
    const entry = metaCaches.get(metaCacheKey(opts));
    const memo = entry?.decryptedByKey;
    if (memo && memo.masterKey === masterKeyB64) return memo.accounts;
    const CONCURRENCY = 24;
    const accounts: DecryptedAccount[] = [];
    for (let i = 0; i < metas.length; i += CONCURRENCY) {
        const chunk = metas.slice(i, i + CONCURRENCY);
        const decrypted = await Promise.all(
            chunk.map(async (meta): Promise<DecryptedAccount | null> => {
                try {
                    return await decryptAccountSecrets(meta, masterKeyB64);
                } catch {
                    // A corrupt envelope must not take down routing for healthy accounts.
                    console.error(`Skipping account ${meta.id}: failed to decrypt secrets`);
                    return null;
                }
            })
        );
        for (const account of decrypted) {
            if (account) accounts.push(account);
        }
    }
    if (entry) entry.decryptedByKey = { masterKey: masterKeyB64, accounts };
    return accounts;
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

/**
 * Static image-generation capability check — no secrets needed. Only the
 * OpenAI-compatible executor implements generateImage; checking the
 * provider type avoids building (and decrypting for) every adapter.
 */
export function supportsImageGeneration(meta: AccountMeta): boolean {
    return meta.providerType === "openai-compatible";
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
export function accountMatchesPin(account: AccountMeta, pin: string): boolean {
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
    accounts: AccountMeta[],
    pin?: string | null
): AccountMeta[] {
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
export function stripRoutingPrefix(model: string, account: AccountMeta): string {
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
