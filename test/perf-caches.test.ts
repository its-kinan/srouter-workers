// Regression tests for the isolate-local caches (registry account cache,
// catalog isolate cache, api-key cache) and chunked parallel decrypt.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../src/env.js";
import {
    accountCacheStats,
    loadAccounts,
    resetRegistryCachesForTests,
    type ProviderRow
} from "../src/providers/registry.js";
import {
    encryptSecretsObject,
    generateMasterKey
} from "../src/crypto/secretbox.js";
import { lookupApiKey } from "../src/middleware/apiKeyAuth.js";
import { getModelCatalog } from "../src/router/catalog.js";

// Isolate-local caches must not leak between tests.
beforeEach(() => resetRegistryCachesForTests());

// --- fakes ---

function fakeRegistryDb(rows: ProviderRow[], version = { n: 3, e: 3, c: 1 }) {
    let prepareCalls = 0;
    const db = {
        prepare: (_sql: string) => {
            prepareCalls++;
            const stmt = {
                bind: (..._args: unknown[]) => stmt,
                first: async () => ({ ...version }),
                all: async () => ({ results: rows })
            };
            return stmt;
        }
    } as unknown as D1Database;
    return { db, prepareCalls: () => prepareCalls };
}

async function makeRow(
    id: string,
    providerId: string,
    masterKey: string,
    corrupt = false
): Promise<ProviderRow> {
    return {
        id,
        provider_id: providerId,
        name: id,
        alias: null,
        category: "api_key",
        protocol: "openai",
        base_url: "https://example.com/v1",
        secrets_enc: corrupt
            ? "definitely-not-a-valid-envelope"
            : await encryptSecretsObject({ apiKey: "sk-test" }, masterKey),
        account_id: null,
        organization_id: null,
        provider_specific_data: null,
        custom_headers: null,
        token_expires_at: null,
        last_refreshed_at: null,
        enabled: 1
    };
}

describe("account cache (registry.ts)", () => {
    it("second loadAccounts within TTL hits the isolate cache (zero D1 reads)", async () => {
        const masterKey = generateMasterKey();
        const rows = await Promise.all([
            makeRow("a1", "tokenharbor", masterKey),
            makeRow("a2", "tokenharbor", masterKey)
        ]);
        const { db, prepareCalls } = fakeRegistryDb(rows);
        const h0 = accountCacheStats.hits;
        const m0 = accountCacheStats.misses;

        // Distinct provider key per test so module-level caches don't interfere.
        const opts = { providerTypes: ["tokenharbor-cachetest"] };
        const first = await loadAccounts(db, masterKey, opts);
        assert.equal(first.length, 2);
        assert.equal(accountCacheStats.misses, m0 + 1);
        const callsAfterFirst = prepareCalls();
        assert.ok(callsAfterFirst > 0, "cold load should read D1");

        const second = await loadAccounts(db, masterKey, opts);
        assert.equal(second.length, 2);
        assert.equal(second, first, "cache hit returns the same array");
        assert.equal(accountCacheStats.hits, h0 + 1);
        assert.equal(
            prepareCalls(),
            callsAfterFirst,
            "warm load must not touch D1 at all (version check is throttled)"
        );
    });

    it("chunked decrypt skips corrupt rows without failing healthy accounts", async () => {
        const masterKey = generateMasterKey();
        // More rows than the decrypt concurrency chunk (24) to exercise chunking.
        const rows: ProviderRow[] = [];
        for (let i = 0; i < 30; i++) {
            rows.push(
                await makeRow(`ok-${i}`, "bai-chunktest", masterKey, i % 10 === 9)
            );
        }
        const { db } = fakeRegistryDb(rows);
        const accounts = await loadAccounts(db, masterKey, {
            providerTypes: ["bai-chunktest"]
        });
        // 3 of the 30 rows are corrupt (i = 9, 19, 29).
        assert.equal(accounts.length, 27);
        assert.ok(
            accounts.every((a) => a.id.startsWith("ok-")),
            "only healthy accounts are returned"
        );
    });
});

describe("api-key cache (apiKeyAuth.ts)", () => {
    it("second lookup within TTL reuses the cached row (one D1 read)", async () => {
        let queries = 0;
        const row = {
            id: "key_1",
            name: "test key",
            enabled: 1,
            rate_limit: 0,
            quota_limit: 0,
            usage_tokens: 0,
            credit_limit: 0,
            usage_cost: 0,
            allowed_models: null
        };
        const db = {
            prepare: (_sql: string) => {
                queries++;
                return {
                    bind: (_h: string) => ({
                        first: async () => ({ ...row })
                    })
                };
            }
        } as unknown as D1Database;

        const keyHash = `test-hash-${Date.now()}`;
        const first = await lookupApiKey(db, keyHash);
        assert.deepEqual(first, row);
        assert.equal(queries, 1);
        const second = await lookupApiKey(db, keyHash);
        assert.deepEqual(second, row, "cached row preserves auth fields");
        assert.equal(second, first, "same object reference from cache");
        assert.equal(queries, 1, "warm lookup must not re-query D1");
    });
});

describe("catalog isolate cache (catalog.ts)", () => {
    it("second getModelCatalog within TTL avoids the DO fetch", async () => {
        let doFetches = 0;
        const models = [{ id: "th/foo", object: "model", created: 1, owned_by: "t" }];
        const env = {
            DB: {},
            MASTER_KEY: "x",
            ROUTER_STATE: {
                getByName: (_name: string) => ({
                    fetch: async (_req: Request) => {
                        doFetches++;
                        return Response.json({ models, cachedAt: Date.now() });
                    }
                })
            }
        } as unknown as Env;

        const first = await getModelCatalog(env);
        assert.deepEqual(first, models);
        assert.equal(doFetches, 1);
        const second = await getModelCatalog(env);
        assert.deepEqual(second, models);
        assert.equal(doFetches, 1, "warm call must not hit the DO again");
    });
});
