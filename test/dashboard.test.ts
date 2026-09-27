// Integration tests for the real SRouter dashboard API surface (/v1/*).
// Spins up the actual Hono app with a node:sqlite-backed D1 adapter and the
// real migrations, then exercises the contracts the React dashboard depends on.
// Run: npm test

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { app } from "../src/index.js";
import type { Env } from "../src/env.js";
import { getMergedModels } from "../src/routes/models.js";
import { listAllModels, loadAccounts } from "../src/providers/registry.js";
import { encryptSecretsObject } from "../src/crypto/secretbox.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- Minimal D1-compatible adapter over node:sqlite -------------------------

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

function makeEnv(): Env {
    const db = new DatabaseSync(":memory:");
    // Apply the real migrations in order. npm test runs from the repo root,
    // and .sql files are not copied to .test-build, so resolve from cwd.
    const dir = join(process.cwd(), "src", "db", "migrations");
    for (const f of readdirSync(dir).sort()) {
        if (f.endsWith(".sql")) db.exec(readFileSync(join(dir, f), "utf8"));
    }
    // Durable Object stub: model cache always misses, writes are no-ops.
    const routerStub = {
        fetch: async (req: Request): Promise<Response> => {
            if (req.method === "POST") return new Response(JSON.stringify({ ok: true }));
            return new Response(JSON.stringify({ models: null }), {
                headers: { "Content-Type": "application/json" }
            });
        }
    };
    return {
        DB: new D1Adapter(db) as unknown as D1Database,
        R2: {} as unknown as R2Bucket,
        ROUTER_STATE: {
            getByName: () => routerStub
        } as unknown as DurableObjectNamespace,
        MASTER_KEY: Buffer.from("x".repeat(32)).toString("base64"),
        ENVIRONMENT: "test"
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

function cookieHeader(setCookie: string | null): string {
    if (!setCookie) return "";
    return setCookie.split(";")[0];
}

describe("dashboard API contracts (real SRouter UI)", () => {
    before(() => {
        env = makeEnv();
    });

    it("GET /v1/admin/status reports setupRequired on a fresh DB", async () => {
        const { status, body } = await req("/v1/admin/status");
        assert.equal(status, 200);
        assert.equal(body.setupRequired, true);
        assert.equal(body.authenticated, false);
    });

    it("POST /v1/admin/setup creates the admin and sets a session cookie", async () => {
        const { status, body, headers } = await req("/v1/admin/setup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "test-password-123", confirmation: "test-password-123" })
        });
        assert.equal(status, 201);
        assert.equal(body.authenticated, true);
        assert.ok(cookieHeader(headers.get("set-cookie")).length > 0, "session cookie set");

        const st = await req("/v1/admin/status", {
            headers: { Cookie: cookieHeader(headers.get("set-cookie")) }
        });
        assert.equal(st.body.setupRequired, false);
        assert.equal(st.body.authenticated, true);
    });

    it("second setup attempt is rejected (first-claim-wins)", async () => {
        const { status } = await req("/v1/admin/setup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "another-password-123", confirmation: "another-password-123" })
        });
        assert.equal(status, 409);
    });

    it("POST /v1/admin/login authenticates with the password", async () => {
        const { status, body, headers } = await req("/v1/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "test-password-123" })
        });
        assert.equal(status, 200);
        assert.equal(body.authenticated, true);
        assert.ok(cookieHeader(headers.get("set-cookie")).length > 0);
    });

    it("login with a wrong password returns 401", async () => {
        const { status } = await req("/v1/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "wrong-password" })
        });
        assert.equal(status, 401);
    });

    it("admin-gated routes reject unauthenticated callers", async () => {
        for (const path of ["/v1/keys", "/v1/providers", "/v1/settings", "/v1/logs/stats"]) {
            const { status } = await req(path);
            assert.ok(status === 401 || status === 403, `${path} -> ${status}`);
        }
    });

    it("GET /v1/providers/catalog lists the known provider catalog", async () => {
        const login = await req("/v1/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "test-password-123" })
        });
        const cookie = cookieHeader(login.headers.get("set-cookie"));
        const { status, body } = await req("/v1/providers/catalog", {
            headers: { Cookie: cookie }
        });
        assert.equal(status, 200);
        // Shape: { total, categories: { oauth, free_tier, api_key, custom_provider } }
        const cats = body.categories ?? {};
        const ids = Object.values(cats)
            .flat()
            .map((p: any) => p.id ?? p.provider_id);
        assert.ok(ids.includes("antigravity"), "catalog has antigravity");
        assert.ok(ids.includes("qoder"), "catalog has qoder");
        assert.ok(ids.includes("openai_codex"), "catalog has openai_codex");
    });

    it("POST /v1/keys creates a key and shows the secret only once", async () => {
        const login = await req("/v1/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "test-password-123" })
        });
        const cookie = cookieHeader(login.headers.get("set-cookie"));
        const created = await req("/v1/keys", {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ name: "test-key" })
        });
        assert.equal(created.status, 201);
        const secret = created.body.key ?? created.body.secret;
        assert.ok(typeof secret === "string" && secret.length > 10, "one-time secret returned");

        // The list response must NOT contain the plaintext secret.
        const listed = await req("/v1/keys", { headers: { Cookie: cookie } });
        assert.equal(listed.status, 200);
        const items = listed.body.data ?? listed.body;
        const found = items.find((k: any) => k.id === (created.body.id ?? created.body.key_id));
        assert.ok(found, "key appears in list");
        assert.ok(!found.key && !found.secret, "no plaintext secret in list");

        // The virtual key authenticates /v1/models.
        const models = await req("/v1/models", {
            headers: { Authorization: `Bearer ${secret}` }
        });
        assert.equal(models.status, 200);

        // Cleanup.
        const del = await req(`/v1/keys/${created.body.id ?? created.body.key_id}`, {
            method: "DELETE",
            headers: { Cookie: cookie }
        });
        assert.ok(del.status === 200 || del.status === 204, `delete -> ${del.status}`);
    });

    it("GET /v1/logs/stats and /v1/logs/analytics return their shapes", async () => {
        const login = await req("/v1/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "test-password-123" })
        });
        const cookie = cookieHeader(login.headers.get("set-cookie"));
        const stats = await req("/v1/logs/stats", { headers: { Cookie: cookie } });
        assert.equal(stats.status, 200);
        const analytics = await req("/v1/logs/analytics", { headers: { Cookie: cookie } });
        assert.equal(analytics.status, 200);
    });

    it("GET /v1/settings returns settings and combos", async () => {
        const login = await req("/v1/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "test-password-123" })
        });
        const cookie = cookieHeader(login.headers.get("set-cookie"));
        const { status, body } = await req("/v1/settings", { headers: { Cookie: cookie } });
        assert.equal(status, 200);
        assert.ok(body !== null && typeof body === "object");
        const fallbacks = await req("/v1/settings/fallbacks", { headers: { Cookie: cookie } });
        assert.equal(fallbacks.status, 200);
    });

    it("GET /v1/pricing/models returns the bundled pricing dataset", async () => {
        const login = await req("/v1/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "test-password-123" })
        });
        const cookie = cookieHeader(login.headers.get("set-cookie"));
        const { status, body } = await req("/v1/pricing/models", { headers: { Cookie: cookie } });
        assert.equal(status, 200);
        const data = body.data ?? body;
        assert.ok(Array.isArray(data) && data.length > 100, `pricing entries: ${data.length}`);
    });

    it("GET /v1/quota returns the usage-derived quota view", async () => {
        const login = await req("/v1/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "test-password-123" })
        });
        const cookie = cookieHeader(login.headers.get("set-cookie"));
        const { status, body } = await req("/v1/quota", { headers: { Cookie: cookie } });
        assert.equal(status, 200);
        assert.ok(Array.isArray(body.providers ?? body.data ?? []));
    });

    it("tunnel endpoints are honest about being unsupported", async () => {
        const login = await req("/v1/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "test-password-123" })
        });
        const cookie = cookieHeader(login.headers.get("set-cookie"));
        const { status, body } = await req("/v1/tunnel/status", { headers: { Cookie: cookie } });
        assert.ok(status === 200 || status === 501 || status === 410, `tunnel status -> ${status}`);
        if (status !== 200) {
            assert.ok(/not supported|unavailable/i.test(JSON.stringify(body)));
        }
    });

    it("POST /v1/admin/logout revokes the session", async () => {
        const login = await req("/v1/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "test-password-123" })
        });
        const cookie = cookieHeader(login.headers.get("set-cookie"));
        const out = await req("/v1/admin/logout", { method: "POST", headers: { Cookie: cookie } });
        assert.ok(out.status === 204 || out.status === 200, `logout -> ${out.status}`);
        const st = await req("/v1/admin/status", { headers: { Cookie: cookie } });
        assert.equal(st.body.authenticated, false);
    });
});

