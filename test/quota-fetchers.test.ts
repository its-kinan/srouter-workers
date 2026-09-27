// Tests for live quota fetchers (format helpers) and the rate limit middleware.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatResetIn, isLiveQuotaSupported } from "../src/quota/fetchers.js";

describe("quota fetchers", () => {
    it("supports only antigravity, codebuddy-cn, openai_codex", () => {
        assert.equal(isLiveQuotaSupported("antigravity"), true);
        assert.equal(isLiveQuotaSupported("openai_codex"), true);
        assert.equal(isLiveQuotaSupported("codebuddy-cn"), true);
        assert.equal(isLiveQuotaSupported("qoder"), false);
        assert.equal(isLiveQuotaSupported("openai-compatible"), false);
        assert.equal(isLiveQuotaSupported("grok-cli"), false);
    });

    it("formatResetIn handles missing/past/future", () => {
        assert.equal(formatResetIn(undefined), "24h 0m");
        assert.equal(formatResetIn(new Date(Date.now() - 1000).toISOString()), "0m");
        const future = new Date(Date.now() + 90 * 60 * 1000).toISOString();
        assert.match(formatResetIn(future), /1h 30m/);
    });
});
