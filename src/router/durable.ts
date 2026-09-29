// SwitchState Durable Object — the stateful heart of the gateway.
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
//   POST /report  { accountId, ok, error?, retryAfterMs?, latencyMs? } -> { ok: true }
//                   latencyMs = time-to-first-chunk for this attempt; feeds the
//                   per-account latency EMA (successes only) used for the admin
//                   health view. The worker's request-path ordering keeps its
//                   own isolate-local EMA — the DO copy is the durable record.
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
    /**
     * Per-account upstream latency EMA (time-to-first-chunk, ms), updated on
     * successful attempts only — failures must not poison it. Surfaced in
     * GET /health for the admin view; pruned on save (stale entries dropped,
     * map capped).
     */
    latency: Record<string, { ema: number; samples: number; updatedAt: number }>;
    /**
     * Per-(account, model) latency EMA, keyed by latencyPairKey(). An
     * account can be fast for one model and slow for another; the router
     * prefers the pair-specific EMA and falls back to the account-level one.
     * Same update/prune/cap discipline as `latency`.
     */
    latencyPairs: Record<string, { ema: number; samples: number; updatedAt: number }>;
    /**
     * Per-account response-quality tracking (decayed counters): `bad`
     * counts completed streams that produced no usable output (zero
     * completion tokens, no text, no tool calls); `total` counts all
     * completed streams. The router multiplies the account's latency EMA by
     * (1 + 3 * bad/total) once enough samples exist — deprioritized, never
     * hard-excluded (the circuit breaker still owns hard failures).
     */
    quality: Record<string, { bad: number; total: number; updatedAt: number }>;
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
 * SwitchState sharding. The request path used to funnel every /route and
 * /report through the single "router" instance. Circuit-breaker and
 * round-robin state is naturally per-provider, so each provider type gets
 * its own shard — semantics-preserving, no single funnel.
 * The "router" instance keeps the global data: model catalog, OAuth refresh
 * locks, admin reset/health.
 */
export const SWITCH_GLOBAL_NAME = "switch";
export function switchShardName(providerType: string): string {
    return `${SWITCH_GLOBAL_NAME}-${providerType}`;
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
    refreshLocks: {},
    latency: {},
    latencyPairs: {},
    quality: {}
});

/** EMA weight for each new latency sample (successes only). */
const LATENCY_EMA_ALPHA = 0.2;
/** Drop latency entries not seen in this long (stale accounts). */
const LATENCY_STALE_MS = 24 * 60 * 60 * 1000;
/** Cap on stored latency entries (only recently-seen accounts are kept). */
const MAX_LATENCY_ENTRIES = 1000;
/** Decay per quality sample; recent attempts dominate the bad-rate. */
const QUALITY_DECAY = 0.9;
/** Cap on stored quality entries. */
const MAX_QUALITY_ENTRIES = 1000;

/**
 * Composite key for per-(account, model) latency tracking. "\n" cannot
 * appear in account ids or model names, so the key is unambiguous and
 * prefix-deletable per account. Shared with the worker's isolate-local
 * pair map (completion.ts imports this).
 */
export function latencyPairKey(accountId: string, model: string): string {
    return `${accountId}\n${model}`;
}

export class SwitchState {
    private ctx: DurableObjectState;
    private env: Env;
    private state: PersistedState = emptyState();
    private loaded = false;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Batched virtual-key usage deltas, persisted in DO storage as
     * [keyId, { tokens, cost }][] under "usageDeltas".
     * POST /usage merges one delta per completed request; the DO alarm
     * flushes to D1 (~30s). Storage (not memory) is the source of truth
     * because DO instances are evicted when idle — a fresh instance waking
     * for the alarm must still see the deltas.
     * All usage mutations run through `usageChain` so a POST can never
     * interleave with a flush. Tradeoff: quota/credit reads lag up to ~30s.
     */
    private usageChain: Promise<void> = Promise.resolve();
    private usageAlarmScheduled = false;

