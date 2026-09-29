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
//   POST /usage   { keyId, tokens, cost } -> accumulates usage deltas, flushes ~30s
//   GET  /health  -> { states: Record<accountId, CircuitView> }
//   POST /models  { models } -> caches aggregated model list
//   GET  /models  -> { models, cachedAt } | { models: null }
//   POST /refresh/try { accountId, ttlMs } -> { acquired: boolean }
//   POST /reset   { accountId? } -> clears circuit state (admin/debug)

import type { Env } from "../env.js";
import type { ModelObject } from "../vendor/types/index.js";

/** Batched usage flush cadence: POST /usage deltas land in D1 this often. */
const USAGE_FLUSH_INTERVAL_MS = 30_000;

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
/** Model catalog TTL. Exported so workers can implement stale-while-revalidate. */
export const MODEL_CACHE_TTL_MS = 5 * 60_000;
/**
 * Debounce window for circuit-breaker storage writes. report() used to do a
 * full-state storage.put per call; under load that serialized hundreds of
 * writes/sec on the single DO instance. Now writes coalesce per window —
 * in-memory state stays exact, only durability is delayed.
 */
const REPORT_SAVE_DEBOUNCE_MS = 1_000;

/**
 * RouterState sharding. The request path used to funnel every /route and
 * /report through the single "router" instance. Circuit-breaker and
 * round-robin state is naturally per-provider, so each provider type gets
 * its own shard — semantics-preserving, no single funnel.
 * The "router" instance keeps the global data: model catalog, OAuth refresh
 * locks, admin reset/health.
 */
export const ROUTER_GLOBAL_NAME = "router";
export function routerShardName(providerType: string): string {
    return `${ROUTER_GLOBAL_NAME}-${providerType}`;
}

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
    private env: Env;
    private state: PersistedState = emptyState();
    private loaded = false;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Batched virtual-key usage deltas: { keyId: { tokens, cost } }.
     * POST /usage accumulates here in memory; the DO alarm flushes to D1
     * (~30s). In-memory only by design (persisting per-request would defeat
     * the batching). Tradeoff: deltas are lost if the DO instance is evicted
     * before the alarm fires, and quota/credit reads lag up to ~30s.
     */
    private usageDeltas = new Map<string, { tokens: number; cost: number }>();
    private usageAlarmScheduled = false;

    constructor(ctx: DurableObjectState, env: Env) {
        this.ctx = ctx;
        this.env = env;
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

    /**
     * Coalesced write for hot paths (report()). In-memory state is updated
     * synchronously by the caller, so read-your-writes holds; only the
     * storage.put is delayed and coalesced within the window.
     */
    private saveDebounced(): void {
        if (this.saveTimer !== null) return;
        const fire = (): void => {
            this.saveTimer = null;
            this.save().catch(() => {});
        };
        if (typeof this.ctx.waitUntil === "function") {
            // Production: keep the isolate alive until the write lands.
            this.ctx.waitUntil(
                new Promise<void>((resolve) => {
                    this.saveTimer = setTimeout(() => {
                        fire();
                        resolve();
                    }, REPORT_SAVE_DEBOUNCE_MS);
                })
            );
        } else {
            // Unit-test stub has no waitUntil; a plain timer suffices.
            this.saveTimer = setTimeout(fire, REPORT_SAVE_DEBOUNCE_MS);
        }
    }

    /** Schedule the recurring usage-flush alarm (idempotent). */
    private scheduleUsageFlush(): void {
        if (this.usageAlarmScheduled) return;
        this.usageAlarmScheduled = true;
        // setAlarm may not exist on the unit-test stub; fall back to a timer.
        const storage = this.ctx.storage as DurableObjectStorage & {
            setAlarm?: (t: number) => Promise<void>;
        };
        if (typeof storage.setAlarm === "function") {
            void storage.setAlarm(Date.now() + USAGE_FLUSH_INTERVAL_MS);
        } else {
            setTimeout(() => void this.alarm(), USAGE_FLUSH_INTERVAL_MS);
        }
    }

    /**
     * Flush accumulated usage deltas to D1 in one batch. Increments arriving
     * while the flush runs are kept in the map (we swap the map before
     * writing, so nothing is lost or double-counted).
     */
    private async flushUsage(): Promise<void> {
        if (this.usageDeltas.size === 0) return;
        const batch = this.usageDeltas;
        this.usageDeltas = new Map();
        try {
            const stmts = [...batch.entries()].map(([keyId, d]) =>
                this.env.DB.prepare(
                    `UPDATE api_keys
                     SET usage_tokens = usage_tokens + ?,
                         usage_cost = usage_cost + ?
                     WHERE id = ?`
                ).bind(d.tokens, d.cost, keyId)
            );
            await this.env.DB.batch(stmts);
        } catch (err) {
            // Re-queue on failure so usage isn't silently dropped; the next
            // alarm will retry.
            for (const [keyId, d] of batch) {
                const cur = this.usageDeltas.get(keyId) ?? { tokens: 0, cost: 0 };
                cur.tokens += d.tokens;
                cur.cost += d.cost;
                this.usageDeltas.set(keyId, cur);
            }
            console.error("usage flush failed, re-queued", err);
        }
    }

    async alarm(): Promise<void> {
        await this.flushUsage();
        // Keep the alarm recurring while there's work; a fresh POST /usage
        // re-arms it. This avoids an eternal alarm on an idle DO.
        this.usageAlarmScheduled = false;
        if (this.usageDeltas.size > 0) {
            this.scheduleUsageFlush();
        }
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
        // Hot path: coalesce the storage write (see saveDebounced).
        this.saveDebounced();
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
            if (request.method === "POST" && url.pathname === "/usage") {
                // Batched virtual-key usage accounting. The worker POSTs one
                // delta per completed request (fire-and-forget); deltas
                // accumulate in memory and flush to D1 on the ~30s alarm.
                // This replaces the old per-request `UPDATE api_keys`, which
                // was a serialized D1 write on the hot path.
                const body = (await request.json()) as {
                    keyId?: string;
                    tokens?: number;
                    cost?: number;
                };
                if (typeof body.keyId === "string" && body.keyId) {
                    const cur = this.usageDeltas.get(body.keyId) ?? { tokens: 0, cost: 0 };
                    cur.tokens += typeof body.tokens === "number" ? body.tokens : 0;
                    cur.cost += typeof body.cost === "number" ? body.cost : 0;
                    this.usageDeltas.set(body.keyId, cur);
                    this.scheduleUsageFlush();
                }
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
                // Stale-while-revalidate: always serve what we have (even past
                // TTL); the worker decides freshness from cachedAt and rebuilds
                // in the background. { models: null } only when never built.
                return json({ models: cache?.models ?? null, cachedAt: cache?.cachedAt ?? null });
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
