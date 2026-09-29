// Regression tests for the subrequest-budget exhaustion fix
// (src/router/completion.ts):
// - SROUTER_SUBREQUEST_BUDGET bounds total fetches per request; the failover
//   loop stops with a subrequest_budget_reached note instead of letting
//   Cloudflare kill the invocation at ~50 subrequests ("Too many
//   subrequests by single Worker invocation", the 2026-09-29 prod 502).
// - SROUTER_ATTEMPT_TIMEOUT_MS abandons hung upstreams: no first byte
//   within the deadline => failed attempt (feeds the circuit breaker).
// - Abandoned hedge losers are dead generators and can never retry.
// - Pinned single-account requests still get their full first try.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../src/env.js";
import {
    executeCompletion,
    hedgedFirstByte,
    resolveAttemptTimeoutMs,
    resolveSubrequestBudget,
    resetLocalRoutingStateForTests,
    DEFAULT_ATTEMPT_TIMEOUT_MS,
    DEFAULT_SUBREQUEST_BUDGET,
    type StartedAttempt
} from "../src/router/completion.js";
import {
    resetRegistryCachesForTests,
    type ProviderRow
} from "../src/providers/registry.js";
import { invalidateFallbackRulesCache } from "../src/routing/fallback.js";
import {
    encryptSecretsObject,
    generateMasterKey
} from "../src/crypto/secretbox.js";
import type { DecryptedAccount } from "../src/providers/types.js";
import type {
    ChatCompletionChunk,
    ChatCompletionRequest
} from "../src/vendor/types/index.js";

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
    delayMs: number
): { attempt: StartedAttempt; returned: () => boolean } {
    let wasReturned = false;
    const inner = (async function* (): AsyncGenerator<ChatCompletionChunk, void, void> {
        await new Promise((r) => setTimeout(r, delayMs));
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

/** A StartedAttempt whose generator never yields (hung upstream). */
function hungAttempt(id: string): { attempt: StartedAttempt; returned: () => boolean } {
    let wasReturned = false;
    const inner = (async function* (): AsyncGenerator<ChatCompletionChunk, void, void> {
        await new Promise<never>(() => {}); // hangs forever; no timer handle
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

describe("resolveSubrequestBudget / resolveAttemptTimeoutMs", () => {
    it("defaults: budget 40, timeout 15000ms", () => {
        assert.equal(resolveSubrequestBudget({} as Env), DEFAULT_SUBREQUEST_BUDGET);
        assert.equal(resolveSubrequestBudget({} as Env), 40);
        assert.equal(resolveAttemptTimeoutMs({} as Env), DEFAULT_ATTEMPT_TIMEOUT_MS);
        assert.equal(resolveAttemptTimeoutMs({} as Env), 15000);
    });

    it("honors valid values", () => {
        assert.equal(resolveSubrequestBudget({ SROUTER_SUBREQUEST_BUDGET: "25" } as Env), 25);
        assert.equal(
            resolveAttemptTimeoutMs({ SROUTER_ATTEMPT_TIMEOUT_MS: "5000" } as Env),
            5000
        );
    });

    it("falls back on 0, negative, non-numeric, or empty", () => {
        for (const v of ["0", "-3", "abc", "", "  "]) {
            assert.equal(
                resolveSubrequestBudget({ SROUTER_SUBREQUEST_BUDGET: v } as Env),
                40,
                `budget value: ${JSON.stringify(v)}`
            );
        }
        for (const v of ["abc", "", "  "]) {
            assert.equal(
                resolveAttemptTimeoutMs({ SROUTER_ATTEMPT_TIMEOUT_MS: v } as Env),
                15000,
                `timeout value: ${JSON.stringify(v)}`
            );
        }
        // <= 0 disables the timeout (returns 0), budget falls back to 40.
        assert.equal(resolveAttemptTimeoutMs({ SROUTER_ATTEMPT_TIMEOUT_MS: "0" } as Env), 0);
        assert.equal(resolveAttemptTimeoutMs({ SROUTER_ATTEMPT_TIMEOUT_MS: "-1" } as Env), 0);
    });
});

describe("hedgedFirstByte — attempt timeout", () => {
    it("hung primary is abandoned at the deadline and reported as failed", async () => {
        const primary = hungAttempt("hung");
        const outcome = await hedgedFirstByte(primary.attempt, null, 0, 50);
        assert.equal(outcome.kind, "failed");
        assert.equal(outcome.failures.length, 1);
        assert.equal(outcome.failures[0]!.account.id, "hung");
        assert.match(String(outcome.failures[0]!.error), /timed out waiting for first byte/);
        assert.equal(primary.returned(), true);
        assert.equal(outcome.accountsConsumed, 1);
    });

    it("hung primary + hung hedge: both abandoned at the deadline", async () => {
        const primary = hungAttempt("p1");
        const hedge = hungAttempt("p2");
        const outcome = await hedgedFirstByte(
            primary.attempt,
            () => Promise.resolve(hedge.attempt),
            10,
            60
        );
        assert.equal(outcome.kind, "failed");
        assert.equal(outcome.failures.length, 2);
        assert.equal(primary.returned(), true);
        assert.equal(hedge.returned(), true);
        for (const f of outcome.failures) {
            assert.match(String(f.error), /timed out waiting for first byte/);
        }
        assert.equal(outcome.accountsConsumed, 2);
    });

    it("fast primary with a timeout configured still wins normally", async () => {
        const { attempt } = fakeAttempt("fast", 10);
        const outcome = await hedgedFirstByte(attempt, null, 0, 5000);
        assert.equal(outcome.kind, "won");
        assert.equal(outcome.winner!.account.id, "fast");
    });

    it("timeout <= 0 disables the deadline (back-compat with 3-arg callers)", async () => {
        const { attempt } = fakeAttempt("p", 10);
        const outcome = await hedgedFirstByte(attempt, null, 0, 0);
        assert.equal(outcome.kind, "won");
    });
});

describe("hedged loser abandonment", () => {
    it("abandoned hedge loser is a dead generator: cannot retry or yield", async () => {
        const primary = fakeAttempt("slow", 300);
        const hedge = fakeAttempt("fast", 10);
        const outcome = await hedgedFirstByte(
            primary.attempt,
            () => Promise.resolve(hedge.attempt),
            20,
            0
        );
        assert.equal(outcome.kind, "won");
        assert.equal(outcome.winner!.account.id, "fast");
        assert.equal(primary.returned(), true);
        // The loser's generator is finished: no further chunks, no retry.
        const next = await primary.attempt.gen.next();
        assert.equal(next.done, true);
    });

    it("hung hedge loser does not hang the request when the primary wins", async () => {
        // Primary is slower than the hedge delay but settles; the hedge is
        // fired and then hangs forever. The primary still wins, and
        // abandoning the hung loser must be fire-and-forget — awaiting its
        // return() would hang the request (V8 queues the return behind the
        // never-settling await).
        const primary = fakeAttempt("primary", 40);
        const hedge = hungAttempt("hung-hedge");
        const t0 = Date.now();
        const outcome = await hedgedFirstByte(
            primary.attempt,
            () => Promise.resolve(hedge.attempt),
            5,
            0
        );
        const wallMs = Date.now() - t0;
        assert.equal(outcome.kind, "won");
        assert.equal(outcome.winner!.account.id, "primary");
        assert.equal(outcome.accountsConsumed, 2);
        assert.equal(hedge.returned(), true);
        assert.ok(wallMs < 5000, `hung loser abandonment took ${wallMs}ms`);
    });
});

// --- end-to-end: shared subrequest budget through executeCompletion ---

async function makeRow(id: string, masterKey: string): Promise<ProviderRow> {
    return {
        id,
        provider_id: "tokenharbor",
        name: id,
        alias: null,
        category: "api_key",
        protocol: "openai",
        base_url: "https://example.com/v1",
        secrets_enc: await encryptSecretsObject({ apiKey: "sk-test" }, masterKey),
        account_id: null,
        organization_id: null,
        provider_specific_data: null,
        custom_headers: null,
        token_expires_at: null,
        last_refreshed_at: null,
        enabled: 1
    };
}

/** Fake D1: routes on SQL — fallback_rules empty, version aggregate, provider rows, INSERT ok. */
function fakeDb(rows: ProviderRow[]) {
    const db = {
        prepare: (sql: string) => {
            const stmt = {
                bind: (..._args: unknown[]) => stmt,
                first: async () => {
                    if (sql.includes("COUNT(*)")) return { n: rows.length, e: rows.length, c: 1 };
                    return null;
                },
                all: async () => {
                    if (sql.includes("fallback_rules")) return { results: [] };
                    return { results: rows };
                },
                run: async () => ({ success: true })
            };
            return stmt;
        }
    } as unknown as D1Database;
    return db;
}

/** Fake SwitchState DO: fresh model catalog, ok for /report and /usage. */
function fakeDoStub() {
    return {
        fetch: async (req: Request) => {
            const url = new URL(req.url);
            if (url.pathname === "/models") {
                return Response.json({
                    models: [
                        { id: "tokenharbor/test-model", object: "model", created: 1, owned_by: "t" }
                    ],
                    cachedAt: Date.now()
                });
            }
            return Response.json({ ok: true });
        }
    };
}

function makeEnv(db: D1Database, masterKey: string, extra: Record<string, unknown> = {}) {
    return {
        DB: db,
        MASTER_KEY: masterKey,
        SWITCH_STATE: { getByName: (_name: string) => fakeDoStub() },
        ...extra
    } as unknown as Env;
}

const noopCtx = { waitUntil: (_p: Promise<unknown>) => {} };

function completionBody(model: string): ChatCompletionRequest {
    return {
        model,
        messages: [{ role: "user", content: "hi" }],
        stream: false
    } as unknown as ChatCompletionRequest;
}

let upstreamCalls = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
    resetRegistryCachesForTests();
    resetLocalRoutingStateForTests();
    invalidateFallbackRulesCache();
    upstreamCalls = 0;
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

/** Every upstream fetch fails fast (dead credentials); counts real fetches. */
function stubFailingFetch() {
    globalThis.fetch = (async () => {
        upstreamCalls++;
        throw new Error("upstream 401: expired credential");
    }) as typeof fetch;
}

/** Every upstream fetch hangs forever; counts attempted fetches. */
function stubHangingFetch() {
    globalThis.fetch = (async () => {
        upstreamCalls++;
        await new Promise<never>(() => {});
        throw new Error("unreachable");
    }) as typeof fetch;
}

async function runFailover(
    n: number,
    envExtra: Record<string, unknown> = {},
    model = "th/test-model"
) {
    const masterKey = generateMasterKey();
    const rows = await Promise.all(
        Array.from({ length: n }, (_, i) => makeRow(`bgt-acc-${i}`, masterKey))
    );
    const env = makeEnv(fakeDb(rows), masterKey, envExtra);
    const outcome = await executeCompletion(env, noopCtx, {
        body: completionBody(model),
        startedAt: Date.now(),
        ip: null,
        userAgent: null
    });
    assert.equal(outcome.kind, "error");
    return outcome as { kind: "error"; status: number; message: string };
}

describe("subrequest budget (end-to-end)", () => {
    it("budget stops the loop before Cloudflare's kill: 15 dead accounts, budget 3 => 3 fetches", async () => {
        stubFailingFetch();
        const outcome = await runFailover(15, { SROUTER_SUBREQUEST_BUDGET: "3" });
        assert.equal(outcome.status, 502);
        assert.equal(upstreamCalls, 3);
        assert.match(outcome.message, /subrequest_budget_reached/);
        assert.match(outcome.message, /used 3\/3 subrequests/);
        // The attempt cap was NOT the binding constraint here.
        assert.doesNotMatch(outcome.message, /attempt_cap_reached/);
    });

    it("default budget (40) does not interfere with the 10-attempt cap", async () => {
        stubFailingFetch();
        const outcome = await runFailover(15);
        assert.equal(outcome.status, 502);
        assert.equal(upstreamCalls, 10);
        assert.match(outcome.message, /attempt_cap_reached/);
        assert.doesNotMatch(outcome.message, /subrequest_budget_reached/);
    });

    it("pinned single-account request gets its full first try even with budget 1", async () => {
        stubFailingFetch();
        const outcome = await runFailover(15, { SROUTER_SUBREQUEST_BUDGET: "1" }, "th/test-model#bgt-acc-3");
        assert.equal(outcome.status, 502);
        assert.equal(upstreamCalls, 1);
        assert.doesNotMatch(outcome.message, /subrequest_budget_reached/);
        assert.doesNotMatch(outcome.message, /attempt_cap_reached/);
    });

    it("hung upstreams are abandoned at the attempt timeout (no 90s hang)", async () => {
        stubHangingFetch();
        const started = Date.now();
        const outcome = await runFailover(5, {
            SROUTER_ATTEMPT_TIMEOUT_MS: "150",
            SROUTER_HEDGE_DELAY_MS: "10",
            SROUTER_MAX_ATTEMPTS: "2"
        });
        const wallMs = Date.now() - started;
        assert.equal(outcome.status, 502);
        assert.match(outcome.message, /timed out waiting for first byte/);
        // 2 attempts, each bounded by max(150, 10+1000) = 1010ms first-byte
        // deadline — far below the unbounded hang. Generous upper bound for
        // CI slowness.
        assert.ok(wallMs < 15000, `wall time ${wallMs}ms should be bounded`);
        assert.ok(upstreamCalls >= 2, `expected >= 2 fetch attempts, got ${upstreamCalls}`);
    });
});
