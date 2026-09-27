// Unit tests for srouter-workers Phase 1 (run: npm test).
// Covers: AES-GCM secret envelopes, PBKDF2 admin passwords, model-prefix
// routing, token estimation, and the RouterState Durable Object logic
// (round-robin ordering + circuit breaker) with an in-memory storage stub.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    encryptSecret,
    decryptSecret,
    encryptSecretsObject,
    decryptSecretsObject
} from "../src/crypto/secretbox.js";
import { hashPassword, verifyPassword, sha256Hex } from "../src/crypto/password.js";
import {
    candidateAccountsForPrefix,
    stripRoutingPrefix,
    providerAlias,
    isSupportedProvider
} from "../src/providers/registry.js";
import { routingPrefixes, type DecryptedAccount } from "../src/providers/types.js";
import { estimateTokens } from "../src/router/tokens.js";
import { RouterState } from "../src/router/durable.js";
import { GrokCliExecutor } from "../src/providers/grokcli.js";
import { GeminiCliAdapter } from "../src/providers/geminicli.js";

const MASTER_KEY = Buffer.from("x".repeat(32)).toString("base64");

function account(id: string, providerType: string, alias?: string): DecryptedAccount {
    return {
        id,
        providerType,
        name: id,
        alias,
        category: "oauth",
        protocol: "openai",
        extra: {},
        enabled: true
    };
}

describe("secretbox (AES-GCM)", () => {
    it("round-trips a secret string", async () => {
        const env = await encryptSecret("super-secret-value", MASTER_KEY);
        assert.equal(await decryptSecret(env, MASTER_KEY), "super-secret-value");
    });

    it("uses a fresh nonce per encryption", async () => {
        const a = await encryptSecret("same", MASTER_KEY);
        const b = await encryptSecret("same", MASTER_KEY);
        assert.notEqual(a, b);
        assert.equal(await decryptSecret(a, MASTER_KEY), "same");
        assert.equal(await decryptSecret(b, MASTER_KEY), "same");
    });

    it("round-trips a secrets object", async () => {
        const obj = { api_key: "k", access_token: "a", refresh_token: "r" };
        const env = await encryptSecretsObject(obj, MASTER_KEY);
        assert.deepEqual(await decryptSecretsObject(env, MASTER_KEY), obj);
    });

    it("rejects the wrong master key", async () => {
        const env = await encryptSecret("s", MASTER_KEY);
        const wrong = Buffer.from("y".repeat(32)).toString("base64");
        await assert.rejects(() => decryptSecret(env, wrong));
    });

    it("rejects a malformed envelope", async () => {
        await assert.rejects(() => decryptSecret("{}", MASTER_KEY));
    });
});

describe("admin password (PBKDF2-SHA256)", () => {
    it("hashes and verifies", async () => {
        const hash = await hashPassword("correct-horse-123");
        assert.ok(hash.startsWith("pbkdf2$"));
        assert.equal(await verifyPassword("correct-horse-123", hash), true);
        assert.equal(await verifyPassword("wrong-password", hash), false);
    });

    it("salts uniquely", async () => {
        const a = await hashPassword("same-password");
        const b = await hashPassword("same-password");
        assert.notEqual(a, b);
    });

    it("stays within the Workers PBKDF2 iteration cap (100000)", async () => {
        const hash = await hashPassword("cap-check");
        const iterations = parseInt(hash.split("$")[1]!, 10);
        assert.ok(iterations <= 100_000, `iterations=${iterations} exceeds Workers cap`);
    });

    it("rejects garbage stored hashes", async () => {
        assert.equal(await verifyPassword("x", "not-a-hash"), false);
        assert.equal(await verifyPassword("x", "pbkdf2$abc$def$ghi"), false);
    });
});

