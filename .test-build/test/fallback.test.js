// Tests for fallback combo routing (src/routing/fallback.ts).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractStatusCode, resolveCandidates, runCandidateAttempts, shouldTriggerFallback } from "../src/routing/fallback.js";
function rule(over = {}) {
    return {
        id: "fb_1",
        sourceModel: "openai/gpt-4",
        targetModel: "openai/gpt-3.5-turbo",
        priority: 1,
        enabled: true,
        maxRetries: 1,
        ...over
    };
}
// Minimal D1Database stub: prepare().all() returns enabled rows,
// mirroring the real query's WHERE enabled = 1.
function fakeDb(rows) {
    return {
        prepare: () => ({
            all: async () => ({ results: rows.filter((r) => r.enabled === 1) })
        })
    };
}
function row(source, target, priority = 1, enabled = 1, trigger = null) {
    return {
        id: `fb_${source}_${target}`,
        source_model: source,
        target_model: target,
        priority,
        enabled,
        trigger_on_status: trigger,
        max_retries: 1
    };
}
describe("extractStatusCode", () => {
    it("reads status/statusCode fields", () => {
        assert.equal(extractStatusCode({ status: 429 }), 429);
        assert.equal(extractStatusCode({ statusCode: 503 }), 503);
    });
    it("maps not-found messages to 404", () => {
        assert.equal(extractStatusCode(new Error("model not found")), 404);
    });
    it("extracts codes from message text", () => {
        assert.equal(extractStatusCode("Upstream error 502 bad gateway"), 502);
    });
    it("returns undefined for unknown errors", () => {
        assert.equal(extractStatusCode(new Error("weird failure")), undefined);
    });
});
describe("shouldTriggerFallback", () => {
    it("disabled rule never triggers", () => {
        assert.equal(shouldTriggerFallback(rule({ enabled: false }), new Error("429")), false);
    });
    it("no trigger_on_status triggers on any error", () => {
        assert.equal(shouldTriggerFallback(rule(), new Error("boom")), true);
    });
    it("trigger_on_status matches extracted code", () => {
        assert.equal(shouldTriggerFallback(rule({ triggerOnStatus: [429] }), new Error("rate limited 429")), true);
        // Note: a rate-limit *message* still triggers even when the status
        // filter doesn't match — this mirrors the original's policy.
        assert.equal(shouldTriggerFallback(rule({ triggerOnStatus: [500] }), new Error("rate limited 429")), true);
        assert.equal(shouldTriggerFallback(rule({ triggerOnStatus: [500] }), new Error("bad request 400")), false);
    });
    it("rate-limit message triggers even without status match", () => {
        assert.equal(shouldTriggerFallback(rule({ triggerOnStatus: [500] }), new Error("Rate limit exceeded")), true);
    });
});
describe("resolveCandidates", () => {
    it("returns just the original model when no rules match", async () => {
        const db = fakeDb([row("other/model", "other/fallback")]);
        const c = await resolveCandidates(db, "openai/gpt-4");
        assert.deepEqual(c.map((x) => x.model), ["openai/gpt-4"]);
    });
    it("appends matching targets ordered by priority", async () => {
        const db = fakeDb([
            row("openai/gpt-4", "openai/gpt-3.5-turbo", 2),
            row("openai/gpt-4", "antigravity/gemini", 1)
        ]);
        const c = await resolveCandidates(db, "openai/gpt-4");
        assert.deepEqual(c.map((x) => x.model), [
            "openai/gpt-4",
            "antigravity/gemini",
            "openai/gpt-3.5-turbo"
        ]);
        assert.ok(c[1].rule);
        assert.equal(c[1].rule.targetModel, "antigravity/gemini");
    });
    it("supports prefix/* wildcards and * catch-all", async () => {
        const db = fakeDb([
            row("openai/*", "openai/fallback", 1),
            row("*", "qoder/fallback", 1)
        ]);
        const c = await resolveCandidates(db, "openai/gpt-4");
        assert.deepEqual(c.map((x) => x.model), [
            "openai/gpt-4",
            "openai/fallback",
            "qoder/fallback"
        ]);
    });
    it("skips disabled rules and self-targets", async () => {
        const db = fakeDb([
            row("openai/gpt-4", "openai/other", 1, 0),
            row("openai/gpt-4", "openai/gpt-4", 1, 1)
        ]);
        const c = await resolveCandidates(db, "openai/gpt-4");
        assert.deepEqual(c.map((x) => x.model), ["openai/gpt-4"]);
    });
});
describe("runCandidateAttempts", () => {
    it("yields original then fallback when the error triggers", async () => {
        const db = fakeDb([row("openai/gpt-4", "openai/gpt-3.5-turbo")]);
        const tracker = {
            fallbackPath: ["openai/gpt-4"],
            fallbackOccurred: false,
            lastError: null
        };
        const seen = [];
        for await (const a of runCandidateAttempts(db, "openai/gpt-4", tracker)) {
            seen.push(a.currentModel + (a.isFallbackAttempt ? " (fb)" : ""));
            if (!a.isFallbackAttempt)
                tracker.lastError = new Error("429 rate limited");
        }
        assert.deepEqual(seen, ["openai/gpt-4", "openai/gpt-3.5-turbo (fb)"]);
    });
    it("skips fallback when the rule does not trigger", async () => {
        const db = fakeDb([
            row("openai/gpt-4", "openai/gpt-3.5-turbo", 1, 1, JSON.stringify([500]))
        ]);
        const tracker = {
            fallbackPath: ["openai/gpt-4"],
            fallbackOccurred: false,
            lastError: null
        };
        const seen = [];
        for await (const a of runCandidateAttempts(db, "openai/gpt-4", tracker)) {
            seen.push(a.currentModel);
            if (!a.isFallbackAttempt)
                tracker.lastError = new Error("bad request 400");
        }
        assert.deepEqual(seen, ["openai/gpt-4"]);
    });
});
