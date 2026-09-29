// Regression tests for lazy per-account secret decryption: the hot request
// path works with plaintext metadata and decrypts secrets only for accounts
// that are actually attempted (the fix for 1102s on the 10ms CPU budget).
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    accountMatchesPin,
    candidateAccountsForPrefix,
    decryptAccountSecrets,
    loadAccountMetas,
    parseAccountPin,
    resetRegistryCachesForTests,
    stripRoutingPrefix,
    supportsImageGeneration,
    type AccountMeta,
    type ProviderRow
} from "../src/providers/registry.js";
import {
    encryptSecretsObject,
    generateMasterKey
} from "../src/crypto/secretbox.js";

// Isolate-local caches must not leak between tests.
beforeEach(() => resetRegistryCachesForTests());

function fakeRegistryDb(rows: ProviderRow[]) {
    const db = {
        prepare: (_sql: string) => {
            const stmt = {
                bind: (..._args: unknown[]) => stmt,
                first: async () => ({ n: rows.length, e: rows.length, c: 1 }),
                all: async () => ({ results: rows })
            };
            return stmt;
        }
    } as unknown as D1Database;
    return { db };
}

async function makeRow(
    id: string,
    providerId: string,
    masterKey: string,
    opts: { corrupt?: boolean; alias?: string } = {}
): Promise<ProviderRow> {
    return {
        id,
        provider_id: providerId,
        name: id,
        alias: opts.alias ?? null,
        category: "api_key",
        protocol: "openai",
        base_url: "https://example.com/v1",
        secrets_enc: opts.corrupt
            ? "definitely-not-a-valid-envelope"
            : await encryptSecretsObject({ api_key: "sk-test" }, masterKey),
        account_id: null,
        organization_id: null,
        provider_specific_data: null,
        custom_headers: null,
        token_expires_at: null,
        last_refreshed_at: null,
        enabled: 1
    };
}

describe("lazy per-account decrypt (registry.ts)", () => {
    it("loadAccountMetas returns plaintext metadata with zero secret decryptions", async () => {
        const masterKey = generateMasterKey();
        const rows = await Promise.all([
            makeRow("m1", "lazytest-a", masterKey),
            // Corrupt envelopes prove no decryption happens at discovery:
            // a decrypting loader would throw or silently drop this row,
            // but metadata must come back for every row.
            makeRow("m2", "lazytest-a", masterKey, { corrupt: true }),
            makeRow("m3", "lazytest-a", masterKey)
        ]);
        const { db } = fakeRegistryDb(rows);
        const metas = await loadAccountMetas(db, { providerTypes: ["lazytest-a"] });
        assert.equal(metas.length, 3);
        for (const m of metas) {
            assert.ok(m.secretsEnc, "meta keeps the encrypted envelope");
        }
        assert.ok(
            !JSON.stringify(metas).includes("sk-test"),
            "no decrypted secrets leak into metadata"
        );
    });

    it("decryptAccountSecrets decrypts exactly one account; the rest stay encrypted", async () => {
        const masterKey = generateMasterKey();
        const rows = await Promise.all([
            makeRow("d1", "lazytest-b", masterKey),
            makeRow("d2", "lazytest-b", masterKey),
            makeRow("d3", "lazytest-b", masterKey)
        ]);
        const { db } = fakeRegistryDb(rows);
        const metas = await loadAccountMetas(db, { providerTypes: ["lazytest-b"] });
        const first: AccountMeta = metas[0]!;
        const account = await decryptAccountSecrets(first, masterKey);
        assert.equal(account.id, "d1");
        assert.equal(account.apiKey, "sk-test");
        // The other metas were never decrypted: envelopes untouched.
        for (const m of metas.slice(1)) {
            assert.ok(m.secretsEnc && m.secretsEnc.length > 0);
            assert.ok(!m.secretsEnc.includes("sk-test"));
        }
        // A second decrypt of the same account hits the per-account cache.
        const again = await decryptAccountSecrets(first, masterKey);
        assert.equal(again, account, "per-account cache returns the same object");
    });

    it("a corrupt envelope fails only that account, never candidate discovery", async () => {
        const masterKey = generateMasterKey();
        const rows = await Promise.all([
            makeRow("c1", "lazytest-c", masterKey),
            makeRow("bad", "lazytest-c", masterKey, { corrupt: true })
        ]);
        const { db } = fakeRegistryDb(rows);
        const metas = await loadAccountMetas(db, { providerTypes: ["lazytest-c"] });
        // Discovery still sees both candidates — selection is metadata-only.
        assert.equal(metas.length, 2);
        await assert.rejects(
            decryptAccountSecrets(metas[1]!, masterKey),
            "corrupt envelope rejects at attempt time"
        );
        const ok = await decryptAccountSecrets(metas[0]!, masterKey);
        assert.equal(ok.apiKey, "sk-test");
    });

    it("selection helpers work on metadata alone: pin selects one account", async () => {
        const masterKey = generateMasterKey();
        const rows = await Promise.all([
            makeRow("p1", "tokenharbor", masterKey),
            makeRow("p2", "tokenharbor", masterKey)
        ]);
        const { db } = fakeRegistryDb(rows);
        const metas = await loadAccountMetas(db, { providerTypes: ["tokenharbor"] });
        // resolveModel() parses the pin out and passes it separately.
        // (Pin on the account id; the default "th" alias keeps the prefix match.)
        const { model: cleanModel, pin } = parseAccountPin("th/some-model#p1");
        const pinned = candidateAccountsForPrefix(cleanModel, metas, pin);
        assert.equal(pinned.length, 1);
        assert.equal(pinned[0]!.id, "p1");
        assert.ok(accountMatchesPin(pinned[0]!, "p1"));
        assert.equal(stripRoutingPrefix("th/some-model#p1", pinned[0]!), "some-model");
    });

    it("supportsImageGeneration is a static check — no decrypt, no adapter build", async () => {
        const masterKey = generateMasterKey();
        const rows = await Promise.all([
            makeRow("i1", "openai-compatible", masterKey),
            makeRow("i2", "tokenharbor", masterKey)
        ]);
        const { db } = fakeRegistryDb(rows);
        const metas = await loadAccountMetas(db);
        const byId = new Map(metas.map((m) => [m.id, m]));
        assert.equal(supportsImageGeneration(byId.get("i1")!), true);
        assert.equal(supportsImageGeneration(byId.get("i2")!), false);
    });
});