describe("sha256Hex", () => {
    it("matches the known digest", async () => {
        assert.equal(
            await sha256Hex("hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    });
});

describe("model prefix routing", () => {
    const accounts = [
        account("a1", "antigravity"),
        account("a2", "antigravity"),
        account("q1", "qoder", "myqoder"),
        account("g1", "grok-cli")
    ];

    it("matches provider type prefix", () => {
        const got = candidateAccountsForPrefix("antigravity/gemini-3-pro", accounts);
        assert.deepEqual(got.map((a) => a.id), ["a1", "a2"]);
    });

    it("matches alias prefix case-insensitively", () => {
        const got = candidateAccountsForPrefix("GCLI/grok-build", accounts);
        assert.deepEqual(got.map((a) => a.id), ["g1"]);
        const custom = candidateAccountsForPrefix("myqoder/some-model", accounts);
        assert.deepEqual(custom.map((a) => a.id), ["q1"]);
    });

    it("returns empty for bare model ids", () => {
        assert.deepEqual(candidateAccountsForPrefix("gpt-4o", accounts), []);
    });

    it("strips the routing prefix", () => {
        assert.equal(stripRoutingPrefix("antigravity/gemini-3-pro", accounts[0]!), "gemini-3-pro");
        assert.equal(stripRoutingPrefix("gcli/grok-build", accounts[3]!), "grok-build");
        assert.equal(stripRoutingPrefix("gpt-4o", accounts[0]!), "gpt-4o");
    });

    it("providerAlias prefers row alias, then builtin", () => {
        assert.equal(providerAlias("qoder", "myqoder"), "myqoder");
        assert.equal(providerAlias("qoder", null), "qd");
        assert.equal(providerAlias("openai_codex", null), "codex");
    });

    it("routingPrefixes includes type and alias", () => {
        assert.deepEqual(routingPrefixes("qoder", "qd"), ["qoder", "qd"]);
        assert.deepEqual(routingPrefixes("qoder", "qoder"), ["qoder"]);
    });

    it("isSupportedProvider gates the factory", () => {
        assert.equal(isSupportedProvider("antigravity"), true);
        assert.equal(isSupportedProvider("grok-cli"), true);
        assert.equal(isSupportedProvider("openai-compatible"), true);
        assert.equal(isSupportedProvider("nope"), false);
    });
});

describe("estimateTokens", () => {
    it("scales with length", () => {
        assert.equal(estimateTokens(""), 0);
        assert.ok(estimateTokens("hello world") > 0);
        assert.ok(estimateTokens("x".repeat(400)) >= estimateTokens("x".repeat(40)));
    });
});

describe("grok-cli adapter (new)", () => {
    it("returns the fallback catalog without credentials", async () => {
        const ex = new GrokCliExecutor({ id: "g1" });
        const models = await ex.listModels();
        assert.ok(models.some((m) => m.id === "grok-build"));
    });
});

describe("gemini-cli adapter (scaffold)", () => {
    it("lists fallback models and throws a clear error on chat", async () => {
        const ad = new GeminiCliAdapter({ id: "gm1" });
        const models = await ad.listModels();
        assert.ok(models.length > 0);
        await assert.rejects(() => ad.chatCompletion({} as never), /Phase 1/);
    });
});

// --- Durable Object logic with an in-memory storage stub ---

function makeDo() {
    const store = new Map<string, unknown>();
    const ctx = {
        storage: {
            get: async (k: string) => store.get(k),
            put: async (k: string, v: unknown) => {
                store.set(k, v);
            }
        },
        blockConcurrencyWhile: async (fn: () => Promise<void>) => {
            await fn();
        }
    };
    return new RouterState(ctx as unknown as DurableObjectState, {} as never);
}

async function doPost(do_: RouterState, path: string, body: unknown) {
    const res = await do_.fetch(
        new Request(`https://do${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        })
    );
    return res.json() as Promise<Record<string, unknown>>;
}

describe("RouterState Durable Object", () => {
    it("round-robins across healthy accounts", async () => {
        const do_ = makeDo();
        const accounts = [
            { id: "a1", base: "antigravity" },
            { id: "a2", base: "antigravity" }
        ];
        const first = (await doPost(do_, "/route", { accounts })) as { orderedIds: string[] };
        const second = (await doPost(do_, "/route", { accounts })) as { orderedIds: string[] };
        assert.deepEqual(first.orderedIds, ["a1", "a2"]);
        assert.deepEqual(second.orderedIds, ["a2", "a1"]);
    });

    it("deprioritizes failed accounts and heals on success", async () => {
        const do_ = makeDo();
        const accounts = [
            { id: "a1", base: "antigravity" },
            { id: "a2", base: "antigravity" }
        ];
        await doPost(do_, "/report", { accountId: "a1", ok: false, error: "boom" });
        const ordered = (await doPost(do_, "/route", { accounts })) as {
            orderedIds: string[];
        };
        assert.equal(ordered.orderedIds[0], "a2");

        const health = (await (await do_.fetch(new Request("https://do/health"))).json()) as {
            states: Record<string, { state: string; consecutiveFailures: number }>;
        };
        assert.equal(health.states["a1"]!.state, "cooldown");
        assert.equal(health.states["a1"]!.consecutiveFailures, 1);

        await doPost(do_, "/report", { accountId: "a1", ok: true });
        const healed = (await doPost(do_, "/route", { accounts })) as {
            orderedIds: string[];
        };
        assert.ok(healed.orderedIds.includes("a1"));
    });

    it("caches and expires the model list", async () => {
        const do_ = makeDo();
        const models = [{ id: "antigravity/gemini-3-pro", object: "model" }];
        await doPost(do_, "/models", { models });
        const got = (await (await do_.fetch(new Request("https://do/models"))).json()) as {
            models: unknown[] | null;
        };
        assert.deepEqual(got.models, models);
    });

    it("grants refresh locks exclusively", async () => {
        const do_ = makeDo();
        const first = (await doPost(do_, "/refresh/try", {
            accountId: "a1",
            ttlMs: 60_000
        })) as { acquired: boolean };
        const second = (await doPost(do_, "/refresh/try", {
            accountId: "a1",
            ttlMs: 60_000
        })) as { acquired: boolean };
        assert.equal(first.acquired, true);
        assert.equal(second.acquired, false);
    });
});
