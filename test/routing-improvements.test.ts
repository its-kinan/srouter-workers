// Regression tests for the four routing improvements (2026-09-29):
//  1. Delayed hedging — hedgedFirstByte races the primary's first byte
//     against SROUTER_HEDGE_DELAY_MS (src/router/completion.ts).
//  2. Least-connections — in-flight counts break near-ties in
//     orderCandidatesLocally.
//  3. Per-(account,model) latency — pair EMA preferred over account EMA.
//  4. Response-quality tracking — decayed bad/total counters deprioritize
//     accounts that answer empty; DO /report accepts qualityBad + model,
//     /health exposes latencyPairs + quality, /reset clears them.
//  5. resolveHedgeDelayMs defaults / disable behaviour.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../src/env.js";
import {
    hedgedFirstByte,
    isBadQualityResponse,
    orderCandidatesLocally,
    recordLatencySample,
    recordQualitySample,
    reportQualityLater,
    resolveHedgeDelayMs,
    resetLocalRoutingStateForTests,
    trackAttemptStart,
    trackAttemptEnd,
    type StartedAttempt
} from "../src/router/completion.js";
import { SwitchState, latencyPairKey } from "../src/router/durable.js";
import type { DecryptedAccount } from "../src/providers/types.js";
import type { ChatCompletionChunk } from "../src/vendor/types/index.js";

function makeAccount(id: string): DecryptedAccount {
    return {
        id,
        providerType: "antigravity",
        name: id,
        category: "api_key",
        protocol: "openai",
        extra: {},
        enabled: true
    };
}

/** A StartedAttempt whose generator yields after delayMs; records return(). */
function fakeAttempt(
    id: string,
    delayMs: number,
    opts: { fail?: unknown; empty?: boolean } = {}
): { attempt: StartedAttempt; returned: () => boolean } {
    let wasReturned = false;
    const inner = (async function* (): AsyncGenerator<ChatCompletionChunk, void, void> {
        await new Promise((r) => setTimeout(r, delayMs));
        if (opts.fail !== undefined) throw opts.fail;
        if (opts.empty) return;
        yield { id: `chunk-${id}` } as ChatCompletionChunk;
    })();
    const origReturn = inner.return.bind(inner);
    inner.return = async (...args: Parameters<typeof inner.return>) => {
        wasReturned = true;
        return origReturn(...args);
    };
    return {
        attempt: { account: makeAccount(id), gen: inner, attemptStart: Date.now() },
        returned: () => wasReturned
    };
}

/** Fake env whose SwitchState stub captures /report bodies. */
function makeEnv(captured: unknown[]) {
    const stub = {
        fetch: async (req: Request) => {
            captured.push(await req.json().catch(() => null));
            return Response.json({ ok: true });
        }
    };
    return {
        SWITCH_STATE: { getByName: (_name: string) => stub }
    } as unknown as Env;
}

function makeDo() {
    const store = new Map<string, unknown>();
    const storage = {
        get: async (k: string) => store.get(k),
        put: async (k: string, v: unknown) => void store.set(k, v),
        delete: async (k: string) => void store.delete(k),
        setAlarm: async (_t: number) => {}
    };
    const ctx = {
        storage,
        blockConcurrencyWhile: async (fn: () => Promise<void>) => void fn(),
        waitUntil: (_p: Promise<unknown>) => {}
    } as unknown as DurableObjectState;
    const env = {} as Env;
    return new SwitchState(ctx, env);
}

