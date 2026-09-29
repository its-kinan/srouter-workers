// Shared brute-force protection for the admin login endpoints.
//
// Both /v1/admin/login and the legacy /api/admin/login use this: 5 failed
// attempts from one IP -> 15 minute block.
//
// The attempt counters live in the LoginRateLimit Durable Object (one
// well-known instance, idFromName("login")), so the block is global across
// isolates — an attacker rotating across Cloudflare isolates still accumulates
// failures. The DO is the source of truth.
//
// In front of the DO sits a short-lived isolate-local cache of *blocked* IPs
// (60s TTL): a blocked attacker is rejected with zero DO round-trips.
// Login is not a hot path, so one DO round-trip per login attempt is fine,
// and no other request path touches the DO.
//
// If the DO binding is missing or the DO call fails, this falls back to the
// old per-isolate in-memory counting (same behavior as before the DO
// existed), rather than failing open or locking out the admin.

import type { Context } from "hono";
import type { Env } from "../env.js";
import { LOGIN_DO_NAME } from "../router/loginRateLimit.js";
import { LOGIN_MAX_FAILURES, LOGIN_BLOCK_MS } from "../router/loginRateLimit.js";

/** How long a locally-cached blocked IP skips the DO round-trip. */
const LOCAL_CACHE_TTL_MS = 60_000;

/** Isolate-local cache: ip -> blockedUntil (capped at now + LOCAL_CACHE_TTL_MS). */
const localBlocked = new Map<string, number>();

// --- Local fallback: per-isolate counting when the DO is unavailable --------

interface FallbackEntry {
    count: number;
    blockedUntil: number;
}

const fallbackAttempts = new Map<string, FallbackEntry>();

function fallbackBlocked(ip: string): boolean {
    const entry = fallbackAttempts.get(ip);
    return !!entry && entry.blockedUntil > Date.now();
}

function fallbackRecordFailure(ip: string): void {
    const now = Date.now();
    let entry = fallbackAttempts.get(ip);
    // Reset only when a previous block has actually expired (blockedUntil > 0).
    // A never-blocked entry has blockedUntil = 0, which must NOT reset the
    // counter — otherwise the count could never reach LOGIN_MAX_FAILURES.
    if (!entry || (entry.blockedUntil > 0 && entry.blockedUntil <= now)) {
        entry = { count: 0, blockedUntil: 0 };
    }
    entry.count += 1;
    if (entry.count >= LOGIN_MAX_FAILURES) entry.blockedUntil = now + LOGIN_BLOCK_MS;
    fallbackAttempts.set(ip, entry);
}

function fallbackClear(ip: string): void {
    fallbackAttempts.delete(ip);
}

// --- DO RPC -----------------------------------------------------------------

interface BlockState {
    blocked: boolean;
    blockedUntil: number;
}

/** Call the LoginRateLimit DO; returns null when the binding is missing or the call fails. */
async function doRpc(
    c: Context,
    path: "/check" | "/attempt" | "/clear",
    ip: string
): Promise<BlockState | null> {
    try {
        const ns = (c.env as unknown as Env).LOGIN_LIMIT;
        if (!ns) return null;
        const stub = ns.get(ns.idFromName(LOGIN_DO_NAME));
        const res = await stub.fetch(
            new Request(`https://login-limit.local${path}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ip })
            })
        );
        if (!res.ok) return null;
        const data = (await res.json().catch(() => null)) as {
            blocked?: unknown;
            blockedUntil?: unknown;
        } | null;
        if (!data) return null;
        return {
            blocked: data.blocked === true,
            blockedUntil: typeof data.blockedUntil === "number" ? data.blockedUntil : 0
        };
    } catch {
        return null;
    }
}

function cacheBlocked(ip: string, blockedUntil: number): void {
    localBlocked.set(ip, Math.min(blockedUntil, Date.now() + LOCAL_CACHE_TTL_MS));
}

// --- Public API ---------------------------------------------------------------

export function loginClientIp(c: Context): string {
    return (
        c.req.header("CF-Connecting-IP") ??
        c.req.header("cf-connecting-ip") ??
        c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
        "unknown"
    );
}

/** True when this IP is currently blocked from attempting login. */
export async function isLoginBlocked(c: Context): Promise<boolean> {
    const ip = loginClientIp(c);
    const now = Date.now();
    const cached = localBlocked.get(ip);
    if (cached !== undefined) {
        if (cached > now) return true;
        localBlocked.delete(ip);
    }
    const state = await doRpc(c, "/check", ip);
    if (!state) return fallbackBlocked(ip);
    if (state.blocked) cacheBlocked(ip, state.blockedUntil);
    return state.blocked;
}

/** Record a failed login; blocks the IP once the threshold is reached. */
export async function recordLoginFailure(c: Context): Promise<void> {
    const ip = loginClientIp(c);
    const state = await doRpc(c, "/attempt", ip);
    if (!state) {
        fallbackRecordFailure(ip);
        return;
    }
    if (state.blocked) cacheBlocked(ip, state.blockedUntil);
}

/** Clear the failure counter after a successful login. */
export async function clearLoginFailures(c: Context): Promise<void> {
    const ip = loginClientIp(c);
    localBlocked.delete(ip);
    fallbackClear(ip);
    await doRpc(c, "/clear", ip);
}

/** Test hook: reset all locally tracked state (the DO keeps its own). */
export function resetLoginAttemptsForTests(): void {
    localBlocked.clear();
    fallbackAttempts.clear();
}
