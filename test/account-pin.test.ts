// Tests for account pinning ("provider/model#selector") —
// src/providers/registry.ts pin helpers and fallback combo interaction.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    accountMatchesPin,
    candidateAccountsForPrefix,
    parseAccountPin,
    stripRoutingPrefix
} from "../src/providers/registry.js";
import {
    invalidateFallbackRulesCache,
    resolveCandidates
} from "../src/routing/fallback.js";
import type { DecryptedAccount } from "../src/providers/types.js";

// resolveCandidates caches rules per isolate; each test gets its own fakeDb.
beforeEach(() => invalidateFallbackRulesCache());

function account(over: Partial<DecryptedAccount> = {}): DecryptedAccount {
    return {
        id: "acc_1",
        providerType: "antigravity",
        name: "Main Account",
        category: "oauth",
        protocol: "https",
        extra: {},
        enabled: true,
        ...over
    };
}

describe("parseAccountPin", () => {
    it("returns null pin when there is no #", () => {
        assert.deepEqual(parseAccountPin("antigravity/gemini-flash"), {
            model: "antigravity/gemini-flash",
            pin: null
        });
    });

    it("splits off the selector", () => {
        assert.deepEqual(parseAccountPin("antigravity/gemini-flash#acc_123"), {
            model: "antigravity/gemini-flash",
            pin: "acc_123"
        });
    });

    it("empty pin is treated as no pin", () => {
        assert.deepEqual(parseAccountPin("antigravity/gemini-flash#"), {
            model: "antigravity/gemini-flash",
            pin: null
        });
    });

    it("parses from the last #", () => {
        assert.deepEqual(parseAccountPin("a/b#c#d"), { model: "a/b#c", pin: "d" });
    });

    it("works on bare model ids", () => {
        assert.deepEqual(parseAccountPin("gemini-flash#acc_1"), {
            model: "gemini-flash",
            pin: "acc_1"
        });
    });

    it("trims whitespace around the pin", () => {
        assert.deepEqual(parseAccountPin("antigravity/x# acc_1 "), {
            model: "antigravity/x",
            pin: "acc_1"
        });
    });
});

describe("accountMatchesPin", () => {
    const a = account({ id: "acc_ABC123", name: "My Main Account", alias: "main" });

    it("matches account id exactly", () => {
        assert.equal(accountMatchesPin(a, "acc_ABC123"), true);
    });

    it("account id match is case-sensitive", () => {
        assert.equal(accountMatchesPin(a, "acc_abc123"), false);
    });

    it("matches name case-insensitively", () => {
        assert.equal(accountMatchesPin(a, "my main account"), true);
        assert.equal(accountMatchesPin(a, "MY MAIN ACCOUNT"), true);
    });

    it("matches alias case-insensitively", () => {
        assert.equal(accountMatchesPin(a, "MAIN"), true);
    });

    it("returns false when nothing matches", () => {
        assert.equal(accountMatchesPin(a, "nope"), false);
    });
});

describe("candidateAccountsForPrefix with pin", () => {
    const acc1 = account({ id: "acc_1", name: "One", providerType: "antigravity" });
    const acc2 = account({ id: "acc_2", name: "Two", providerType: "antigravity" });
    const qoder = account({ id: "acc_3", name: "Q", providerType: "qoder" });
    const accounts = [acc1, acc2, qoder];

    it("without pin returns all prefix matches (unchanged behavior)", () => {
        assert.deepEqual(
            candidateAccountsForPrefix("antigravity/gemini-flash", accounts).map((a) => a.id),
            ["acc_1", "acc_2"]
        );
    });

    it("pin by id restricts to that account", () => {
        assert.deepEqual(
            candidateAccountsForPrefix("antigravity/gemini-flash", accounts, "acc_2").map(
                (a) => a.id
            ),
            ["acc_2"]
        );
    });

    it("pin by name matches all same-named accounts", () => {
        const dup = account({ id: "acc_4", name: "One", providerType: "antigravity" });
        assert.deepEqual(
            candidateAccountsForPrefix("antigravity/gemini-flash", [...accounts, dup], "one").map(
                (a) => a.id
            ),
            ["acc_1", "acc_4"]
        );
    });

    it("unmatched pin returns empty", () => {
        assert.deepEqual(
            candidateAccountsForPrefix("antigravity/gemini-flash", accounts, "nope"),
            []
        );
    });

    it("pin cannot cross into another provider's prefix", () => {
        assert.deepEqual(
            candidateAccountsForPrefix("qd/some-model", accounts, "acc_1"),
            []
        );
    });

    it("bare model id still returns empty", () => {
        assert.deepEqual(
            candidateAccountsForPrefix("gemini-flash", accounts, "acc_1"),
            []
        );
    });
});

describe("stripRoutingPrefix with pin", () => {
    const a = account({ id: "acc_1", providerType: "antigravity" });

    it("strips prefix and pin together", () => {
        assert.equal(stripRoutingPrefix("antigravity/gemini-flash#acc_1", a), "gemini-flash");
    });

    it("strips pin even without a routing prefix", () => {
        assert.equal(stripRoutingPrefix("gemini-flash#acc_1", a), "gemini-flash");
    });

    it("is unchanged without a pin", () => {
        assert.equal(stripRoutingPrefix("antigravity/gemini-flash", a), "gemini-flash");
    });

    it("never leaks the pin upstream", () => {
        const upstream = stripRoutingPrefix("antigravity/gemini-flash#secret-acc", a);
        assert.ok(!upstream.includes("#"), `pin leaked: ${upstream}`);
    });
});

describe("fallback resolveCandidates with pin", () => {
    // Minimal D1Database stub, mirroring test/fallback.test.ts.
    function fakeDb(rows: unknown[]) {
        return {
            prepare: () => ({
                all: async () => ({
                    results: rows.filter((r) => (r as { enabled: number }).enabled === 1)
                })
            })
        } as unknown as D1Database;
    }

    function row(source: string, target: string, priority = 1) {
        return {
            id: `fb_${source}_${target}`,
            source_model: source,
            target_model: target,
            priority,
            enabled: 1,
            trigger_on_status: null,
            max_retries: 1
        };
    }

    it("pinned source still matches its combo rule", async () => {
        const db = fakeDb([row("antigravity/gemini-flash", "qoder/qwen#acc_9")]);
        const out = await resolveCandidates(db, "antigravity/gemini-flash#acc_1");
        assert.equal(out.length, 2);
        assert.equal(out[0]!.model, "antigravity/gemini-flash#acc_1");
        assert.equal(out[1]!.model, "qoder/qwen#acc_9");
    });

    it("unpinned source matches a rule with a pinned target", async () => {
        const db = fakeDb([row("antigravity/gemini-flash", "antigravity/gemini-flash#acc_2")]);
        const out = await resolveCandidates(db, "antigravity/gemini-flash");
        assert.equal(out.length, 2);
        assert.equal(out[1]!.model, "antigravity/gemini-flash#acc_2");
    });

    it("no rules -> single pinned candidate", async () => {
        const out = await resolveCandidates(fakeDb([]), "antigravity/gemini-flash#acc_1");
        assert.equal(out.length, 1);
        assert.equal(out[0]!.model, "antigravity/gemini-flash#acc_1");
    });
});
