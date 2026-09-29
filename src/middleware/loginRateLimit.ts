// Shared brute-force protection for the admin login endpoints.
//
// Both /v1/admin/login and the legacy /api/admin/login use this: 5 failed
// attempts from one IP -> 15 minute block. Per-isolate in-memory map (like
// the original SRouter's per-process map), so it's approximate under high
// concurrency — same tradeoff as upstream.

import type { Context } from "hono";

interface AttemptEntry {
    count: number;
    blockedUntil: number;
}

const attempts = new Map<string, AttemptEntry>();
const MAX_FAILURES = 5;
const BLOCK_MS = 15 * 60 * 1000;

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
export function isLoginBlocked(c: Context): boolean {
    const entry = attempts.get(loginClientIp(c));
    return !!entry && entry.blockedUntil > Date.now();
}

/** Record a failed login; blocks the IP once the threshold is reached. */
export function recordLoginFailure(c: Context): void {
    const ip = loginClientIp(c);
    const now = Date.now();
    let entry = attempts.get(ip);
    // Reset only when a previous block has actually expired (blockedUntil > 0).
    // A never-blocked entry has blockedUntil = 0, which must NOT reset the
    // counter — otherwise the count could never reach MAX_FAILURES.
    if (!entry || (entry.blockedUntil > 0 && entry.blockedUntil <= now)) {
        entry = { count: 0, blockedUntil: 0 };
    }
    entry.count += 1;
    if (entry.count >= MAX_FAILURES) entry.blockedUntil = now + BLOCK_MS;
    attempts.set(ip, entry);
}

/** Clear the failure counter after a successful login. */
export function clearLoginFailures(c: Context): void {
    attempts.delete(loginClientIp(c));
}

/** Test hook: reset all tracked attempts. */
export function resetLoginAttemptsForTests(): void {
    attempts.clear();
}
