// Provider registry: builds executors from D1 account rows.
//
// Each `providers` row holds its secrets in `secrets_enc` (AES-GCM envelope).
// This module decrypts them into a DecryptedAccount and instantiates the
// matching vendored/new executor. Executors are constructed per request from
// the account pool — no long-lived in-memory registry (Workers are stateless);
// round-robin and circuit-breaker state live in the RouterState DO.

import type { Env } from "../env.js";
import type { AIProvider, ModelObject } from "../vendor/types/index.js";
import { AntigravityExecutor } from "../vendor/executors/antigravity.js";
import { QoderExecutor, type QoderProviderSpecificData } from "../vendor/executors/qoder.js";
import { CodexExecutor } from "../vendor/executors/codex.js";
import { CommandCodeExecutor } from "../vendor/executors/commandcode.js";
import { OpenAIExecutor } from "../vendor/executors/openai.js";
import { GrokCliExecutor } from "./grokcli.js";
import { GeminiCliAdapter } from "./geminicli.js";
import { decryptSecretsObject } from "../crypto/secretbox.js";
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
    enabled: number;
}

interface StoredSecrets {
    api_key?: string;
    access_token?: string;
    refresh_token?: string;
    extra?: Record<string, unknown>;
}

/** Provider types with a working Phase 1 executor. */
export const SUPPORTED_PROVIDERS = [
    "antigravity",
    "qoder",
    "openai_codex",
    "commandcode",
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
    "gemini-cli": "gemini-cli"
};

export function providerAlias(providerType: string, rowAlias?: string | null): string {
    return rowAlias || PROVIDER_ALIASES[providerType] || providerType;
}

function buildExecutor(
    account: DecryptedAccount
): AIProvider | GeminiCliAdapter | GrokCliExecutor {
    const common = {
        id: account.id,
        name: account.name,
        baseUrl: account.baseUrl || undefined,
        apiKey: account.apiKey,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        accountId: account.accountId
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
        enabled: row.enabled === 1
    };
}

/** Load all enabled accounts from D1 and decrypt them. */
export async function loadAccounts(db: D1Database, masterKeyB64: string): Promise<DecryptedAccount[]> {
    const res = await db
        .prepare("SELECT * FROM providers WHERE enabled = 1")
        .all<ProviderRow>();
    const accounts: DecryptedAccount[] = [];
    for (const row of res.results ?? []) {
        try {
            accounts.push(await decryptAccount(row, masterKeyB64));
        } catch (err) {
            // A corrupt envelope must not take down routing for healthy accounts.
            console.error(`Skipping account ${row.id}: failed to decrypt secrets`);
        }
    }
    return accounts;
}

/** An account plus its ready executor, for the request path. */
export interface RoutedAccount {
    account: DecryptedAccount;
    adapter: ProviderAdapter;
}

export function buildAdapter(account: DecryptedAccount): ProviderAdapter {
    const executor = buildExecutor(account);
    return asAdapter(executor as AIProvider, account.id);
}

/**
 * Find candidate accounts for a model id.
 * Matches "<prefix>/<rest>" against each account's routing prefixes
 * (provider type + alias), mirroring SRouter's prefix routing. Bare model ids
 * (no prefix) match accounts whose listModels() advertises them — resolved by
 * the caller via the DO-cached model list.
 */
export function candidateAccountsForPrefix(
    model: string,
    accounts: DecryptedAccount[]
): DecryptedAccount[] {
    const slash = model.indexOf("/");
    if (slash < 0) return [];
    const prefix = model.slice(0, slash).toLowerCase();
    return accounts.filter((a) =>
        routingPrefixes(a.providerType, providerAlias(a.providerType, a.alias)).some(
            (p) => p.toLowerCase() === prefix
        )
    );
}

/** Strip the "<prefix>/" routing prefix before handing the model to upstream. */
export function stripRoutingPrefix(model: string, account: DecryptedAccount): string {
    const prefixes = routingPrefixes(
        account.providerType,
        providerAlias(account.providerType, account.alias)
    );
    for (const p of prefixes) {
        if (model.toLowerCase().startsWith(p.toLowerCase() + "/")) {
            return model.slice(p.length + 1);
        }
    }
    return model;
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
