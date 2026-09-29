// Regression tests for the revised request-logging modes, batched usage
// accounting (DO /usage + alarm flush), and per-provider OAuth refresh shards.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../src/env.js";
import { resolveRequestLogMode } from "../src/router/completion.js";
import { RouterState, routerShardName } from "../src/router/durable.js";
import { ensureFreshToken } from "../src/providers/oauth-refresh.js";

describe("resolveRequestLogMode", () => {
    const base = {} as Env;
    it("defaults to errors-only", () => {
        assert.equal(resolveRequestLogMode(base), "errors");
    });
    it("SROUTER_DISABLE_REQUEST_LOGS=1 disables all writes", () => {
        assert.equal(
            resolveRequestLogMode({ ...base, SROUTER_DISABLE_REQUEST_LOGS: "1" } as Env),
            "none"
        );
    });
    it("SROUTER_LOG_ALL_REQUESTS=1 restores full logging", () => {
        assert.equal(
            resolveRequestLogMode({ ...base, SROUTER_LOG_ALL_REQUESTS: "1" } as Env),
            "all"
        );
    });
    it("disable wins over log-all when both are set", () => {
        assert.equal(
            resolveRequestLogMode({
                ...base,
                SROUTER_DISABLE_REQUEST_LOGS: "1",
                SROUTER_LOG_ALL_REQUESTS: "1"
            } as Env),
            "none"
        );
    });
});

describe("RouterState /usage batching", () => {
    function makeDo() {
        const updates: { sql: string; params: unknown[] }[] = [];
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
        const db = {
            prepare: (sql: string) => ({
                bind: (...params: unknown[]) => ({
                    // capture for assertion; batch() consumes these
                    _sql: sql,
                    _params: params
                })
            }),
            batch: async (stmts: { _sql: string; _params: unknown[] }[]) => {
                for (const s of stmts) updates.push({ sql: s._sql, params: s._params });
            }
        } as unknown as D1Database;
        const env = { DB: db } as Env;
        const do_ = new RouterState(ctx, env);
        return { do_, updates };
    }

    it("POST /usage accumulates deltas and alarm() flushes one batch to D1", async () => {
        const { do_, updates } = makeDo();
        const post = (body: unknown) =>
            do_.fetch(
                new Request("https://do/usage", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                })
            );
        await post({ keyId: "key_1", tokens: 100, cost: 0.01 });
        await post({ keyId: "key_1", tokens: 50, cost: 0.005 });
        await post({ keyId: "key_2", tokens: 10, cost: 0.001 });
        assert.equal(updates.length, 0, "no D1 write before the flush");

        await do_.alarm();
        assert.equal(updates.length, 2, "one UPDATE per key in a single batch");
        const byKey = new Map(updates.map((u) => [u.params[2], u.params]));
        assert.deepEqual(byKey.get("key_1"), [150, 0.015, "key_1"]);
        assert.deepEqual(byKey.get("key_2"), [10, 0.001, "key_2"]);
        assert.ok(
            (updates[0]!.sql as string).includes("UPDATE api_keys"),
            "flush targets api_keys"
        );

        // Second alarm with no new deltas writes nothing.
        await do_.alarm();
        assert.equal(updates.length, 2);
    });

    it("malformed /usage bodies are ignored, never crash the DO", async () => {
        const { do_, updates } = makeDo();
        await do_.fetch(
            new Request("https://do/usage", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ nonsense: true })
            })
        );
        await do_.alarm();
        assert.equal(updates.length, 0);
    });

    it("deltas survive DO eviction: a fresh instance waking for the alarm still flushes", async () => {
        // Shared storage backing two DO instances (eviction simulation).
        const store = new Map<string, unknown>();
        const updates: { sql: string; params: unknown[] }[] = [];
        const db = {
            prepare: (sql: string) => ({
                bind: (...params: unknown[]) => ({ _sql: sql, _params: params })
            }),
            batch: async (stmts: { _sql: string; _params: unknown[] }[]) => {
                for (const s of stmts) updates.push({ sql: s._sql, params: s._params });
            }
        } as unknown as D1Database;
        const makeInstance = () => {
            const ctx = {
                storage: {
                    get: async (k: string) => store.get(k),
                    put: async (k: string, v: unknown) => void store.set(k, v),
                    delete: async (k: string) => void store.delete(k),
                    setAlarm: async (_t: number) => {}
                },
                blockConcurrencyWhile: async (fn: () => Promise<void>) => void fn(),
                waitUntil: (_p: Promise<unknown>) => {}
            } as unknown as DurableObjectState;
            return new RouterState(ctx, { DB: db } as Env);
        };

        const first = makeInstance();
        await first.fetch(
            new Request("https://do/usage", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ keyId: "key_9", tokens: 42, cost: 0.004 })
            })
        );
        // Instance evicted: a fresh one with empty memory wakes for the alarm.
        const second = makeInstance();
        await second.alarm();
        assert.equal(updates.length, 1);
        assert.deepEqual(updates[0]!.params, [42, 0.004, "key_9"]);
    });
});

describe("OAuth refresh shard", () => {
    it("ensureFreshToken takes the lock from the provider shard, not the global router", async () => {
        let lockName: string | null = null;
        const deps = {
            DB: {},
            MASTER_KEY: "x",
            ROUTER_STATE: {
                getByName: (name: string) => {
                    lockName = name;
                    return {
                        fetch: async () =>
                            Response.json({ acquired: false })
                    };
                }
            }
        } as unknown as Parameters<typeof ensureFreshToken>[0];

        // Token expired long ago → refresh is due → lock path is exercised.
        const token = await ensureFreshToken(
            deps,
            "acc_1",
            "antigravity",
            "current-access-token",
            "refresh-token",
            Date.now() - 3_600_000,
            Date.now() - 7_200_000,
            async (s: Record<string, unknown>) => JSON.stringify(s)
        );
        assert.equal(lockName, routerShardName("antigravity"));
        assert.equal(lockName, "router-antigravity");
        assert.equal(
            token,
            "current-access-token",
            "lock not acquired → falls back to the current token"
        );
    });
});
