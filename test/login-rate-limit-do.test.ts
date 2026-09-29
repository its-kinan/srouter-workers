// Distributed login rate limiting: the LoginRateLimit Durable Object is the
// global source of truth, shared across isolate (module) boundaries.
// - block triggers after 5 failures split across two middleware instances
//   (simulating two Cloudflare isolates) sharing one DO stub
// - successful login clears the counter via the DO
// - blocked IPs are served from the isolate-local fast-path cache (no DO call)
// - stale entries are pruned from DO storage
// - end-to-end: 5 bad /v1/admin/login attempts -> 429 on the 6th
// Run: npm test

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { app } from "../src/index.js";
import type { Env } from "../src/env.js";
import { hashPassword } from "../src/crypto/password.js";
import { LoginRateLimit, LOGIN_BLOCK_MS } from "../src/router/loginRateLimit.js";

// --- Minimal D1-compatible adapter over node:sqlite ---

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

// --- Fake DO plumbing: a real LoginRateLimit instance behind a stub namespace ---

function makeDo() {
    const stored = new Map<string, unknown>();
    const fakeCtx = {
        storage: {
            get: async (k: string) => stored.get(k) ?? null,
            put: async (k: string, v: unknown) => {
                stored.set(k, v);
            }
        },
        blockConcurrencyWhile: async (fn: () => Promise<void>) => {
            await fn();
        }
    };
    const instance = new LoginRateLimit(fakeCtx as unknown as DurableObjectState, {} as Env);
    return { instance, stored };
}

function makeLoginNs(
    instance: LoginRateLimit,
    onFetch?: () => void
): DurableObjectNamespace {
    return {
        idFromName: (_name: string) => ({ toString: () => "login-id" }),
        get: (_id: unknown) => ({
            fetch: (req: Request) => {
                onFetch?.();
                return instance.fetch(req);
            }
        })
    } as unknown as DurableObjectNamespace;
}

let env: Env;
let loginDo: ReturnType<typeof makeDo>;
let doFetchCount = 0;
const ADMIN_PASSWORD = "correct-horse-battery-staple-1";

function makeEnv(): Env {
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
        LOGIN_LIMIT: makeLoginNs(loginDo.instance, () => {
            doFetchCount++;
        }),
        MASTER_KEY: Buffer.from("x".repeat(32)).toString("base64"),
        ENVIRONMENT: "test"
    };
}

// Two module instances = two Cloudflare isolates. The query suffix makes Node
// treat them as separate modules (separate isolate-local caches); a
// non-literal specifier keeps tsc from trying to resolve the query string.
function isoModule(tag: string): Promise<any> {
    return import(`../src/middleware/loginRateLimit.js?${tag}`);
}

/** Minimal hono-Context stand-in: the middleware only uses req.header + env. */
function fakeCtx(ip: string, forEnv: Env = env): any {    return {
        req: { header: (name: string) => (name === "CF-Connecting-IP" ? ip : undefined) },
        env: forEnv
    };
}

async function req(
    path: string,
    init?: RequestInit,
    useEnv?: Env
): Promise<{ status: number; body: any }> {
    const res = await app.request(path, init, useEnv ?? env);
    const text = await res.text();
    let body: any = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = text;
    }
    return { status: res.status, body };
}

async function seedAdmin(forEnv: Env = env): Promise<void> {
    const hash = await hashPassword(ADMIN_PASSWORD);
    const now = Date.now();
    await forEnv.DB.prepare(
        "INSERT INTO admin_account (id, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?)"
    )
        .bind(hash, now, now)
        .run();
}

function badLoginBody(): RequestInit {
    return {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "wrong-password" })
    };
}