const postReport = (do_: SwitchState, body: unknown) =>
    do_.fetch(
        new Request("https://do/report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        })
    );

const getHealth = async (do_: SwitchState) => {
    const json = (await (await do_.fetch(new Request("https://do/health"))).json()) as {
        latency: Record<string, unknown>;
        latencyPairs: Record<string, unknown>;
        quality: Record<string, { badRate: number; samples: number }>;
    };
    return json;
};

describe("hedgedFirstByte — delayed hedging", () => {
    it("primary wins before the hedge delay: no hedge is started", async () => {
        const { attempt } = fakeAttempt("primary", 10);
        let hedgeCalls = 0;
        const outcome = await hedgedFirstByte(
            attempt,
            () => {
                hedgeCalls++;
                return Promise.resolve(null);
            },
            1000
        );
        assert.equal(outcome.kind, "won");
        assert.equal(outcome.winner!.account.id, "primary");
        assert.equal(outcome.accountsConsumed, 1);
        assert.equal(hedgeCalls, 0);
    });

    it("slow primary + fast hedge: hedge wins, slow transport is aborted, both counted", async () => {
        const primary = fakeAttempt("slow", 500);
        const hedge = fakeAttempt("fast", 10);
        const outcome = await hedgedFirstByte(
            primary.attempt,
            () => Promise.resolve(hedge.attempt),
            50
        );
        assert.equal(outcome.kind, "won");
        assert.equal(outcome.winner!.account.id, "fast");
        // The loser was abandoned via gen.return() (best-effort cancel).
        assert.equal(primary.returned(), true);
        // Both attempts count against the max-attempt budget.
        assert.equal(outcome.accountsConsumed, 2);
    });

    it("hedging disabled via null startHedge (pinned requests): primary alone", async () => {
        const { attempt } = fakeAttempt("pinned", 300);
        const outcome = await hedgedFirstByte(attempt, null, 2000);
        assert.equal(outcome.kind, "won");
        assert.equal(outcome.winner!.account.id, "pinned");
        assert.equal(outcome.accountsConsumed, 1);
    });

    it("hedgeDelayMs <= 0 disables hedging even when a hedge is offered", async () => {
        const { attempt } = fakeAttempt("primary", 10);
        let hedgeCalls = 0;
        const outcome = await hedgedFirstByte(
            attempt,
            () => {
                hedgeCalls++;
                return Promise.resolve(null);
            },
            0
        );
        assert.equal(outcome.kind, "won");
        assert.equal(hedgeCalls, 0);
        assert.equal(outcome.accountsConsumed, 1);
    });

    it("startHedge failure falls back to awaiting the primary alone", async () => {
        const { attempt } = fakeAttempt("primary", 10);
        const outcome = await hedgedFirstByte(
            attempt,
            () => Promise.resolve(null),
            1
        );
        assert.equal(outcome.kind, "won");
        assert.equal(outcome.winner!.account.id, "primary");
        assert.equal(outcome.accountsConsumed, 1);
    });

    it("primary fails after the hedge delay: hedge wins", async () => {
        const primary = fakeAttempt("bad", 100, { fail: new Error("upstream 500") });
        const hedge = fakeAttempt("good", 10);
        const outcome = await hedgedFirstByte(
            primary.attempt,
            () => Promise.resolve(hedge.attempt),
            20
        );
        assert.equal(outcome.kind, "won");
        assert.equal(outcome.winner!.account.id, "good");
        assert.equal(outcome.accountsConsumed, 2);
    });

    it("primary fails before any hedge: single failure, no hedge fired", async () => {
        const primary = fakeAttempt("bad", 10, { fail: new Error("upstream 500") });
        let hedgeCalls = 0;
        const outcome = await hedgedFirstByte(
            primary.attempt,
            () => {
                hedgeCalls++;
                return Promise.resolve(null);
            },
            1000
        );
        assert.equal(outcome.kind, "failed");
        assert.equal(outcome.failures.length, 1);
        assert.equal(outcome.failures[0]!.account.id, "bad");
        assert.equal(hedgeCalls, 0);
        assert.equal(outcome.accountsConsumed, 1);
    });

    it("both sides fail: two failures recorded, both counted", async () => {
        const primary = fakeAttempt("p1", 100, { fail: new Error("p1 down") });
        const hedge = fakeAttempt("p2", 10, { fail: new Error("p2 down") });
        const outcome = await hedgedFirstByte(
            primary.attempt,
            () => Promise.resolve(hedge.attempt),
            20
        );
        assert.equal(outcome.kind, "failed");
        assert.equal(outcome.failures.length, 2);
        assert.equal(outcome.accountsConsumed, 2);
    });

    it("empty primary stream counts as a failure, not a win", async () => {
        const primary = fakeAttempt("empty", 10, { empty: true });
        const outcome = await hedgedFirstByte(primary.attempt, null, 1000);
        assert.equal(outcome.kind, "failed");
        assert.match(String(outcome.failures[0]!.error), /empty response stream/);
    });
});

describe("orderCandidatesLocally — least-connections balancing", () => {
    beforeEach(() => resetLocalRoutingStateForTests());

    it("within 25% of the fastest, the idle account wins over the saturated one", () => {
        const fast = makeAccount("acc_fast");
        const slow = makeAccount("acc_slow");
        recordLatencySample("acc_fast", undefined, 100);
        recordLatencySample("acc_slow", undefined, 120); // within 25% of 100
        trackAttemptStart("acc_fast");
        trackAttemptStart("acc_fast");
        try {
            const ordered = orderCandidatesLocally([fast, slow]).map((a) => a.id);
            assert.deepEqual(ordered, ["acc_slow", "acc_fast"]);
        } finally {
            trackAttemptEnd("acc_fast");
            trackAttemptEnd("acc_fast");
        }
    });

    it("a much slower idle account still loses to the fast saturated one", () => {
        const fast = makeAccount("acc_fast");
        const slow = makeAccount("acc_slow");
        recordLatencySample("acc_fast", undefined, 100);
        recordLatencySample("acc_slow", undefined, 500); // far outside the 25% band
        trackAttemptStart("acc_fast");
        try {
            const ordered = orderCandidatesLocally([fast, slow]).map((a) => a.id);
            assert.deepEqual(ordered, ["acc_fast", "acc_slow"]);
        } finally {
            trackAttemptEnd("acc_fast");
        }
    });

    it("in-flight counts never leak below zero", () => {
        trackAttemptEnd("ghost");
        const a = makeAccount("a");
        recordLatencySample("a", undefined, 100);
        // No throw, ordering unaffected by the phantom decrement.
        assert.deepEqual(orderCandidatesLocally([a]).map((x) => x.id), ["a"]);
    });
});

describe("orderCandidatesLocally — per-(account,model) latency", () => {
    beforeEach(() => resetLocalRoutingStateForTests());

    it("model Y prefers account B even though account A is faster on model X", () => {
        const a = makeAccount("acc_a");
        const b = makeAccount("acc_b");
        recordLatencySample("acc_a", "model_x", 100);
        recordLatencySample("acc_a", "model_y", 5000);
        recordLatencySample("acc_b", "model_y", 200);
        const forY = orderCandidatesLocally([a, b], "model_y").map((x) => x.id);
        assert.deepEqual(forY, ["acc_b", "acc_a"]);
        const forX = orderCandidatesLocally([a, b], "model_x").map((x) => x.id);
        assert.deepEqual(forX, ["acc_a", "acc_b"]);
    });

    it("falls back to account-level EMA when no pair sample exists", () => {
        const a = makeAccount("acc_a");
        const b = makeAccount("acc_b");
        recordLatencySample("acc_a", undefined, 100);
        recordLatencySample("acc_b", undefined, 400);
        const ordered = orderCandidatesLocally([a, b], "unseen_model").map((x) => x.id);
        assert.deepEqual(ordered, ["acc_a", "acc_b"]);
    });
});

describe("response-quality tracking", () => {
    beforeEach(() => resetLocalRoutingStateForTests());

    it("isBadQualityResponse: empty completion is bad; text or tool calls are not", () => {
        assert.equal(
            isBadQualityResponse({ completionTokens: 0, completionParts: [], hadToolCalls: false }),
            true
        );
        assert.equal(
            isBadQualityResponse({ completionTokens: 0, completionParts: ["  "], hadToolCalls: false }),
            true
        );
        assert.equal(
            isBadQualityResponse({ completionTokens: 0, completionParts: ["hello"], hadToolCalls: false }),
            false
        );
        assert.equal(
            isBadQualityResponse({ completionTokens: 0, completionParts: [], hadToolCalls: true }),
            false
        );
        assert.equal(
            isBadQualityResponse({ completionTokens: 12, completionParts: [], hadToolCalls: false }),
            false
        );
    });

    it("an account with mostly empty responses is deprioritized, never excluded", () => {
        const bad = makeAccount("acc_bad");
        const good = makeAccount("acc_good");
        recordLatencySample("acc_bad", undefined, 100);
        recordLatencySample("acc_good", undefined, 100);
        // A few empties are absorbed (single samples may be client
        // disconnects); sustained emptiness crosses MIN_QUALITY_SAMPLES.
        for (let i = 0; i < 5; i++) recordQualitySample("acc_bad", true);
        recordQualitySample("acc_good", false);
        const ordered = orderCandidatesLocally([bad, good]).map((a) => a.id);
        assert.deepEqual(ordered, ["acc_good", "acc_bad"]);
        // Still a candidate — quality deprioritizes, it never hard-excludes.
        assert.equal(ordered.length, 2);
    });

    it("reportQualityLater forwards qualityBad + model to the DO and updates local state", async () => {
        const captured: unknown[] = [];
        const env = makeEnv(captured);
        const pending: Promise<unknown>[] = [];
        const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
        const bad = makeAccount("acc_bad");
        const good = makeAccount("acc_good");
        recordLatencySample("acc_bad", undefined, 100);
        recordLatencySample("acc_good", undefined, 100);
        for (let i = 0; i < 5; i++) reportQualityLater(ctx, env, bad, "model_q", true);
        await Promise.all(pending.map((p) => p.catch(() => {})));
        assert.equal(captured.length, 5);
        for (const body of captured) {
            assert.deepEqual(body, { accountId: "acc_bad", qualityBad: true, model: "model_q" });
        }
        // The local counters were updated synchronously: ordering reflects them.
        const ordered = orderCandidatesLocally([bad, good]).map((a) => a.id);
        assert.deepEqual(ordered, ["acc_good", "acc_bad"]);
    });

    it("SwitchState persists quality reports and exposes them on /health", async () => {
        const do_ = makeDo();
        await postReport(do_, { accountId: "a1", qualityBad: true, model: "m" });
        await postReport(do_, { accountId: "a1", qualityBad: false, model: "m" });
        const health = await getHealth(do_);
        assert.ok("a1" in health.quality);
        assert.equal(health.quality["a1"]!.samples, 2);
        assert.ok(health.quality["a1"]!.badRate > 0);
        assert.ok(health.quality["a1"]!.badRate < 1);
    });

    it("SwitchState stores pair latency on successful reports with a model", async () => {
        const do_ = makeDo();
        await postReport(do_, { accountId: "a1", ok: true, latencyMs: 150, model: "mx" });
        const health = await getHealth(do_);
        assert.ok(latencyPairKey("a1", "mx") in health.latencyPairs);
        assert.ok("a1" in health.latency);
    });

    it("/reset clears pair latency and quality", async () => {
        const do_ = makeDo();
        await postReport(do_, { accountId: "a1", ok: true, latencyMs: 150, model: "mx" });
        await postReport(do_, { accountId: "a1", qualityBad: true, model: "mx" });
        let health = await getHealth(do_);
        assert.ok(latencyPairKey("a1", "mx") in health.latencyPairs);
        assert.ok("a1" in health.quality);
        await do_.fetch(
            new Request("https://do/reset", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ accountId: "a1" })
            })
        );
        health = await getHealth(do_);
        assert.ok(!(latencyPairKey("a1", "mx") in health.latencyPairs));
        assert.ok(!("a1" in health.quality));
        assert.ok(!("a1" in health.latency));
    });
});

describe("resolveHedgeDelayMs", () => {
    it("defaults to 2000ms", () => {
        assert.equal(resolveHedgeDelayMs({} as Env), 2000);
    });

    it("honours an explicit value", () => {
        assert.equal(resolveHedgeDelayMs({ SROUTER_HEDGE_DELAY_MS: "500" } as Env), 500);
    });

    it("0 or negative disables hedging", () => {
        assert.equal(resolveHedgeDelayMs({ SROUTER_HEDGE_DELAY_MS: "0" } as Env), 0);
        assert.equal(resolveHedgeDelayMs({ SROUTER_HEDGE_DELAY_MS: "-1" } as Env), 0);
    });

    it("garbage falls back to the default", () => {
        assert.equal(resolveHedgeDelayMs({ SROUTER_HEDGE_DELAY_MS: "soon" } as Env), 2000);
    });
});