    /** Serialize usage mutations so a POST can never interleave with a flush. */
    private mutateUsage(fn: () => Promise<void>): Promise<void> {
        const run = this.usageChain.then(fn);
        this.usageChain = run.catch(() => {});
        return run;
    }

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
        this.pruneLatency();
        this.pruneQuality();
        return this.ctx.storage.put("state", this.state);
    }

    /**
     * Keep the latency map bounded: drop entries not seen in 24h, then cap
     * at MAX_LATENCY_ENTRIES by recency. Runs on every persisted save.
     */
    private pruneLatency(): void {
        this.pruneTimestampedMap(this.state.latency, MAX_LATENCY_ENTRIES);
        this.pruneTimestampedMap(this.state.latencyPairs, MAX_LATENCY_ENTRIES);
    }

    /** Same bound for the quality map. */
    private pruneQuality(): void {
        this.pruneTimestampedMap(this.state.quality, MAX_QUALITY_ENTRIES);
    }

    private pruneTimestampedMap(
        map: Record<string, { updatedAt: number }>,
        cap: number
    ): void {
        const now = Date.now();
        for (const id of Object.keys(map)) {
            if (now - (map[id]?.updatedAt ?? 0) > LATENCY_STALE_MS) delete map[id];
        }
        const ids = Object.keys(map);
        if (ids.length > cap) {
            ids.sort((a, b) => (map[a]?.updatedAt ?? 0) - (map[b]?.updatedAt ?? 0));
            for (const id of ids.slice(0, ids.length - cap)) delete map[id];
        }
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
     * Flush accumulated usage deltas to D1 in one batch. Reads the deltas
     * from DO storage and deletes the key before the D1 write, so deltas
     * arriving mid-flush accumulate fresh for the next alarm instead of
     * being lost or double-counted.
     */
    private async flushUsage(): Promise<void> {
        await this.mutateUsage(async () => {
            const stored = await this.ctx.storage.get<
                [string, { tokens: number; cost: number }][]
            >("usageDeltas");
            if (!stored || stored.length === 0) return;
            await this.ctx.storage.delete("usageDeltas");
            try {
                const stmts = stored.map(([keyId, d]) =>
                    this.env.DB.prepare(
                        `UPDATE api_keys
                         SET usage_tokens = usage_tokens + ?,
                             usage_cost = usage_cost + ?
                         WHERE id = ?`
                    ).bind(d.tokens, d.cost, keyId)
                );
                await this.env.DB.batch(stmts);
            } catch (err) {
                // Re-queue on failure so usage isn't silently dropped; the
                // next alarm will retry.
                await this.ctx.storage.put("usageDeltas", stored);
                console.error("usage flush failed, re-queued", err);
            }
        });
    }

    async alarm(): Promise<void> {
        await this.flushUsage();
        // Keep the alarm recurring while there's work; a fresh POST /usage
        // re-arms it. This avoids an eternal alarm on an idle DO.
        this.usageAlarmScheduled = false;
        const pending = await this.ctx.storage.get("usageDeltas");
        if (pending) {
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
        ok: boolean | undefined,
        error?: string,
        retryAfterMs?: number,
        latencyMs?: number,
        model?: string,
        qualityBad?: boolean
    ): Promise<void> {
        const h = this.healthOf(accountId);
        const now = Date.now();
        if (ok === true) {
            h.state = "healthy";
            h.consecutiveFailures = 0;
            h.lastSuccessTime = now;
            h.cooldownUntil = undefined;
            h.lastErrorMessage = undefined;
            // Latency EMA: successes only — a failed attempt's timing says
            // nothing about the account's healthy speed and must not poison
            // the average used for ordering.
            if (typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0) {
                const prev = this.state.latency[accountId];
                this.state.latency[accountId] = {
                    ema:
                        prev === undefined
                            ? latencyMs
                            : prev.ema + LATENCY_EMA_ALPHA * (latencyMs - prev.ema),
                    samples: (prev?.samples ?? 0) + 1,
                    updatedAt: now
                };
                // Per-(account, model) EMA alongside the account-level one.
                if (typeof model === "string" && model) {
                    const key = latencyPairKey(accountId, model);
                    const pprev = this.state.latencyPairs[key];
                    this.state.latencyPairs[key] = {
                        ema:
                            pprev === undefined
                                ? latencyMs
                                : pprev.ema + LATENCY_EMA_ALPHA * (latencyMs - pprev.ema),
                        samples: (pprev?.samples ?? 0) + 1,
                        updatedAt: now
                    };
                }
            }
        } else if (ok === false) {
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
        // Response-quality tracking (decayed counters), independent of the
        // ok/fail branches above: a quality-only report carries ok=undefined.
        // Only completed streams report quality, so a "bad" here means the
        // upstream answered with no usable output.
        if (typeof qualityBad === "boolean") {
            const q = this.state.quality[accountId] ?? { bad: 0, total: 0, updatedAt: 0 };
            q.bad = q.bad * QUALITY_DECAY + (qualityBad ? 1 : 0);
            q.total = q.total * QUALITY_DECAY + 1;
            q.updatedAt = now;
            this.state.quality[accountId] = q;
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
                    ok?: boolean;
                    error?: string;
                    retryAfterMs?: number;
                    latencyMs?: number;
                    model?: string;
                    qualityBad?: boolean;
                };
                await this.report(
                    body.accountId,
                    body.ok,
                    body.error,
                    body.retryAfterMs,
                    body.latencyMs,
                    body.model,
                    body.qualityBad
                );
                return json({ ok: true });
            }
            if (request.method === "POST" && url.pathname === "/usage") {
                // Batched virtual-key usage accounting. The worker POSTs one
                // delta per completed request (fire-and-forget); deltas merge
                // into DO storage and flush to D1 on the ~30s alarm. This
                // replaces the old per-request `UPDATE api_keys`, which was a
                // serialized D1 write on the hot path.
                const body = (await request.json()) as {
                    keyId?: string;
                    tokens?: number;
                    cost?: number;
                };
                if (typeof body.keyId === "string" && body.keyId) {
                    await this.mutateUsage(async () => {
                        const stored =
                            (await this.ctx.storage.get<
                                [string, { tokens: number; cost: number }][]
                            >("usageDeltas")) ?? [];
                        const map = new Map(stored);
                        const cur = map.get(body.keyId as string) ?? { tokens: 0, cost: 0 };
                        cur.tokens += typeof body.tokens === "number" ? body.tokens : 0;
                        cur.cost += typeof body.cost === "number" ? body.cost : 0;
                        map.set(body.keyId as string, cur);
                        await this.ctx.storage.put("usageDeltas", [...map.entries()]);
                        this.scheduleUsageFlush();
                    });
                }
                return json({ ok: true });
            }
            if (request.method === "GET" && url.pathname === "/health") {
                const states: Record<string, CircuitEntry> = {};
                for (const id of Object.keys(this.state.circuit)) {
                    states[id] = this.healthOf(id);
                }
                const latency: Record<string, { emaMs: number; samples: number }> = {};
                for (const [id, l] of Object.entries(this.state.latency)) {
                    latency[id] = { emaMs: Math.round(l.ema), samples: l.samples };
                }
                const latencyPairs: Record<string, { emaMs: number; samples: number }> = {};
                for (const [key, l] of Object.entries(this.state.latencyPairs)) {
                    latencyPairs[key] = { emaMs: Math.round(l.ema), samples: l.samples };
                }
                const quality: Record<string, { badRate: number; samples: number }> = {};
                for (const [id, q] of Object.entries(this.state.quality)) {
                    quality[id] = {
                        badRate: q.total > 0 ? Math.round((q.bad / q.total) * 100) / 100 : 0,
                        samples: Math.round(q.total)
                    };
                }
                return json({ states, roundRobin: this.state.roundRobin, latency, latencyPairs, quality });
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
                if (body.accountId) {
                    delete this.state.circuit[body.accountId];
                    delete this.state.latency[body.accountId];
                    delete this.state.quality[body.accountId];
                    const prefix = `${body.accountId}\n`;
                    for (const key of Object.keys(this.state.latencyPairs)) {
                        if (key.startsWith(prefix)) delete this.state.latencyPairs[key];
                    }
                } else {
                    this.state.circuit = {};
                    this.state.latency = {};
                    this.state.latencyPairs = {};
                    this.state.quality = {};
                }
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
