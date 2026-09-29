// Regression tests for the failover attempt cap (src/router/completion.ts):
// - SROUTER_MAX_ATTEMPTS bounds upstream attempts per model candidate
// - the 502 error detail carries attempt_cap_reached when the cap stops
//   failover early (diagnosable via the error-only request logging)
// - resolveMaxAttempts defaults/fallbacks
// - pinned single-account requests are unaffected by the cap
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../src/env.js";
import {
    executeCompletion,
    resolveMaxAttempts,
    resetLocalRoutingStateForTests,
    DEFAULT_MAX_ATTEMPTS
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
import type { ChatCompletionRequest } from "../src/vendor/types/index.js";

// --- fakes ---

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
                        {
                            id: "tokenharbor/test-model",
                            object: "model",
                            created: 1,
                            owned_by: "t"
                        }
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

// Stub global fetch: every upstream attempt fails fast (dead credentials).
// Count calls to prove the cap bounds real upstream attempts.
let upstreamCalls = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
    resetRegistryCachesForTests();
    resetLocalRoutingStateForTests();
    invalidateFallbackRulesCache();
    upstreamCalls = 0;
    globalThis.fetch = (async () => {
        upstreamCalls++;
        throw new Error("upstream 401: expired credential");
    }) as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

async function runFailover(n: number, envExtra: Record<string, unknown> = {}, model = "th/test-model") {
    const masterKey = generateMasterKey();
    const rows = await Promise.all(
        Array.from({ length: n }, (_, i) => makeRow(`cap-acc-${i}`, masterKey))
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

describe("resolveMaxAttempts", () => {
    it("defaults to 10 when unset", () => {
        assert.equal(resolveMaxAttempts({} as Env), DEFAULT_MAX_ATTEMPTS);
        assert.equal(resolveMaxAttempts({} as Env), 10);
    });

    it("honors a valid SROUTER_MAX_ATTEMPTS", () => {
        assert.equal(resolveMaxAttempts({ SROUTER_MAX_ATTEMPTS: "3" } as Env), 3);
        assert.equal(resolveMaxAttempts({ SROUTER_MAX_ATTEMPTS: "50" } as Env), 50);
    });

    it("falls back to 10 for 0, negative, non-numeric, or empty values", () => {
        for (const v of ["0", "-3", "abc", "", "  "]) {
            assert.equal(resolveMaxAttempts({ SROUTER_MAX_ATTEMPTS: v } as Env), 10, `value: ${JSON.stringify(v)}`);
        }
    });
});

describe("failover attempt cap (end-to-end)", () => {
    it("15 failing candidates with default cap => exactly 10 upstream attempts", async () => {
        const outcome = await runFailover(15);
        assert.equal(outcome.status, 502);
        assert.equal(upstreamCalls, 10);
    });

    it("502 error detail indicates the cap was reached", async () => {
        const outcome = await runFailover(15);
        assert.match(outcome.message, /attempt_cap_reached/);
        assert.match(outcome.message, /attempted 10 of 15/);
    });

    it("fewer candidates than the cap => all tried, no cap note", async () => {
        const outcome = await runFailover(4);
        assert.equal(outcome.status, 502);
        assert.equal(upstreamCalls, 4);
        assert.doesNotMatch(outcome.message, /attempt_cap_reached/);
    });

    it("SROUTER_MAX_ATTEMPTS=3 => exactly 3 upstream attempts", async () => {
        const outcome = await runFailover(15, { SROUTER_MAX_ATTEMPTS: "3" });
        assert.equal(outcome.status, 502);
        assert.equal(upstreamCalls, 3);
        assert.match(outcome.message, /attempted 3 of 15/);
    });

    it("pinned single-account request is unaffected by the cap", async () => {
        // Pin selects exactly one account: one upstream attempt, no cap note.
        const outcome = await runFailover(15, {}, "th/test-model#cap-acc-3");
        assert.equal(outcome.status, 502);
        assert.equal(upstreamCalls, 1);
        assert.doesNotMatch(outcome.message, /attempt_cap_reached/);
    });
});
