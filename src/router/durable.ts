// RouterState Durable Object — the stateful heart of the gateway.
//
// SRouter keeps this state in process memory (ProviderRegistry): round-robin
// indexes, per-account circuit-breaker health, the aggregated model-list cache,
// and in-flight OAuth-refresh dedup, plus a setInterval token sweeper.
// Workers are stateless per request, so this state lives here instead:
// one DO instance (name "router") per deployment.
//
// The DO never sees secrets: the Worker loads account rows from D1, decrypts
// them, and passes only lightweight AccountRefs for ordering decisions.
//
// RPC is plain fetch+JSON against the DO stub:
//
//   POST /route   { accounts: [{id, base}] } -> { orderedIds: string[] }
//   POST /report  { accountId, ok, error?, retryAfterMs? } -> { ok: true }
//   GET  /health  -> { states: Record<accountId, CircuitView> }
//   POST /models  { models } -> caches aggregated model list
//   GET  /models  -> { models, cachedAt } | { models: null }
//   POST /refresh/try { accountId, ttlMs } -> { acquired: boolean }
//   POST /reset   { accountId? } -> clears circuit state (admin/debug)

import type { Env } from "../env.js";
import type { ModelObject } from "../vendor/types/index.js";

export interface AccountRef {
    id: string;
    /** Provider base id, e.g. "antigravity" (round-robin rotates within a base). */
    base: string;
}

type CircuitStateName = "healthy" | "cooldown" | "exhausted";

interface CircuitEntry {
    state: CircuitStateName;
    consecutiveFailures: number;
    lastFailureTime?: number;
    lastSuccessTime?: number;
    lastErrorMessage?: string;
    cooldownUntil?: number;
}

interface PersistedState {
    roundRobin: Record<string, number>;
    circuit: Record<string, CircuitEntry>;
    modelCache: { models: ModelObject[]; cachedAt: number } | null;
    refreshLocks: Record<string, number>;
}

const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
const MODEL_CACHE_TTL_MS = 5 * 60_000;

const RATE_LIMIT_PATTERNS = [
    /rate\s*limit/i,
    /too\s+many\s+requests/i,
    /quota\s*(exceeded|exhausted|limit)/i,
    /resource\s*exhausted/i,
    /capacity/i,
    /high\s+traffic/i,
    /temporarily\s+unavailable/i
];

function isRateLimitError(message: string): boolean {
    return RATE_LIMIT_PATTERNS.some((p) => p.test(message));
}

const emptyState = (): PersistedState => ({
    roundRobin: {},
    circuit: {},
    modelCache: null,
    refreshLocks: {}
});

export class RouterState {
    private ctx: DurableObjectState;
    private state: PersistedState = emptyState();
    private loaded = false;

    constructor(ctx: DurableObjectState, _env: Env) {
        this.ctx = ctx;
    }

    private async load(): Promise<void> {
        if (this.loaded) return;
        await this.ctx.blockConcurrencyWhile(async () => {
            const stored = await this.ctx.storage.get<PersistedState>("state");
            if (stored) this.state = { ...emptyState(), ...stored };
            this.loaded = true;
        });
    }

    private save(): Promise<void> {
        return this.ctx.storage.put("state", this.state);
    }

    private healthOf(id: string): CircuitEntry {
        let h = this.state.circuit[id];
        if (!h) {
            h = { state: "healthy", consecutiveFailures: 0 };
            this.state.circuit[id] = h;
        }
        if (h.cooldownUntil && Date.now() >= h.cooldownUntil) {
            h.state = "healthy";
            h.cooldownUntil = undefined;
        }
        return h;
    }

    private async route(accounts: AccountRef[]): Promise<string[]> {
        const now = Date.now();
        const healthy: AccountRef[] = [];
        const cooling: { ref: AccountRef; remaining: number }[] = [];
        for (const ref of accounts) {
            const h = this.healthOf(ref.id);
            if (h.state === "healthy") healthy.push(ref);
            else cooling.push({ ref, remaining: Math.max(0, (h.cooldownUntil ?? now) - now) });
        }
        let ordered: AccountRef[];
        if (healthy.length > 0) {
            ordered = healthy;
        } else {
            cooling.sort((a, b) => a.remaining - b.remaining);
            ordered = cooling.map((c) => c.ref);
        }
        // Round-robin rotation within the first account's provider base,
        // mirroring SRouter's ProviderRegistry rotation among healthy accounts.
        if (ordered.length > 1) {
            const base = ordered[0]!.base;
            const idx = this.state.roundRobin[base] ?? 0;
            this.state.roundRobin[base] = (idx + 1) % ordered.length;
            ordered = [...ordered.slice(idx), ...ordered.slice(0, idx)];
            await this.save();
        }
        return ordered.map((r) => r.id);
    }

