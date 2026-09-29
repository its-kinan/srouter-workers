// Security regression tests for the dashboard hardening pass:
// - unauthenticated access to protected endpoints returns 401
// - security headers are present on dashboard HTML and API responses
// - login brute-force protection blocks both /v1 and legacy /api logins
// - session cookie carries HttpOnly / Secure / SameSite flags
// Run: npm test

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { app } from "../src/index.js";
import type { Env } from "../src/env.js";
import { hashPassword } from "../src/crypto/password.js";
import { resetLoginAttemptsForTests } from "../src/middleware/loginRateLimit.js";

// --- Minimal D1-compatible adapter over node:sqlite (same as dashboard.test.ts) ---

class D1Statement {
    constructor(
        private stmt: any,
        private params: unknown[] = []
    ) {}
    bind(...params: unknown[]): D1Statement {
        return new D1Statement(this.stmt, params);
    }
    async first<T = Record<string, unknown>>(): Promise<T | null> {
        const row = this.stmt.get(...this.params);
        return (row ?? null) as T | null;
    }
    async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
        return { results: this.stmt.all(...this.params) as T[] };
    }
    async run(): Promise<{ meta: { changes: number; last_row_id: number } }> {
        const info = this.stmt.run(...this.params);
        return {
            meta: {
                changes: Number(info.changes ?? 0),
                last_row_id: Number(info.lastInsertRowid ?? 0)
            }
        };
    }
}

class D1Adapter {
    constructor(private db: any) {}
    prepare(sql: string): D1Statement {
        return new D1Statement(this.db.prepare(sql));
    }
    async exec(sql: string): Promise<void> {
        this.db.exec(sql);
    }
}

let env: Env;
const ADMIN_PASSWORD = "sec-test-password-123";

function makeEnv(environment = "test"): Env {
    const db = new DatabaseSync(":memory:");
    const dir = join(process.cwd(), "src", "db", "migrations");
    for (const f of readdirSync(dir).sort()) {
        if (f.endsWith(".sql")) db.exec(readFileSync(join(dir, f), "utf8"));
    }
    return {
        DB: new D1Adapter(db) as unknown as D1Database,
        R2: {} as unknown as R2Bucket,
        SWITCH_STATE: {
            getByName: () => ({
                fetch: async () =>
                    new Response(JSON.stringify({ models: null }), {
                        headers: { "Content-Type": "application/json" }
                    })
            })
        } as unknown as DurableObjectNamespace,
        MASTER_KEY: Buffer.from("x".repeat(32)).toString("base64"),
        ENVIRONMENT: environment
    };
}

async function req(
    path: string,
    init?: RequestInit,
    useEnv?: Env
): Promise<{ status: number; body: any; headers: Headers }> {
    const res = await app.request(path, init, useEnv ?? env);
    const text = await res.text();
    let body: any = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = text;
    }
    return { status: res.status, body, headers: res.headers };
}

async function seedAdmin(forEnv: Env = env): Promise<void> {
    const hash = await hashPassword(ADMIN_PASSWORD);
    const now = Date.now();
    await forEnv.DB.prepare(
        "INSERT INTO admin_account (id, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?)"
    ).bind(hash, now, now).run();
}

function loginBody(): RequestInit {
    return {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: ADMIN_PASSWORD })
    };
}

function badLoginBody(): RequestInit {
    return {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "wrong-password" })
    };
}

