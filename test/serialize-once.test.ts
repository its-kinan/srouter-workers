// Serialize-once + adaptive hedge delay (src/router/completion.ts,
// src/vendor/executors/openai.ts):
// - OpenAIExecutor.serializeChatPayload() builds the exact upstream payload
//   the old inline translation produced (model stripped, stream flag,
//   stream_options.include_usage for streams).
// - A req carrying PRE_SERIALIZED_BODY is sent byte-identical upstream
//   (no re-serialization) — the router caches one string per
//   (providerType, upstreamModel) and reuses it across failover/hedge
//   attempts, saving JSON.stringify per attempt on large prompts.
// - resolveEffectiveHedgeDelayMs() raises the hedge delay for slow-TTFB
//   models (observed EMA) so the hedge doesn't fire on every request.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OpenAIExecutor } from "../src/vendor/executors/openai.js";
import { PRE_SERIALIZED_BODY } from "../src/vendor/types/provider.js";
import {
    minTtfbEmaMs,
    recordLatencySample,
    resetLocalRoutingStateForTests,
    resolveEffectiveHedgeDelayMs,
    SLOW_MODEL_HEDGE_FACTOR
} from "../src/router/completion.js";
import type { AccountMeta } from "../src/providers/registry.js";

function makeMeta(id: string): AccountMeta {
    return {
        id,
        providerType: "atria",
        name: id,
        category: "api_key",
        protocol: "openai",
        extra: {},
        enabled: true,
        secretsEnc: null
    } as AccountMeta;
}

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

describe("OpenAIExecutor.serializeChatPayload", () => {
    const ex = new OpenAIExecutor({ baseUrl: "https://example.test/v1", apiKey: "k" });

    it("stream payload: strips provider prefix, forces stream + include_usage", () => {
        const body = ex.serializeChatPayload(
            { model: "atria/Atria-Dawn-Preview", messages: [{ role: "user", content: "hi" }] } as never,
            true
        );
        const parsed = JSON.parse(body);
        assert.equal(parsed.model, "Atria-Dawn-Preview");
        assert.equal(parsed.stream, true);
        assert.equal(parsed.stream_options.include_usage, true);
        assert.deepEqual(parsed.messages, [{ role: "user", content: "hi" }]);
    });

    it("non-stream payload: stream false, no stream_options", () => {
        const body = ex.serializeChatPayload(
            { model: "Atria-Dawn-Preview", messages: [] } as never,
            false
        );
        const parsed = JSON.parse(body);
        assert.equal(parsed.model, "Atria-Dawn-Preview");
        assert.equal(parsed.stream, false);
        assert.equal(parsed.stream_options, undefined);
    });

    it("chatCompletionStream sends the pre-serialized body byte-identical", async () => {
        const sentinel = '{"model":"Atria-Dawn-Preview","stream":true,"sentinel":42}';
        let seenBody: unknown;
        globalThis.fetch = (async (_url: unknown, init: any) => {
            seenBody = init.body;
            return new Response("data: [DONE]\n\n", { status: 200 });
        }) as typeof fetch;

        const req = {
            model: "atria/Atria-Dawn-Preview",
            messages: [{ role: "user", content: "x".repeat(1000) }]
        } as never;
        (req as Record<symbol, unknown>)[PRE_SERIALIZED_BODY] = sentinel;
        const chunks = [];
        for await (const c of ex.chatCompletionStream(req)) chunks.push(c);
        assert.equal(seenBody, sentinel);
    });

    it("chatCompletionStream serializes itself when no pre-serialized body", async () => {
        let seenBody: unknown;
        globalThis.fetch = (async (_url: unknown, init: any) => {
            seenBody = init.body;
            return new Response(JSON.stringify({ choices: [] }), { status: 200 });
        }) as typeof fetch;

        const res = await ex.chatCompletion({
            model: "atria/Atria-Dawn-Preview",
            messages: [{ role: "user", content: "hi" }]
        } as never);
        assert.ok(res);
        const parsed = JSON.parse(seenBody as string);
        assert.equal(parsed.model, "Atria-Dawn-Preview");
        assert.equal(parsed.stream, false);
    });
});

describe("adaptive hedge delay", () => {
    beforeEach(() => resetLocalRoutingStateForTests());

    it("no samples: keeps the configured delay", () => {
        const cands = [makeMeta("a1"), makeMeta("a2")];
        assert.equal(resolveEffectiveHedgeDelayMs(2000, cands, "atria/Atria-Dawn-Preview"), 2000);
        assert.equal(minTtfbEmaMs(cands, "atria/Atria-Dawn-Preview"), undefined);
    });

    it("fast model (EMA below delay): keeps the configured delay", () => {
        const cands = [makeMeta("a1")];
        recordLatencySample("a1", "atria/Atria-Dawn-Preview", 800);
        assert.equal(resolveEffectiveHedgeDelayMs(2000, cands, "atria/Atria-Dawn-Preview"), 2000);
    });

    it("slow model (EMA above delay): raises to EMA * factor", () => {
        const cands = [makeMeta("a1"), makeMeta("a2")];
        recordLatencySample("a1", "atria/Atria-Dawn-Preview", 8000);
        recordLatencySample("a2", "atria/Atria-Dawn-Preview", 12000);
        // min EMA = 8000 → 8000 * 1.5 = 12000
        const got = resolveEffectiveHedgeDelayMs(2000, cands, "atria/Atria-Dawn-Preview");
        assert.equal(got, Math.ceil(8000 * SLOW_MODEL_HEDGE_FACTOR));
    });

    it("disabled hedging (<= 0) stays disabled regardless of EMA", () => {
        const cands = [makeMeta("a1")];
        recordLatencySample("a1", "m", 30000);
        assert.equal(resolveEffectiveHedgeDelayMs(0, cands, "m"), 0);
        assert.equal(resolveEffectiveHedgeDelayMs(-1, cands, "m"), -1);
    });
});