    private async report(
        accountId: string,
        ok: boolean,
        error?: string,
        retryAfterMs?: number
    ): Promise<void> {
        const h = this.healthOf(accountId);
        const now = Date.now();
        if (ok) {
            h.state = "healthy";
            h.consecutiveFailures = 0;
            h.lastSuccessTime = now;
            h.cooldownUntil = undefined;
            h.lastErrorMessage = undefined;
        } else {
            h.consecutiveFailures += 1;
            h.lastFailureTime = now;
            h.lastErrorMessage = (error ?? "unknown error").slice(0, 500);
            let cooldown = retryAfterMs;
            if (!cooldown || cooldown <= 0) {
                const multiplier = Math.min(Math.pow(2, h.consecutiveFailures - 1), 10);
                cooldown = Math.min(DEFAULT_COOLDOWN_MS * multiplier, MAX_COOLDOWN_MS);
            }
            h.state =
                isRateLimitError(h.lastErrorMessage) || h.consecutiveFailures < 5
                    ? "cooldown"
                    : "exhausted";
            h.cooldownUntil = now + cooldown;
        }
        await this.save();
    }

    async fetch(request: Request): Promise<Response> {
        await this.load();
        const url = new URL(request.url);
        const json = (v: unknown, status = 200) =>
            Response.json(v, { status });

        try {
            if (request.method === "POST" && url.pathname === "/route") {
                const body = (await request.json()) as { accounts: AccountRef[] };
                return json({ orderedIds: await this.route(body.accounts ?? []) });
            }
            if (request.method === "POST" && url.pathname === "/report") {
                const body = (await request.json()) as {
                    accountId: string;
                    ok: boolean;
                    error?: string;
                    retryAfterMs?: number;
                };
                await this.report(body.accountId, body.ok, body.error, body.retryAfterMs);
                return json({ ok: true });
            }
            if (request.method === "GET" && url.pathname === "/health") {
                const states: Record<string, CircuitEntry> = {};
                for (const id of Object.keys(this.state.circuit)) {
                    states[id] = this.healthOf(id);
                }
                return json({ states, roundRobin: this.state.roundRobin });
            }
            if (request.method === "POST" && url.pathname === "/models") {
                const body = (await request.json()) as { models: ModelObject[] };
                this.state.modelCache = { models: body.models ?? [], cachedAt: Date.now() };
                await this.save();
                return json({ ok: true });
            }
            if (request.method === "GET" && url.pathname === "/models") {
                const cache = this.state.modelCache;
                if (!cache || Date.now() - cache.cachedAt > MODEL_CACHE_TTL_MS) {
                    return json({ models: null, cachedAt: cache?.cachedAt ?? null });
                }
                return json({ models: cache.models, cachedAt: cache.cachedAt });
            }
            if (request.method === "POST" && url.pathname === "/refresh/try") {
                const body = (await request.json()) as { accountId: string; ttlMs: number };
                const now = Date.now();
                const heldUntil = this.state.refreshLocks[body.accountId] ?? 0;
                if (heldUntil > now) return json({ acquired: false });
                this.state.refreshLocks[body.accountId] = now + (body.ttlMs || 60_000);
                await this.save();
                return json({ acquired: true });
            }
            if (request.method === "POST" && url.pathname === "/reset") {
                const body = (await request.json().catch(() => ({}))) as { accountId?: string };
                if (body.accountId) delete this.state.circuit[body.accountId];
                else this.state.circuit = {};
                await this.save();
                return json({ ok: true });
            }
            return json({ error: "not found" }, 404);
        } catch (err) {
            return json(
                { error: err instanceof Error ? err.message : "internal error" },
                500
            );
        }
    }
}
