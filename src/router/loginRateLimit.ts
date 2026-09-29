// LoginRateLimit Durable Object — global brute-force protection for admin logins.
//
// The old limiter was per-isolate in-memory, so an attacker rotating across
// Cloudflare isolates never accumulated enough failures on one isolate to be
// blocked. This DO holds the attempt counters globally: one well-known
// instance ("login") per deployment, shared by both login endpoints.
//
// RPC is plain fetch+JSON against the DO stub:
//
//   POST /check   { ip } -> { blocked, blockedUntil, retryAfterMs }
//   POST /attempt { ip } -> { blocked, blockedUntil, retryAfterMs }
//   POST /clear   { ip } -> { ok: true }
//
// State is persisted in DO storage on every mutation, so DO eviction never
// silently clears blocks (same discipline as SwitchState's pending usage).
// Stale entries (no active block, untouched for an hour) are pruned on save.
//
// Login is not a hot path: one DO round-trip per login attempt is fine, and
// the worker keeps a short-lived isolate-local cache of *blocked* IPs so a
// blocked attacker costs zero DO round-trips (see middleware/loginRateLimit.ts).

import type { Env } from "../env.js";

/** Well-known DO instance name (via idFromName). */
export const LOGIN_DO_NAME = "login";

/** Failed attempts from one IP before it is blocked. */
export const LOGIN_MAX_FAILURES = 5;

/** How long a blocked IP stays blocked. */
export const LOGIN_BLOCK_MS = 15 * 60 * 1000;

/** Entries with no active block and no activity this old are pruned on save. */
const PRUNE_AFTER_MS = 60 * 60 * 1000;

interface LoginAttemptEntry {
    count: number;
    blockedUntil: number;
    updatedAt: number;
}

export class LoginRateLimit {
    private state: Record<string, LoginAttemptEntry> = {};

    constructor(
        private ctx: DurableObjectState,
        private env: Env
    ) {
        this.ctx.blockConcurrencyWhile(async () => {
            this.state =
                (await this.ctx.storage.get<Record<string, LoginAttemptEntry>>("state")) ?? {};
        });
    }

    /** Get the entry for an IP, resetting it if a previous block has expired. */
    private entry(ip: string, now: number): LoginAttemptEntry {
        let e = this.state[ip];
        // Reset only when a previous block actually expired (blockedUntil > 0).
        // A never-blocked entry has blockedUntil = 0, which must NOT reset the
        // counter — otherwise the count could never reach LOGIN_MAX_FAILURES.
        if (!e || (e.blockedUntil > 0 && e.blockedUntil <= now)) {
            e = { count: 0, blockedUntil: 0, updatedAt: now };
            this.state[ip] = e;
        }
        return e;
    }

    private async save(now: number): Promise<void> {
        for (const [ip, e] of Object.entries(this.state)) {
            if (e.blockedUntil <= now && e.updatedAt < now - PRUNE_AFTER_MS) {
                delete this.state[ip];
            }
        }
        await this.ctx.storage.put("state", this.state);
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const body = (await request.json().catch(() => null)) as { ip?: unknown } | null;
        const ip = typeof body?.ip === "string" ? body.ip : "";
        if (!ip || ip.length > 64) {
            return Response.json({ error: "missing or invalid ip" }, { status: 400 });
        }
        const now = Date.now();

        if (request.method === "POST" && url.pathname === "/check") {
            const e = this.entry(ip, now);
            const blocked = e.blockedUntil > now;
            return Response.json({
                blocked,
                blockedUntil: e.blockedUntil,
                retryAfterMs: blocked ? e.blockedUntil - now : 0
            });
        }

        if (request.method === "POST" && url.pathname === "/attempt") {
            const e = this.entry(ip, now);
            e.count += 1;
            e.updatedAt = now;
            if (e.count >= LOGIN_MAX_FAILURES && e.blockedUntil <= now) {
                e.blockedUntil = now + LOGIN_BLOCK_MS;
            }
            await this.save(now);
            const blocked = e.blockedUntil > now;
            return Response.json({
                blocked,
                blockedUntil: e.blockedUntil,
                retryAfterMs: blocked ? e.blockedUntil - now : 0
            });
        }

        if (request.method === "POST" && url.pathname === "/clear") {
            delete this.state[ip];
            await this.save(now);
            return Response.json({ ok: true });
        }

        return Response.json({ error: "not found" }, { status: 404 });
    }
}
