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
function isRateLimitError(message) {
    return RATE_LIMIT_PATTERNS.some((p) => p.test(message));
}
const emptyState = () => ({
    roundRobin: {},
    circuit: {},
    modelCache: null,
    refreshLocks: {}
});
export class RouterState {
    ctx;
    state = emptyState();
    loaded = false;
    constructor(ctx, _env) {
        this.ctx = ctx;
    }
    async load() {
        if (this.loaded)
            return;
        await this.ctx.blockConcurrencyWhile(async () => {
            const stored = await this.ctx.storage.get("state");
            if (stored)
                this.state = { ...emptyState(), ...stored };
            this.loaded = true;
        });
    }
    save() {
        return this.ctx.storage.put("state", this.state);
    }
    healthOf(id) {
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
    async route(accounts) {
        const now = Date.now();
        const healthy = [];
        const cooling = [];
        for (const ref of accounts) {
            const h = this.healthOf(ref.id);
            if (h.state === "healthy")
                healthy.push(ref);
            else
                cooling.push({ ref, remaining: Math.max(0, (h.cooldownUntil ?? now) - now) });
        }
        let ordered;
        if (healthy.length > 0) {
            ordered = healthy;
        }
        else {
            cooling.sort((a, b) => a.remaining - b.remaining);
            ordered = cooling.map((c) => c.ref);
        }
        // Round-robin rotation within the first account's provider base,
        // mirroring SRouter's ProviderRegistry rotation among healthy accounts.
        if (ordered.length > 1) {
            const base = ordered[0].base;
            const idx = this.state.roundRobin[base] ?? 0;
            this.state.roundRobin[base] = (idx + 1) % ordered.length;
            ordered = [...ordered.slice(idx), ...ordered.slice(0, idx)];
            await this.save();
        }
        return ordered.map((r) => r.id);
    }
    async report(accountId, ok, error, retryAfterMs) {
        const h = this.healthOf(accountId);
        const now = Date.now();
        if (ok) {
            h.state = "healthy";
            h.consecutiveFailures = 0;
            h.lastSuccessTime = now;
            h.cooldownUntil = undefined;
            h.lastErrorMessage = undefined;
        }
        else {
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
    async fetch(request) {
        await this.load();
        const url = new URL(request.url);
        const json = (v, status = 200) => Response.json(v, { status });
        try {
            if (request.method === "POST" && url.pathname === "/route") {
                const body = (await request.json());
                return json({ orderedIds: await this.route(body.accounts ?? []) });
            }
            if (request.method === "POST" && url.pathname === "/report") {
                const body = (await request.json());
                await this.report(body.accountId, body.ok, body.error, body.retryAfterMs);
                return json({ ok: true });
            }
            if (request.method === "GET" && url.pathname === "/health") {
                const states = {};
                for (const id of Object.keys(this.state.circuit)) {
                    states[id] = this.healthOf(id);
                }
                return json({ states, roundRobin: this.state.roundRobin });
            }
            if (request.method === "POST" && url.pathname === "/models") {
                const body = (await request.json());
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
                const body = (await request.json());
                const now = Date.now();
                const heldUntil = this.state.refreshLocks[body.accountId] ?? 0;
                if (heldUntil > now)
                    return json({ acquired: false });
                this.state.refreshLocks[body.accountId] = now + (body.ttlMs || 60_000);
                await this.save();
                return json({ acquired: true });
            }
            if (request.method === "POST" && url.pathname === "/reset") {
                const body = (await request.json().catch(() => ({})));
                if (body.accountId)
                    delete this.state.circuit[body.accountId];
                else
                    this.state.circuit = {};
                await this.save();
                return json({ ok: true });
            }
            return json({ error: "not found" }, 404);
        }
        catch (err) {
            return json({ error: err instanceof Error ? err.message : "internal error" }, 500);
        }
    }
}
