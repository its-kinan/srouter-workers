// Tests for stealth header fingerprints (src/providers/fingerprints.ts).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_FINGERPRINTS, applyStealth, parseOperatorOverrides, resolveStealthHeaders, sanitizeStealthHeaders, stealthForAccount } from "../src/providers/fingerprints.js";
describe("sanitizeStealthHeaders", () => {
    it("strips protected auth headers case-insensitively", () => {
        const out = sanitizeStealthHeaders({
            "User-Agent": "foo/1.0",
            Authorization: "Bearer secret",
            "X-Goog-Api-Key": "key",
            "x-goog-api-client": "gl-node",
            Cookie: "a=b",
            "X-Custom": "ok"
        });
        assert.deepEqual(out, { "User-Agent": "foo/1.0", "X-Custom": "ok" });
    });
    it("returns empty object for null/undefined/non-object", () => {
        assert.deepEqual(sanitizeStealthHeaders(null), {});
        assert.deepEqual(sanitizeStealthHeaders(undefined), {});
    });
    it("drops non-string values", () => {
        const out = sanitizeStealthHeaders({ "X-Ok": "yes", "X-Bad": 42 });
        assert.deepEqual(out, { "X-Ok": "yes" });
    });
});
describe("resolveStealthHeaders", () => {
    it("returns preset for known provider", () => {
        const out = resolveStealthHeaders("qoder");
        assert.equal(out["User-Agent"], "qodercli/1.0.0");
    });
    it("returns empty for unknown provider", () => {
        assert.deepEqual(resolveStealthHeaders("nope"), {});
    });
    it("per-credential wins over preset, operator in the middle", () => {
        const out = resolveStealthHeaders("qoder", { "User-Agent": "cred/9.9" }, { "User-Agent": "op/1.0", "X-Op": "1" });
        assert.equal(out["User-Agent"], "cred/9.9");
        assert.equal(out["X-Op"], "1");
        // preset-only header survives
        assert.equal(out["Cosy-Version"], PROVIDER_FINGERPRINTS["qoder"]["Cosy-Version"]);
    });
    it("never leaks protected headers from any layer", () => {
        const out = resolveStealthHeaders("qoder", { Authorization: "Bearer x" }, { "X-Goog-Api-Key": "y" });
        assert.ok(!("Authorization" in out));
        assert.ok(!("X-Goog-Api-Key" in out));
    });
});
describe("applyStealth", () => {
    it("precedence: preset < executor defaults < per-credential", () => {
        const out = applyStealth({ "User-Agent": "exec/1.0", "X-Exec": "1" }, { preset: { "User-Agent": "preset/1.0", "X-Preset": "1" }, perCredential: { "User-Agent": "cred/1.0" } });
        assert.equal(out["User-Agent"], "cred/1.0");
        assert.equal(out["X-Exec"], "1");
        assert.equal(out["X-Preset"], "1");
    });
    it("preset fills gaps without overriding executor defaults", () => {
        const out = applyStealth({ "Content-Type": "application/json" }, { preset: { "User-Agent": "preset/1.0" } });
        assert.equal(out["User-Agent"], "preset/1.0");
        assert.equal(out["Content-Type"], "application/json");
    });
    it("returns copy of defaults when no stealth", () => {
        const out = applyStealth({ A: "1" }, null);
        assert.deepEqual(out, { A: "1" });
    });
});
describe("stealthForAccount", () => {
    it("builds bundle with preset and sanitized per-credential", () => {
        const s = stealthForAccount("grok-cli", { "X-Custom": "v", Authorization: "Bearer x" });
        assert.equal(s.preset["User-Agent"], "grok-shell/0.2.99 (linux; x86_64)");
        assert.deepEqual(s.perCredential, { "X-Custom": "v" });
    });
});
describe("parseOperatorOverrides", () => {
    it("parses per-provider and global shapes", () => {
        const { perProvider, global } = parseOperatorOverrides(JSON.stringify({ qoder: { "User-Agent": "q/2.0" }, "X-Global": "g" }));
        assert.deepEqual(perProvider, { qoder: { "User-Agent": "q/2.0" } });
        assert.deepEqual(global, { "X-Global": "g" });
    });
    it("returns empty on invalid JSON or empty input", () => {
        assert.deepEqual(parseOperatorOverrides("not json"), { perProvider: {}, global: {} });
        assert.deepEqual(parseOperatorOverrides(""), { perProvider: {}, global: {} });
        assert.deepEqual(parseOperatorOverrides(null), { perProvider: {}, global: {} });
    });
    it("strips protected headers from overrides", () => {
        const { global } = parseOperatorOverrides(JSON.stringify({ Authorization: "Bearer x" }));
        assert.deepEqual(global, {});
    });
});