describe("security hardening regressions", () => {
    before(async () => {
        env = makeEnv();
        await seedAdmin();
    });

    beforeEach(() => {
        // The brute-force map is per-isolate; reset so tests don't interact.
        resetLoginAttemptsForTests();
    });

    it("unauthenticated GET /v1/keys returns 401", async () => {
        const { status } = await req("/v1/keys");
        assert.equal(status, 401);
    });

    it("unauthenticated GET /api/admin/summary returns 401", async () => {
        const { status } = await req("/api/admin/summary");
        assert.equal(status, 401);
    });

    it("unauthenticated GET /v1/logs returns 401", async () => {
        const { status } = await req("/v1/logs");
        assert.equal(status, 401);
    });

    it("unauthenticated POST /v1/admin/change-password returns 401", async () => {
        const { status } = await req("/v1/admin/change-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ currentPassword: "x", newPassword: "y".repeat(16) })
        });
        assert.equal(status, 401);
    });

    it("dashboard HTML carries baseline security headers and a CSP", async () => {
        const { status, headers } = await req("/");
        assert.equal(status, 200);
        assert.equal(headers.get("x-content-type-options"), "nosniff");
        assert.equal(headers.get("x-frame-options"), "DENY");
        assert.ok(headers.get("referrer-policy"), "referrer-policy present");
        const csp = headers.get("content-security-policy");
        assert.ok(csp, "content-security-policy present on HTML shell");
        assert.ok(csp!.includes("default-src 'self'"), "CSP restricts to same-origin");
        assert.ok(csp!.includes("frame-ancestors 'none'"), "CSP forbids framing");
        assert.ok(csp!.includes("object-src 'none'"), "CSP forbids plugins");
    });

    it("JSON API responses carry baseline headers but no CSP", async () => {
        const { status, headers } = await req("/health");
        assert.equal(status, 200);
        assert.equal(headers.get("x-content-type-options"), "nosniff");
        assert.equal(headers.get("x-frame-options"), "DENY");
        assert.equal(headers.get("content-security-policy"), null);
    });

    it("login sets an HttpOnly SameSite=Lax session cookie", async () => {
        const { status, headers } = await req("/v1/admin/login", loginBody());
        assert.equal(status, 200);
        const setCookie = headers.get("set-cookie") ?? "";
        assert.ok(setCookie.length > 0, "session cookie set");
        assert.ok(/httponly/i.test(setCookie), "HttpOnly flag present");
        assert.ok(/samesite=lax/i.test(setCookie), "SameSite=Lax present");
        assert.ok(/path=\//i.test(setCookie), "Path=/ present");
    });

    it("session cookie is Secure in production", async () => {
        const prodEnv = makeEnv("production");
        await seedAdmin(prodEnv);
        const { status, headers } = await req("/v1/admin/login", loginBody(), prodEnv);
        assert.equal(status, 200);
        const setCookie = headers.get("set-cookie") ?? "";
        assert.ok(/;\s*secure/i.test(setCookie), `Secure flag present, got: ${setCookie}`);
    });

    it("/v1/admin/login blocks after 5 failed attempts", async () => {
        for (let i = 0; i < 5; i++) {
            const { status } = await req("/v1/admin/login", badLoginBody());
            assert.equal(status, 401, `attempt ${i + 1} should be 401`);
        }
        const { status, body } = await req("/v1/admin/login", badLoginBody());
        assert.equal(status, 429, "6th attempt is rate-limited");
        assert.equal(body.error.code, "login_rate_limited");
        // The block applies to correct credentials too while active.
        const blocked = await req("/v1/admin/login", loginBody());
        assert.equal(blocked.status, 429);
    });

    it("legacy /api/admin/login blocks after 5 failed attempts", async () => {
        for (let i = 0; i < 5; i++) {
            const { status } = await req("/api/admin/login", badLoginBody());
            assert.equal(status, 401, `attempt ${i + 1} should be 401`);
        }
        const { status } = await req("/api/admin/login", badLoginBody());
        assert.equal(status, 429, "6th attempt is rate-limited");
    });

    it("a successful login resets the failure counter", async () => {
        for (let i = 0; i < 4; i++) {
            await req("/v1/admin/login", badLoginBody());
        }
        const ok = await req("/v1/admin/login", loginBody());
        assert.equal(ok.status, 200);
        // Counter cleared: four more failures still don't trigger the block.
        for (let i = 0; i < 4; i++) {
            const { status } = await req("/v1/admin/login", badLoginBody());
            assert.equal(status, 401, `attempt ${i + 1} after reset should be 401`);
        }
        const { status } = await req("/v1/admin/login", badLoginBody());
        assert.equal(status, 401, "5th failure after reset is still 401");
    });
});