describe("distributed login rate limiting", () => {
    before(async () => {
        loginDo = makeDo();
        env = makeEnv();
        await seedAdmin();
    });

    beforeEach(() => {
        doFetchCount = 0;
    });

    it("block triggers after 5 failures split across two isolate instances sharing one DO", async () => {
        // Two module instances = two Cloudflare isolates; neither alone reaches 5.
        const iso1 = await isoModule("iso1");
        const iso2 = await isoModule("iso2");
        const ip = "10.9.9.1";
        for (let i = 0; i < 3; i++) await iso1.recordLoginFailure(fakeCtx(ip));
        for (let i = 0; i < 2; i++) await iso2.recordLoginFailure(fakeCtx(ip));
        // 3 + 2 = 5 across isolates -> globally blocked, visible from both.
        assert.equal(await iso1.isLoginBlocked(fakeCtx(ip)), true);
        assert.equal(await iso2.isLoginBlocked(fakeCtx(ip)), true);
        // A different IP is unaffected.
        assert.equal(await iso1.isLoginBlocked(fakeCtx("10.9.9.2")), false);
        await iso1.clearLoginFailures(fakeCtx(ip));
        // iso1 cleared its own fast-path cache together with the DO.
        assert.equal(await iso1.isLoginBlocked(fakeCtx(ip)), false);
        // The DO (source of truth) is clear; iso2's isolate-local fast-path
        // cache still holds the block until its 60s TTL expires, so query the
        // DO directly to assert the global state.
        const direct = await loginDo.instance.fetch(
            new Request("https://login-limit.local/check", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ip })
            })
        );
        assert.equal(((await direct.json()) as { blocked: boolean }).blocked, false);
    });

    it("blocked IPs are served from the isolate-local fast-path without a DO call", async () => {
        const mw = await isoModule("iso3");
        const ip = "10.8.8.8";
        for (let i = 0; i < 5; i++) await mw.recordLoginFailure(fakeCtx(ip));
        assert.equal(await mw.isLoginBlocked(fakeCtx(ip)), true);
        const callsBefore = doFetchCount;
        // Already cached as blocked: no DO round-trip.
        assert.equal(await mw.isLoginBlocked(fakeCtx(ip)), true);
        assert.equal(await mw.isLoginBlocked(fakeCtx(ip)), true);
        assert.equal(doFetchCount, callsBefore);
        await mw.clearLoginFailures(fakeCtx(ip));
    });

    it("successful login clears the counter via the DO (end-to-end)", async () => {
        const mw = await import("../src/middleware/loginRateLimit.js");
        const ip = "10.7.7.7";
        for (let i = 0; i < 4; i++) await mw.recordLoginFailure(fakeCtx(ip));
        await mw.clearLoginFailures(fakeCtx(ip));
        assert.equal(await mw.isLoginBlocked(fakeCtx(ip)), false);
        // Counter was cleared: 4 more failures still don't block.
        for (let i = 0; i < 4; i++) await mw.recordLoginFailure(fakeCtx(ip));
        assert.equal(await mw.isLoginBlocked(fakeCtx(ip)), false);
        await mw.clearLoginFailures(fakeCtx(ip));
    });

    it("end-to-end: 5 bad /v1/admin/login attempts -> 429 on the 6th", async () => {
        const mw = await import("../src/middleware/loginRateLimit.js");
        for (let i = 0; i < 5; i++) {
            const r = await req("/v1/admin/login", badLoginBody());
            assert.equal(r.status, 401);
        }
        const blocked = await req("/v1/admin/login", badLoginBody());
        assert.equal(blocked.status, 429);
        // Clean up: the real admin IP must not stay blocked.
        await mw.clearLoginFailures(fakeCtx("unknown"));
        const ok = await req("/v1/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: ADMIN_PASSWORD })
        });
        assert.equal(ok.status, 200);
    });

    it("DO persists state and prunes stale entries", async () => {
        const { instance, stored } = makeDo();
        const call = (path: string, ip: string) =>
            instance.fetch(
                new Request(`https://login-limit.local${path}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ip })
                })
            );
        // Record 5 failures -> blocked, and state must be in storage.
        for (let i = 0; i < 5; i++) await call("/attempt", "10.6.6.6");
        const check = (await (
            await call("/check", "10.6.6.6")
        ).json()) as { blocked: boolean; retryAfterMs: number };
        assert.equal(check.blocked, true);
        assert.ok(check.retryAfterMs > LOGIN_BLOCK_MS - 60_000);
        const persisted = stored.get("state") as Record<string, { count: number }>;
        assert.equal(persisted["10.6.6.6"].count, 5);
        // Stale entry (no block, untouched for 2h) is pruned on the next save.
        (instance as any).state["10.6.6.99"] = {
            count: 2,
            blockedUntil: 0,
            updatedAt: Date.now() - 2 * 60 * 60 * 1000
        };
        await call("/attempt", "10.6.6.100");
        assert.equal((instance as any).state["10.6.6.99"], undefined);
        assert.ok((instance as any).state["10.6.6.6"]);
        // Bad input rejected.
        const bad = await instance.fetch(
            new Request("https://login-limit.local/check", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({})
            })
        );
        assert.equal(bad.status, 400);
    });
});