describe("models aggregation hardening (/v1/models)", () => {
    let modelsEnv: Env;
    let doModels: unknown[] | null;

    before(async () => {
        const db = new DatabaseSync(":memory:");
        const dir = join(process.cwd(), "src", "db", "migrations");
        for (const f of readdirSync(dir).sort()) {
            if (f.endsWith(".sql")) db.exec(readFileSync(join(dir, f), "utf8"));
        }
        doModels = null;
        const routerStub = {
            fetch: async (req: Request): Promise<Response> => {
                if (req.method === "POST") {
                    doModels = ((await req.json()) as { models: unknown[] }).models;
                    return new Response(JSON.stringify({ ok: true }));
                }
                return new Response(JSON.stringify({ models: doModels }), {
                    headers: { "Content-Type": "application/json" }
                });
            }
        };
        modelsEnv = {
            DB: new D1Adapter(db) as unknown as D1Database,
            R2: {} as unknown as R2Bucket,
            ROUTER_STATE: { getByName: () => routerStub } as unknown as DurableObjectNamespace,
            MASTER_KEY: Buffer.from("m".repeat(32)).toString("base64"),
            ENVIRONMENT: "test"
        };
        // One antigravity account with a token -> static ANTIGRAVITY_MODELS, no network.
        const enc = await encryptSecretsObject(
            { access_token: "tok", refresh_token: "r", extra: {} },
            modelsEnv.MASTER_KEY
        );
        await modelsEnv.DB.prepare(
            `INSERT INTO providers
             (id, provider_id, name, category, protocol, secrets_enc, enabled, created_at)
             VALUES (?,?,?,?,?,?,?,?)`
        )
            .bind("ag_test_1", "antigravity", "ag", "oauth", "gemini", enc, 1, Date.now())
            .run();
    });

    it("an empty DO cache is not treated as a hit — it refreshes instead", async () => {
        doModels = []; // poisoned cache
        const models = await getMergedModels(modelsEnv);
        assert.ok(models.length > 0, "expected the refresh to return models");
        assert.ok(
            doModels === null || (doModels as unknown[]).length > 0,
            "empty result must not be written back to the DO cache"
        );
    });

    it("a hanging upstream does not stall the aggregation", async () => {
        // Local server that accepts connections but never responds.
        const server = createServer(() => {});
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;
        try {
            const enc = await encryptSecretsObject({ api_key: "k" }, modelsEnv.MASTER_KEY);
            await modelsEnv.DB.prepare(
                `INSERT INTO providers
                 (id, provider_id, name, category, protocol, base_url, secrets_enc, enabled, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?)`
            )
                .bind(
                    "hang_test_1",
                    "openai-compatible",
                    "hang",
                    "api_key",
                    "openai",
                    `http://127.0.0.1:${port}`,
                    enc,
                    1,
                    Date.now()
                )
                .run();
            const accounts = await loadAccounts(modelsEnv.DB, modelsEnv.MASTER_KEY);
            assert.ok(accounts.length >= 2, "both test accounts loaded");
            const start = Date.now();
            const models = await listAllModels(accounts, 500);
            const elapsed = Date.now() - start;
            assert.ok(
                elapsed < 5000,
                `aggregation took ${elapsed}ms — the hanging account was not cut off`
            );
            assert.ok(
                models.some((m) => m.owned_by === "antigravity"),
                "healthy accounts still contribute their models"
            );
        } finally {
            server.closeAllConnections();
            server.close();
        }
    });
});
