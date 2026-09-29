// Regression tests for latency-aware routing:
// - isolate-local latency EMA + latency-sorted candidate ordering
//   (src/router/completion.ts)
// - per-account latency EMA in the RouterState DO shard (POST /report
//   latencyMs, GET /health exposure, /reset clearing) (src/router/durable.ts)
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../src/env.js";
import {
    orderCandidatesLocally,
    recordLatencySample,
    reportLater,
    resetLocalRoutingStateForTests
} from "../src/router/completion.js";
import { RouterState } from "../src/router/durable.js";
import type { DecryptedAccount } from "../src/providers/types.js";

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

/** Fake env whose RouterState stub captures /report bodies. */
function makeEnv(captured: unknown[]) {
    const stub = {
        fetch: async (req: Request) => {
            captured.push(await req.json().catch(() => null));
            return Response.json({ ok: true });
        }
    };
    return {
        ROUTER_STATE: { getByName: (_name: string) => stub }
    } as unknown as Env;
}

const noopCtx = { waitUntil: (_p: Promise<unknown>) => {} };

describe("orderCandidatesLocally — latency-aware ordering", () => {
    beforeEach(() => resetLocalRoutingStateForTests());

    it("prefers the consistently fast account over the slow one", () => {
        const fast = makeAccount("acc_fast");
        const slow = makeAccount("acc_slow");
        recordLatencySample("acc_fast", 100);
        recordLatencySample("acc_slow", 2000);
        const ordered = orderCandidatesLocally([slow, fast]);
        assert.deepEqual(
            ordered.map((a) => a.id),
            ["acc_fast", "acc_slow"]
        );
    });

    it("EMA blends samples: 100 then 200 => ema 120, sorts before a 150ms account", () => {
        const blended = makeAccount("acc_blended");
        const mid = makeAccount("acc_mid");
        recordLatencySample("acc_blended", 100);
        recordLatencySample("acc_blended", 200); // ema = 100 + 0.2*100 = 120
        recordLatencySample("acc_mid", 150);
        const ordered = orderCandidatesLocally([mid, blended]);
        assert.equal(ordered[0]!.id, "acc_blended");
    });

    it("accounts with no samples sort before measured ones (discovery)", () => {
        const fresh = makeAccount("acc_fresh");
        const slow = makeAccount("acc_slow");
        recordLatencySample("acc_slow", 2000);
        const ordered = orderCandidatesLocally([slow, fresh]);
        assert.equal(ordered[0]!.id, "acc_fresh");
    });

    it("cooldown still skips a fast but broken account", async () => {
        const captured: unknown[] = [];
        const env = makeEnv(captured);
        const fast = makeAccount("acc_fast");
        const slow = makeAccount("acc_slow");
        recordLatencySample("acc_fast", 50);
        recordLatencySample("acc_slow", 2000);
        // Fast account fails -> cooling for 30s despite its great EMA.
        reportLater(noopCtx, env, fast, false, "boom", 5000);
        await new Promise((r) => setTimeout(r, 0)); // let waitUntil fire
        const ordered = orderCandidatesLocally([fast, slow]);
        assert.deepEqual(
            ordered.map((a) => a.id),
            ["acc_slow"]
        );
    });

    it("falls back to round-robin rotation when no latency data exists (cold isolate)", () => {
        const a = makeAccount("acc_a");
        const b = makeAccount("acc_b");
        const first = orderCandidatesLocally([a, b]).map((x) => x.id);
        const second = orderCandidatesLocally([a, b]).map((x) => x.id);
        assert.deepEqual(first, ["acc_a", "acc_b"]);
        assert.deepEqual(second, ["acc_b", "acc_a"]);
    });

    it("reportLater forwards latencyMs to the DO shard", async () => {
        const captured: unknown[] = [];
        const env = makeEnv(captured);
        const acc = makeAccount("acc_1");
        reportLater(noopCtx, env, acc, true, undefined, 321);
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(captured.length, 1);
        const body = captured[0] as Record<string, unknown>;
        assert.equal(body["accountId"], "acc_1");
        assert.equal(body["ok"], true);
        assert.equal(body["latencyMs"], 321);
    });
});

describe("RouterState DO — latency EMA", () => {
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
        return new RouterState(ctx, env);
    }

    const postReport = (do_: RouterState, body: unknown) =>
        do_.fetch(
            new Request("https://do/report", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            })
        );

    const getLatency = async (do_: RouterState) => {
        const res = await do_.fetch(new Request("https://do/health"));
        const json = (await res.json()) as {
            latency: Record<string, { emaMs: number; samples: number }>;
        };
        return json.latency;
    };

    it("builds an EMA from successful reports (100 then 200 => 120)", async () => {
        const do_ = makeDo();
        await postReport(do_, { accountId: "a1", ok: true, latencyMs: 100 });
        await postReport(do_, { accountId: "a1", ok: true, latencyMs: 200 });
        const latency = await getLatency(do_);
        assert.equal(latency["a1"]!.emaMs, 120);
        assert.equal(latency["a1"]!.samples, 2);
    });

    it("failed attempts never touch the EMA", async () => {
        const do_ = makeDo();
        await postReport(do_, { accountId: "a1", ok: true, latencyMs: 100 });
        await postReport(do_, { accountId: "a1", ok: false, error: "boom", latencyMs: 9999 });
        const latency = await getLatency(do_);
        assert.equal(latency["a1"]!.emaMs, 100);
        assert.equal(latency["a1"]!.samples, 1);
    });

    it("ignores missing/invalid latencyMs", async () => {
        const do_ = makeDo();
        await postReport(do_, { accountId: "a1", ok: true });
        await postReport(do_, { accountId: "a2", ok: true, latencyMs: -5 });
        const latency = await getLatency(do_);
        assert.ok(!("a1" in latency));
        assert.ok(!("a2" in latency));
    });

    it("/reset clears latency entries", async () => {
        const do_ = makeDo();
        await postReport(do_, { accountId: "a1", ok: true, latencyMs: 100 });
        assert.ok("a1" in (await getLatency(do_)));
        await do_.fetch(
            new Request("https://do/reset", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ accountId: "a1" })
            })
        );
        assert.ok(!("a1" in (await getLatency(do_))));
    });
});
