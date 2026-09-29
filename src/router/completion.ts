// Shared chat-completion execution engine.
//
// Extracted verbatim from src/routes/chat.ts so that both
// POST /v1/chat/completions (OpenAI protocol) and POST /v1/messages
// (Anthropic protocol, translated to OpenAI before calling in) share the
// exact same routing, failover, streaming, logging, and usage-accounting
// behavior.
//
// Flow:
//   1. loadAccounts (decrypt provider credentials with MASTER_KEY)
//   2. resolveModel (prefix match, else DO-cached aggregated catalog)
//   3. orderedCandidates (SwitchState DO: round-robin + circuit breaker)
//   4. Try candidates in order; FAILOVER ONLY BEFORE THE FIRST CHUNK — once
//      bytes flow to the caller we are committed to that provider
//   5. Report success/failure back to the DO; log the request via waitUntil;
//      atomically bump the virtual key's token/cost usage.
//
// Errors are returned as structured data (not Response objects) so each
// protocol handler can render them in its own error format.

import type { Env } from "../env.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiKeyRow } from "../middleware/apiKeyAuth.js";
import { ensureFreshToken } from "../providers/oauth-refresh.js";
import { encryptSecretsObject } from "../crypto/secretbox.js";
import {
    accountMatchesPin,
    buildAdapter,
    candidateAccountsForPrefix,
    loadAccounts,
    parseAccountPin,
    providerAlias,
    providerTypeForPrefix,
    stripRoutingPrefix
} from "../providers/registry.js";
import { switchShardName, latencyPairKey } from "./durable.js";
import { getModelCatalog } from "./catalog.js";
import type { DecryptedAccount } from "../providers/types.js";
import type {
    ChatCompletionChunk,
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessage,
    ModelObject,
    ToolCall
} from "../vendor/types/index.js";
import { accumulateChunks } from "../vendor/translator/index.js";
import { calculateCostFromTokens, getPricingForModel } from "../vendor/pricing.js";
import { estimateTokens } from "./tokens.js";
import {
    runCandidateAttempts,
    resolveCandidates,
    type AttemptTracker
} from "../routing/fallback.js";
import {
    buildFollowUpSearchMessages,
    hasInterceptableSearchCall,
    MAX_INTERCEPT_DEPTH
} from "../services/toolInterceptor.js";
import type { WebSearchOptions } from "../vendor/executors/search.js";

export interface CompletionInput {
    /** OpenAI-format request. `stream` selects the outcome shape; upstream always streams. */
    body: ChatCompletionRequest;
    apiKeyRow?: ApiKeyRow;
    startedAt: number;
    ip: string | null;
    userAgent: string | null;
    /** Recursion depth for server-side tool interception (web search follow-ups). */
    depth?: number;
}

/** Build web-search options from Worker secrets. */
function searchOptionsFromEnv(env: Env): WebSearchOptions {
    return {
        braveApiKey: env.BRAVE_API_KEY,
        tavilyApiKey: env.TAVILY_API_KEY,
        serperApiKey: env.SERPER_API_KEY,
        searxngUrl: env.SEARXNG_URL
    };
}

export type CompletionOutcome =
    | {
          kind: "error";
          status: ContentfulStatusCode;
          message: string;
          /** OpenAI-style error type, e.g. "server_error" / "invalid_request_error". */
          errorType: string;
          code: string;
      }
    | { kind: "json"; response: ChatCompletionResponse }
    | {
          kind: "stream";
          chunks: AsyncGenerator<ChatCompletionChunk, void, void>;
          providerType: string;
          accountId: string;
      };

export type RequestLogMode = "none" | "all" | "errors";

/**
 * Decide the request_logs write mode from env:
 * - SROUTER_DISABLE_REQUEST_LOGS=1 → "none" (no writes at all).
 * - SROUTER_LOG_ALL_REQUESTS=1 → "all" (log every completed request).
 * - Default → "errors" (log only terminal 4xx/5xx failures, skip successes).
 * The table holds metadata only — never prompt/response content.
 */
export function resolveRequestLogMode(env: Env): RequestLogMode {
    if (env.SROUTER_DISABLE_REQUEST_LOGS === "1") return "none";
    if (env.SROUTER_LOG_ALL_REQUESTS === "1") return "all";
    return "errors";
}

/** Default cap on upstream attempts per model candidate in the failover loop. */
export const DEFAULT_MAX_ATTEMPTS = 10;

/**
 * Max upstream attempts per model candidate, from SROUTER_MAX_ATTEMPTS.
 * Missing, non-numeric, or <= 0 values fall back to DEFAULT_MAX_ATTEMPTS.
 * Exported for unit tests.
 */
export function resolveMaxAttempts(env: Env): number {
    const raw = env.SROUTER_MAX_ATTEMPTS;
    const parsed = raw === undefined || raw === null ? NaN : parseInt(String(raw), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ATTEMPTS;
}

/** Default delay before firing a hedged second attempt (ms). */
export const DEFAULT_HEDGE_DELAY_MS = 2000;

/**
 * Delay before hedging a slow first byte, from SROUTER_HEDGE_DELAY_MS.
 * Missing/non-numeric values fall back to DEFAULT_HEDGE_DELAY_MS;
 * <= 0 disables hedging. Exported for unit tests.
 */
export function resolveHedgeDelayMs(env: Env): number {
    const raw = env.SROUTER_HEDGE_DELAY_MS;
    if (raw === undefined || raw === null || raw === "") return DEFAULT_HEDGE_DELAY_MS;
    const parsed = parseInt(String(raw), 10);
    if (!Number.isFinite(parsed)) return DEFAULT_HEDGE_DELAY_MS;
    return Math.max(0, parsed);
}

function routerShard(env: Env, providerType: string): DurableObjectStub {
    return env.SWITCH_STATE.getByName(switchShardName(providerType));
}

// --- Isolate-local routing state ---
// /route and /report used to be awaited inline on the request path, funneling
// every request through the single SwitchState DO instance. Under load that
// DO became the choke point (each call = JSON round-trip + full-state
// storage.put). Now:
//   - candidate ordering is computed locally: isolate-local round-robin per
//     provider plus a short cooldown for just-failed accounts;
//   - circuit reports are fire-and-forget via waitUntil to the provider's DO
//     shard, which stays the source of truth for the admin health view.
// Failover semantics are unchanged: the attempt loop still tries the next
// account as soon as one fails, before any byte is sent to the client.

const localRoundRobin = new Map<string, number>();
const localCooldownUntil = new Map<string, number>();
const LOCAL_COOLDOWN_MS = 30_000;

// --- Isolate-local upstream latency tracking ---
// reportLater() records each attempt's time-to-first-chunk as an exponential
// moving average (successes only — failures must not poison it; they are
// tracked separately via the cooldown above and the DO circuit breaker).
// Tracked per (account, model) pair, with a per-account fallback: an account
// can be fast for one model and slow for another.
// orderCandidatesLocally() then tries faster accounts first.
//
// Least-connections blending: pure fastest-first would concentrate
// first-attempt load on the quickest account. Candidates whose effective
// latency is within ~25% of the fastest measured EMA form the "fast band"
// and are ordered by fewest in-flight requests first — a slightly slower
// idle account beats a saturated fast one. Outside the band, raw speed
// still wins. Accounts with no samples yet sort before measured ones
// (discovery): a new account is tried promptly, measured once, then
// settles into its rank.
const LATENCY_EMA_ALPHA = 0.2;
const MAX_LATENCY_ENTRIES = 2000;
/** Latency band: within this factor of the fastest EMA, in-flight count wins. */
const FAST_BAND_FACTOR = 1.25;
const localLatencyEmaPair = new Map<string, number>();
const localLatencyEmaAccount = new Map<string, number>();

function setCapped(map: Map<string, number>, key: string, value: number): void {
    // Delete + re-set so the entry refreshes its insertion-order recency.
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_LATENCY_ENTRIES) {
        const oldest = map.keys().next();
        if (!oldest.done) map.delete(oldest.value);
    }
}

/** Exported for unit tests. */
export function recordLatencySample(
    accountId: string,
    model: string | undefined,
    latencyMs: number
): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
    if (model !== undefined) {
        const key = latencyPairKey(accountId, model);
        const prev = localLatencyEmaPair.get(key);
        setCapped(
            localLatencyEmaPair,
            key,
            prev === undefined ? latencyMs : prev + LATENCY_EMA_ALPHA * (latencyMs - prev)
        );
    }
    const prevAcc = localLatencyEmaAccount.get(accountId);
    setCapped(
        localLatencyEmaAccount,
        accountId,
        prevAcc === undefined ? latencyMs : prevAcc + LATENCY_EMA_ALPHA * (latencyMs - prevAcc)
    );
}

// --- Isolate-local response-quality tracking ---
// Beyond HTTP errors: some upstreams answer 200 with no usable output
// (zero completion tokens, no text, no tool calls). Track a decayed
// bad/total rate per account; ordering multiplies the account's latency EMA
// by (1 + 3 * badRate) once enough samples exist — deprioritized, never
// hard-excluded (the circuit breaker still owns hard failures).
const QUALITY_DECAY = 0.9;
const MIN_QUALITY_SAMPLES = 3;
const QUALITY_PENALTY_FACTOR = 3;
const MAX_QUALITY_ENTRIES = 2000;
const localQuality = new Map<string, { bad: number; total: number }>();

/** Exported for unit tests. */
export function recordQualitySample(accountId: string, bad: boolean): void {
    const q = localQuality.get(accountId) ?? { bad: 0, total: 0 };
    q.bad = q.bad * QUALITY_DECAY + (bad ? 1 : 0);
    q.total = q.total * QUALITY_DECAY + 1;
    // Delete + re-set so the entry refreshes its insertion-order recency.
    localQuality.delete(accountId);
    localQuality.set(accountId, q);
    if (localQuality.size > MAX_QUALITY_ENTRIES) {
        const oldest = localQuality.keys().next();
        if (!oldest.done) localQuality.delete(oldest.value);
    }
}

function qualityPenalty(accountId: string): number {
    const q = localQuality.get(accountId);
    if (!q || q.total < MIN_QUALITY_SAMPLES) return 1;
    return 1 + QUALITY_PENALTY_FACTOR * (q.bad / q.total);
}

// --- Isolate-local in-flight request tracking ---
// Incremented when an upstream attempt starts, decremented when it ends
// (failover, abandonment, or stream completion). Feeds the least-connections
// blending in orderCandidatesLocally(): the count reflects streams the
// client is still reading, which is exactly the load we want to spread.
const inflightByAccount = new Map<string, number>();

/** Exported for unit tests. */
export function trackAttemptStart(accountId: string): void {
    inflightByAccount.set(accountId, (inflightByAccount.get(accountId) ?? 0) + 1);
}

/** Exported for unit tests. */
export function trackAttemptEnd(accountId: string): void {
    const n = (inflightByAccount.get(accountId) ?? 1) - 1;
    if (n <= 0) inflightByAccount.delete(accountId);
    else inflightByAccount.set(accountId, n);
}

function inflightOf(accountId: string): number {
    return inflightByAccount.get(accountId) ?? 0;
}

/** Effective latency for ordering: pair EMA → account EMA → undefined. */
function effectiveLatency(a: DecryptedAccount, model: string | undefined): number | undefined {
    const pair =
        model !== undefined ? localLatencyEmaPair.get(latencyPairKey(a.id, model)) : undefined;
    const base = pair ?? localLatencyEmaAccount.get(a.id);
    if (base === undefined) return undefined;
    return base * qualityPenalty(a.id);
}

/**
 * Order candidates without touching the DO: skip cooling accounts, then
 * prefer lower effective latency (pair EMA, else account EMA, quality
 * penalized; unknown first for discovery). Within ~25% of the fastest
 * measured latency, fewest in-flight requests wins. Falls back to the
 * previous round-robin rotation when no account in the pool has latency
 * data yet (cold isolate) — identical behavior to before.
 */
export function orderCandidatesLocally(
    candidates: DecryptedAccount[],
    model?: string
): DecryptedAccount[] {
    const now = Date.now();
    const healthy: DecryptedAccount[] = [];
    for (const a of candidates) {
        const until = localCooldownUntil.get(a.id);
        if (until !== undefined) {
            if (until <= now) localCooldownUntil.delete(a.id);
            else continue;
        }
        healthy.push(a);
    }
    // If everything is cooling, try them anyway (best effort beats 503).
    const pool = healthy.length > 0 ? healthy : candidates;
    if (pool.length <= 1) return pool;
    const anyLatency = pool.some((a) => effectiveLatency(a, model) !== undefined);
    if (!anyLatency) {
        const base = pool[0]!.providerType;
        const idx = (localRoundRobin.get(base) ?? 0) % pool.length;
        localRoundRobin.set(base, idx + 1);
        return [...pool.slice(idx), ...pool.slice(0, idx)];
    }
    let minEff = Infinity;
    for (const a of pool) {
        const e = effectiveLatency(a, model);
        if (e !== undefined && e < minEff) minEff = e;
    }
    // Stable sort: unknown EMA first (discovery); then the fast band
    // (within 25% of fastest) by in-flight count, then effective latency.
    // Cooldown filtering above still applies — a fast but broken account is
    // skipped before it ever reaches this sort.
    return [...pool].sort((a, b) => {
        const ea = effectiveLatency(a, model);
        const eb = effectiveLatency(b, model);
        if (ea === undefined && eb === undefined) return 0;
        if (ea === undefined) return -1;
        if (eb === undefined) return 1;
        const aBand = ea <= minEff * FAST_BAND_FACTOR;
        const bBand = eb <= minEff * FAST_BAND_FACTOR;
        if (aBand && bBand) {
            const ia = inflightOf(a.id);
            const ib = inflightOf(b.id);
            if (ia !== ib) return ia - ib;
        }
        return ea - eb;
    });
}

/** Drop isolate-local routing state (tests only). */
export function resetLocalRoutingStateForTests(): void {
    localRoundRobin.clear();
    localCooldownUntil.clear();
    localLatencyEmaPair.clear();
    localLatencyEmaAccount.clear();
    localQuality.clear();
    inflightByAccount.clear();
}

/**
 * Fire-and-forget circuit report to the provider's DO shard. Never blocks.
 * latencyMs (time to first chunk for this attempt) updates the isolate-local
 * pair/account EMAs on success and is forwarded to the DO shard for the
 * admin health view; failures never touch the EMA.
 * Exported for unit tests (test/latency-routing.test.ts).
 */
export function reportLater(
    ctx: { waitUntil(p: Promise<unknown>): void },
    env: Env,
    account: DecryptedAccount,
    ok: boolean,
    error?: string,
    latencyMs?: number,
    model?: string
): void {
    if (ok) {
        localCooldownUntil.delete(account.id);
        if (latencyMs !== undefined) recordLatencySample(account.id, model, latencyMs);
    } else {
        localCooldownUntil.set(account.id, Date.now() + LOCAL_COOLDOWN_MS);
    }
    ctx.waitUntil(
        (async () => {
            try {
                await routerShard(env, account.providerType).fetch(
                    new Request("https://do/report", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ accountId: account.id, ok, error, latencyMs, model })
                    })
                );
            } catch {
                // Router-state reporting must never fail the request itself.
            }
        })()
    );
}

/**
 * A naturally completed stream that carried zero completion tokens, no
 * text, and no tool calls produced no usable output — the account answered
 * but answered empty. Tool-call-only responses are NOT bad (the tools ARE
 * the output). Exported for unit tests.
 */
export function isBadQualityResponse(tally: {
    completionTokens: number;
    completionParts: string[];
    hadToolCalls: boolean;
}): boolean {
    return (
        tally.completionTokens === 0 &&
        tally.completionParts.join("").trim() === "" &&
        !tally.hadToolCalls
    );
}

/**
 * Fire-and-forget response-quality report to the provider's DO shard.
 * Called once per committed (fully streamed) attempt: `bad` is true when
 * the upstream answered 200 with no usable output (zero completion tokens,
 * no text, no tool calls). Updates the isolate-local decayed counters
 * immediately and persists them in the DO for the admin view.
 * Exported for unit tests.
 */
export function reportQualityLater(
    ctx: { waitUntil(p: Promise<unknown>): void },
    env: Env,
    account: DecryptedAccount,
    model: string | undefined,
    bad: boolean
): void {
    recordQualitySample(account.id, bad);
    ctx.waitUntil(
        (async () => {
            try {
                await routerShard(env, account.providerType).fetch(
                    new Request("https://do/report", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ accountId: account.id, qualityBad: bad, model })
                    })
                );
            } catch {
                // Quality reporting must never fail the request itself.
            }
        })()
    );
}

/**
 * Load only the provider types this request (including its fallback targets)
 * can touch. Prefixed models ("th/foo") decrypt ~dozens of rows instead of
 * all ~342; bare models and unknown prefixes fall back to the full load.
 */
async function loadAccountsForModel(
    db: D1Database,
    masterKeyB64: string,
    model: string
): Promise<DecryptedAccount[]> {
    const candidates = await resolveCandidates(db, model);
    const types = new Set<string>();
    for (const c of candidates) {
        const { model: clean } = parseAccountPin(c.model);
        const slash = clean.indexOf("/");
        if (slash <= 0) return loadAccounts(db, masterKeyB64);
        const pt = providerTypeForPrefix(clean.slice(0, slash));
        if (!pt) return loadAccounts(db, masterKeyB64);
        types.add(pt);
    }
    if (types.size === 0) return loadAccounts(db, masterKeyB64);
    return loadAccounts(db, masterKeyB64, { providerTypes: [...types] });
}

interface ResolvedModel {
    candidates: DecryptedAccount[];
    /** Model id to send upstream for each candidate id. */
    upstreamByAccount: Map<string, string>;
}

async function resolveModel(
    model: string,
    accounts: DecryptedAccount[],
    catalog: ModelObject[] | null
): Promise<ResolvedModel | null> {
    // Account pinning: "provider/model#selector" restricts routing to the
    // pinned account(s) only. stripRoutingPrefix removes the pin, so the
    // "#selector" suffix never leaks upstream.
    const { model: cleanModel, pin } = parseAccountPin(model);
    const prefixed = candidateAccountsForPrefix(cleanModel, accounts, pin);
    if (prefixed.length > 0) {
        return {
            candidates: prefixed,
            upstreamByAccount: new Map(
                prefixed.map((a) => [a.id, stripRoutingPrefix(cleanModel, a)] as [string, string])
            )
        };
    }
    if (pin) {
        // The pin named no account. Distinguish "the prefix matched accounts
        // but the pin filtered them all out" (hard miss -> unknown model)
        // from "unknown prefix" (fall through to the catalog lookup below).
        const prefixMatched = candidateAccountsForPrefix(cleanModel, accounts);
        if (prefixMatched.length > 0) return null;
    }
    // Bare model id: look it up in the aggregated catalog (served
    // stale-while-revalidate; the request path never fans out to upstreams).
    // A null catalog means cold start with no data — unknown model.
    if (!catalog || catalog.length === 0) return null;
    const wanted = cleanModel.toLowerCase();
    const matched = new Set<string>();
    for (const m of catalog ?? []) {
        if (m.id.toLowerCase() === wanted) {
            matched.add(m.id);
            continue;
        }
        const bare = m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.id;
        if (bare.toLowerCase() === wanted) matched.add(m.id);
    }
    if (matched.size === 0) return null;
    const candidates: DecryptedAccount[] = [];
    const upstreamByAccount = new Map<string, string>();
    for (const a of accounts) {
        if (pin && !accountMatchesPin(a, pin)) continue;
        const alias = providerAlias(a.providerType, a.alias).toLowerCase();
        for (const id of matched) {
            if (id.toLowerCase().startsWith(alias + "/") && !upstreamByAccount.has(a.id)) {
                candidates.push(a);
                upstreamByAccount.set(a.id, id.slice(alias.length + 1));
            }
        }
    }
    return candidates.length > 0 ? { candidates, upstreamByAccount } : null;
}

interface UsageTally {
    promptTokens: number;
    completionTokens: number;
    /** Completion text chunks; joined once when estimating tokens (avoids O(n²) concat). */
    completionParts: string[];
    /** Set when any chunk carried tool-call deltas (quality assessment). */
    hadToolCalls: boolean;
}

function tallyChunk(tally: UsageTally, chunk: ChatCompletionChunk): void {
    if (chunk.usage) {
        if (chunk.usage.prompt_tokens) tally.promptTokens = chunk.usage.prompt_tokens;
        if (chunk.usage.completion_tokens) {
            tally.completionTokens = chunk.usage.completion_tokens;
        }
    }
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === "string") tally.completionParts.push(delta);
    const toolCalls = chunk.choices?.[0]?.delta?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) tally.hadToolCalls = true;
}

// --- Delayed hedging for time-to-first-byte ---
//
// When the fastest candidate is slow to produce its first byte, waiting it
// out serially is pure added latency. Instead: race the primary's first
// byte against a timer (SROUTER_HEDGE_DELAY_MS, default 2000ms); if the
// timer wins, fire a second attempt at the next-fastest candidate and take
// whichever yields first byte. The loser is abandoned via gen.return() —
// best-effort cancellation (async generators have no AbortSignal plumbing;
// threading one through every executor would be far more invasive). The
// common case aborts the loser before the upstream bills completion tokens,
// so double-billing is rare; document, don't fear.
// Hedged attempts count against SROUTER_MAX_ATTEMPTS: each fired hedge
// consumes one slot of the attempt budget. Pinned requests (single account)
// never hedge.

/** Exported for unit tests (test/routing-improvements.test.ts). */
export interface StartedAttempt {
    account: DecryptedAccount;
    gen: AsyncGenerator<ChatCompletionChunk, void, void>;
    attemptStart: number;
}

type FirstByteResult =
    | { ok: true; first: IteratorResult<ChatCompletionChunk> }
    | { ok: false; error: unknown };

async function firstByte(
    gen: AsyncGenerator<ChatCompletionChunk, void, void>
): Promise<FirstByteResult> {
    try {
        return { ok: true, first: await gen.next() };
    } catch (error) {
        return { ok: false, error };
    }
}

export interface HedgedFirstByteOutcome {
    kind: "won" | "failed";
    winner?: StartedAttempt;
    winnerFirst?: IteratorResult<ChatCompletionChunk>;
    failures: { account: DecryptedAccount; error: unknown }[];
    /** 1 normally, 2 when a hedge was fired (both count against the cap). */
    accountsConsumed: number;
}

function emptyStreamError(): Error {
    return new Error("empty response stream");
}

/**
 * Race a primary attempt's first byte, optionally hedging. Exported for
 * unit tests (test/routing-improvements.test.ts).
 *
 * @param primary    already-started primary attempt (in-flight counted).
 * @param startHedge lazily starts the hedge attempt, or null to disable.
 *                   Called at most once, only if the primary is still
 *                   pending after hedgeDelayMs. Returning null (startup
 *                   failure) falls back to awaiting the primary alone.
 * @param hedgeDelayMs <= 0 disables hedging.
 */
export async function hedgedFirstByte(
    primary: StartedAttempt,
    startHedge: (() => Promise<StartedAttempt | null>) | null,
    hedgeDelayMs: number
): Promise<HedgedFirstByteOutcome> {
    const fail = (
        failures: { account: DecryptedAccount; error: unknown }[],
        accountsConsumed: number
    ): HedgedFirstByteOutcome => ({ kind: "failed", failures, accountsConsumed });
    const win = (
        winner: StartedAttempt,
        winnerFirst: IteratorResult<ChatCompletionChunk>,
        accountsConsumed: number
    ): HedgedFirstByteOutcome => ({
        kind: "won",
        winner,
        winnerFirst,
        failures: [],
        accountsConsumed
    });
    const toFailure = (
        account: DecryptedAccount,
        r: FirstByteResult
    ): { account: DecryptedAccount; error: unknown } => ({
        account,
        error: r.ok ? emptyStreamError() : r.error
    });

    const primaryP = firstByte(primary.gen);
    const settlePrimaryAlone = async (): Promise<HedgedFirstByteOutcome> => {
        const r = await primaryP;
        if (!r.ok || r.first.done) return fail([toFailure(primary.account, r)], 1);
        return win(primary, r.first, 1);
    };
    if (!startHedge || hedgeDelayMs <= 0) return settlePrimaryAlone();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutP = new Promise<"timeout">((res) => {
        timer = setTimeout(() => res("timeout"), hedgeDelayMs);
    });
    const raced = await Promise.race([
        primaryP.then(() => "primary" as const),
        timeoutP
    ]);
    if (raced === "primary") {
        if (timer !== undefined) clearTimeout(timer);
        return settlePrimaryAlone();
    }
    // Hedge delay elapsed with no first byte: fire the hedge.
    const hedge = await startHedge().catch(() => null);
    if (!hedge) {
        if (timer !== undefined) clearTimeout(timer);
        return settlePrimaryAlone(); // hedge never started: 1 account consumed
    }
    const hedgeP = firstByte(hedge.gen);
    const w = await Promise.race([
        primaryP.then((r) => ({ r, side: "primary" as const })),
        hedgeP.then((r) => ({ r, side: "hedge" as const }))
    ]);
    if (timer !== undefined) clearTimeout(timer);
    const winner = w.side === "primary" ? primary : hedge;
    const loser = w.side === "primary" ? hedge : primary;
    const wr = w.r;
    if (wr.ok && !wr.first.done) {
        // Winner committed: abandon the loser. Its in-flight count ends
        // here; it is NOT reported as a failure (it was merely slow).
        try {
            await loser.gen.return(undefined);
        } catch {
            // Abandoned mid-flight; nothing to clean up.
        }
        trackAttemptEnd(loser.account.id);
        return win(winner, wr.first, 2);
    }
    // Race winner failed (error or empty): the other side may still succeed.
    const otherP = w.side === "primary" ? hedgeP : primaryP;
    const other = w.side === "primary" ? hedge : primary;
    const ro = await otherP;
    if (ro.ok && !ro.first.done) {
        try {
            await winner.gen.return(undefined);
        } catch {
            // Already failed/empty; nothing to clean up.
        }
        trackAttemptEnd(winner.account.id);
        return win(other, ro.first, 2);
    }
    // Both sides failed: failover bookkeeping for both.
    trackAttemptEnd(winner.account.id);
    trackAttemptEnd(other.account.id);
    return fail([toFailure(winner.account, w.r), toFailure(other.account, ro)], 2);
}

export async function executeCompletion(
    env: Env,
    executionCtx: { waitUntil(promise: Promise<unknown>): void },
    input: CompletionInput
): Promise<CompletionOutcome> {
    const { body, apiKeyRow, startedAt, ip, userAgent } = input;

    // Decrypt only the providers this request (and its fallback targets)
    // can touch — the isolate cache makes repeat requests ~free.
    // The account load (D1 + decrypt) and the catalog fetch (DO) are
    // independent — run them concurrently so a cold isolate pays max(), not
    // sum(), of the two. resolveModel below needs both.
    const [accounts, catalog] = await Promise.all([
        loadAccountsForModel(env.DB, env.MASTER_KEY, body.model),
        getModelCatalog(env, executionCtx)
    ]);
    if (accounts.length === 0) {
        return {
            kind: "error",
            status: 503 as const,
            message: "No enabled provider accounts configured.",
            errorType: "server_error",
            code: "no_providers"
        };
    }

    // (both fetched concurrently above; resolveModel needs both).

    /**
     * Request logging mode for the `request_logs` table:
     * - "none":   SROUTER_DISABLE_REQUEST_LOGS=1 → no request_logs writes at all.
     * - "all":    SROUTER_LOG_ALL_REQUESTS=1 → log every completed request.
     * - "errors": default → log only terminal failures (4xx/5xx), skip successes.
     * The table holds metadata only (token counts, latency, model, status,
     * cost estimate) — never prompt/response content.
     */
    const requestLogMode = resolveRequestLogMode(env);

    /** Write one request_logs row. Only call when requestLogMode permits it. */
    async function writeRequestLog(row: {
        providerId: string;
        accountId: string | null;
        model: string;
        promptTokens: number;
        completionTokens: number;
        statusCode: number;
        latencyMs: number;
        cost: number;
        resolvedModel: string;
        fallbackOccurred: boolean;
        fallbackPath: string | null;
        fallbackReason: string | null;
    }): Promise<void> {
        await env.DB.prepare(
            `INSERT INTO request_logs
             (id, api_key_id, ip_address, user_agent, provider_id, account_id, model,
              prompt_tokens, completion_tokens, total_tokens, status_code, latency_ms,
              estimated_cost, resolved_model, fallback_occurred, fallback_path,
              fallback_reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
            .bind(
                crypto.randomUUID(),
                apiKeyRow?.id ?? null,
                ip,
                userAgent,
                row.providerId,
                row.accountId,
                row.model,
                row.promptTokens,
                row.completionTokens,
                row.promptTokens + row.completionTokens,
                row.statusCode,
                row.latencyMs,
                row.cost,
                row.resolvedModel,
                row.fallbackOccurred ? 1 : 0,
                row.fallbackPath,
                row.fallbackReason,
                Date.now()
            )
            .run();
    }

    /** Log a terminally failed request (4xx/5xx). No token usage to record. */
    function logTerminalError(
        status: number,
        message: string,
        tracker: AttemptTracker,
        model: string
    ): void {
        if (requestLogMode === "none") return;
        // "errors" (default) and "all" both log terminal failures.
        executionCtx.waitUntil(
            (async () => {
                try {
                    await writeRequestLog({
                        providerId: "",
                        accountId: null,
                        model,
                        promptTokens: 0,
                        completionTokens: 0,
                        statusCode: status,
                        latencyMs: Date.now() - startedAt,
                        cost: 0,
                        resolvedModel: model,
                        fallbackOccurred: tracker.fallbackOccurred,
                        fallbackPath: tracker.fallbackPath.join(" -> "),
                        fallbackReason: message.slice(0, 500)
                    });
                } catch (err) {
                    console.error("request log write failed", err);
                }
            })()
        );
    }

    const logAttempt = (
        candidateResolved: ResolvedModel,
        account: DecryptedAccount,
        tally: UsageTally,
        consumed: Promise<void>,
        currentModel: string,
        tracker: AttemptTracker
    ): void => {
        executionCtx.waitUntil(
            consumed
                .then(async () => {
                    let { promptTokens, completionTokens } = tally;
                    if (!promptTokens) {
                        promptTokens = estimateTokens(JSON.stringify(body.messages));
                    }
                    const completionText = tally.completionParts.join("");
                    if (!completionTokens && completionText) {
                        completionTokens = estimateTokens(completionText);
                    }
                    const totalTokens = promptTokens + completionTokens;
                    const cost = calculateCostFromTokens(
                        { prompt_tokens: promptTokens, completion_tokens: completionTokens },
                        getPricingForModel(account.providerType, currentModel)
                    );
                    const latencyMs = Date.now() - startedAt;
                    // Response-quality assessment: a completed stream with
                    // zero completion tokens, no text, and no tool calls
                    // produced no usable output. Recorded per account
                    // (isolate-local + DO) to deprioritize — never to
                    // hard-exclude. Independent of the request-log mode.
                    // Caveat: `consumed` also resolves on early client
                    // disconnect, so a client that bails before any text
                    // arrives can register as bad; the decayed counters
                    // absorb the occasional false sample.
                    const badQuality = isBadQualityResponse(tally);
                    reportQualityLater(executionCtx, env, account, currentModel, badQuality);
                    try {
                        // Success rows are only logged when full logging is
                        // enabled (SROUTER_LOG_ALL_REQUESTS=1). Default mode
                        // logs terminal errors only; SROUTER_DISABLE_REQUEST_LOGS=1
                        // disables request_logs writes entirely.
                        if (requestLogMode === "all") {
                            await writeRequestLog({
                                providerId: account.providerType,
                                accountId: account.id,
                                model: currentModel,
                                promptTokens,
                                completionTokens,
                                statusCode: 200,
                                latencyMs,
                                cost,
                                resolvedModel:
                                    candidateResolved.upstreamByAccount.get(account.id) ??
                                    currentModel,
                                fallbackOccurred: tracker.fallbackOccurred,
                                fallbackPath: tracker.fallbackOccurred
                                    ? tracker.fallbackPath.join(" -> ")
                                    : null,
                                fallbackReason: tracker.fallbackReason ?? null
                            });
                        }
                        if (apiKeyRow) {
                            // Batched usage accounting: deltas accumulate in the
                            // provider's SwitchState DO shard and flush to D1
                            // every ~30s (see durable.ts /usage). Tradeoff:
                            // quota/credit reads may lag actual usage by up to
                            // ~30s, and deltas are lost if a DO instance is
                            // evicted before flushing. Previously this was a
                            // synchronous D1 UPDATE per request.
                            await routerShard(env, account.providerType)
                                .fetch(
                                    new Request("https://do/usage", {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({
                                            keyId: apiKeyRow.id,
                                            tokens: totalTokens,
                                            cost
                                        })
                                    })
                                )
                                .catch(() => {
                                    // Usage accounting must never fail the request.
                                });
                        }
                    } catch (err) {
                        console.error("request log write failed", err);
                    }
                })
                .catch((err) => console.error("request log write failed", err))
        );
    };

    // Fallback combos: [{model: original}] + matching fallback_rules targets.
    // Each candidate resolves its own accounts and is tried in order; a fallback
    // candidate is skipped unless the previous error triggers its rule.
    const tracker: AttemptTracker = {
        fallbackPath: [body.model],
        fallbackOccurred: false,
        fallbackReason: undefined,
        lastError: null
    };

    let lastErrorMsg = "all providers failed";
    let lastStatus: ContentfulStatusCode = 502;
    // Attempt-cap bookkeeping: bounds worst-case subrequest burn when many
    // accounts are dead (see the slice below). Only real upstream attempts
    // count — cooldown-filtered candidates never reach the loop.
    let attemptCapHit = false;
    let attemptedAccounts = 0;
    let totalCandidateAccounts = 0;

    for await (const attempt of runCandidateAttempts(env.DB, body.model, tracker)) {
        const { currentModel, isFallbackAttempt } = attempt;
        const candidateResolved = await resolveModel(currentModel, accounts, catalog);
        if (!candidateResolved) {
            const msg = `Model "${currentModel}" not found.`;
            tracker.lastError = new Error(msg);
            if (!tracker.fallbackReason) tracker.fallbackReason = msg;
            lastErrorMsg = msg;
            lastStatus = 404;
            continue;
        }

        const candidateOrdered = orderCandidatesLocally(candidateResolved.candidates, currentModel);
        const candidateUpstreamReq = (accountId: string): ChatCompletionRequest =>
            ({
                ...(body as unknown as Record<string, unknown>),
                model: candidateResolved.upstreamByAccount.get(accountId) ?? currentModel,
                stream: true
            }) as ChatCompletionRequest;

        // Bound worst-case subrequest burn: with N dead accounts the loop
        // below would otherwise try all of them, exhausting Cloudflare's
        // ~50-subrequest budget and killing the invocation. Cap actual
        // upstream attempts per model candidate (SROUTER_MAX_ATTEMPTS,
        // default 10) — realistic failover never needs more. Pinned
        // requests resolve to a single account and never hit the cap.
        const maxAttempts = resolveMaxAttempts(env);
        const attemptAccounts = candidateOrdered.slice(0, maxAttempts);
        totalCandidateAccounts += candidateOrdered.length;
        attemptedAccounts += attemptAccounts.length;
        if (candidateOrdered.length > maxAttempts) attemptCapHit = true;

        // Delayed hedging: race the fastest candidate's first byte against
        // SROUTER_HEDGE_DELAY_MS (default 2000ms); on timeout, fire the
        // next-fastest candidate as a hedge and take whichever wins. Pinned
        // requests never hedge — parseAccountPin guarantees a pin restricts
        // candidates, and a single-candidate pool has nothing to hedge
        // against. Each fired hedge consumes one SROUTER_MAX_ATTEMPTS slot
        // (the slice above already bounds the pool, so the cap holds).
        const hedgeDelayMs = resolveHedgeDelayMs(env);
        const { pin: requestPin } = parseAccountPin(body.model);
        const hedgingOn = !requestPin && hedgeDelayMs > 0;

        const startStreamAttempt = async (acct: DecryptedAccount): Promise<StartedAttempt> => {
            // Lazy token refresh (SRouter parity): ensure OAuth tokens are fresh
            // before routing. If refresh fails, continue with the current token;
            // the upstream 401 will trigger failover to the next account.
            if (acct.category === "oauth" && acct.refreshToken) {
                try {
                    const freshToken = await ensureFreshToken(
                        env,
                        acct.id,
                        acct.providerType,
                        acct.accessToken,
                        acct.refreshToken,
                        acct.tokenExpiresAt ?? null,
                        acct.lastRefreshedAt ?? null,
                        (secrets: Record<string, unknown>) => encryptSecretsObject(secrets, env.MASTER_KEY)
                    );
                    if (freshToken && freshToken !== acct.accessToken) {
                        acct.accessToken = freshToken;
                    }
                } catch (err) {
                    // Refresh failure is non-fatal; try with current token.
                    console.error(`Lazy refresh failed for ${acct.id}:`, err instanceof Error ? err.message : err);
                }
            }
            const adapter = buildAdapter(acct);
            trackAttemptStart(acct.id);
            const gen = adapter.chatCompletionStream(candidateUpstreamReq(acct.id));
            // Time-to-first-chunk for latency-aware routing (EMA per pair).
            return { account: acct, gen, attemptStart: Date.now() };
        };

        const failoverOne = (acct: DecryptedAccount, err: unknown): void => {
            const msg = err instanceof Error ? err.message : String(err);
            reportLater(executionCtx, env, acct, false, msg, undefined, currentModel);
            trackAttemptEnd(acct.id);
            tracker.lastError = err instanceof Error ? err : msg;
            if (!tracker.fallbackReason) tracker.fallbackReason = msg;
            lastErrorMsg = msg;
            lastStatus = 502;
        };

        for (let idx = 0; idx < attemptAccounts.length;) {
            const account = attemptAccounts[idx]!;
            const primary = await startStreamAttempt(account);
            const hedgeAccount =
                hedgingOn && idx + 1 < attemptAccounts.length ? attemptAccounts[idx + 1]! : null;
            const outcome = await hedgedFirstByte(
                primary,
                hedgeAccount ? () => startStreamAttempt(hedgeAccount).catch(() => null) : null,
                hedgeDelayMs
            );
            if (outcome.kind === "failed") {
                for (const f of outcome.failures) failoverOne(f.account, f.error);
                idx += outcome.accountsConsumed;
                continue; // failover: nothing was sent to the client yet
            }
            idx += outcome.accountsConsumed;
            const winner = outcome.winner!;
            const first = outcome.winnerFirst!;

            // First chunk arrived: committed to this provider.
            reportLater(
                executionCtx,
                env,
                winner.account,
                true,
                undefined,
                Date.now() - winner.attemptStart,
                currentModel
            );
            if (isFallbackAttempt) {
                tracker.fallbackOccurred = true;
                tracker.fallbackPath.push(currentModel);
            }

            const tally: UsageTally = { promptTokens: 0, completionTokens: 0, completionParts: [], hadToolCalls: false };
            let resolveConsumed!: () => void;
            const consumed = new Promise<void>((resolve) => {
                resolveConsumed = resolve;
            });
            logAttempt(candidateResolved, winner.account, tally, consumed, currentModel, tracker);

            async function* committed(): AsyncGenerator<ChatCompletionChunk, void, void> {
                try {
                    tallyChunk(tally, first.value);
                    yield first.value;
                    for await (const chunk of winner.gen) {
                        tallyChunk(tally, chunk);
                        yield chunk;
                    }
                } finally {
                    trackAttemptEnd(winner.account.id);
                    resolveConsumed();
                }
            }

            const depth = input.depth ?? 0;
            const searchOpts = searchOptionsFromEnv(env);
            // Interception needs a configured search backend to do anything
            // useful. Without one, buffering the whole stream just to assemble
            // tool calls is pure memory overhead on the 128MB isolate — skip
            // it and pass chunks straight through. (Note: performWebSearch has
            // a keyless Wikipedia fallback; bypassing here intentionally
            // disables that too — a silent Wikipedia "search" is not what
            // callers expect from web-search interception.)
            const searchBackendConfigured = !!(
                searchOpts.braveApiKey ||
                searchOpts.tavilyApiKey ||
                searchOpts.serperApiKey ||
                searchOpts.searxngUrl
            );

            if (body.stream === false || body.stream === undefined) {
                const chunks: ChatCompletionChunk[] = [];
                for await (const chunk of committed()) chunks.push(chunk);
                const response = accumulateChunks(
                    chunks,
                    candidateResolved.upstreamByAccount.get(winner.account.id) ?? currentModel
                );

                // Server-side web-search tool interception (SRouter parity).
                // If the model emitted a search tool call for a tool the client
                // did not define, execute it locally and follow up.
                const toolCalls = response.choices?.[0]?.message?.tool_calls;
                if (
                    depth < MAX_INTERCEPT_DEPTH &&
                    searchBackendConfigured &&
                    Array.isArray(toolCalls) &&
                    toolCalls.length > 0 &&
                    hasInterceptableSearchCall(
                        toolCalls.map((tc) => ({ name: tc.function.name })),
                        body.tools
                    )
                ) {
                    const assistantMessage = response.choices[0].message;
                    const assembled = toolCalls.map((tc) => ({
                        id: tc.id,
                        name: tc.function.name,
                        arguments: tc.function.arguments
                    }));
                    const updatedMessages = await buildFollowUpSearchMessages(
                        body.messages,
                        assistantMessage,
                        assembled,
                        body.tools,
                        searchOpts
                    );
                    return executeCompletion(env, executionCtx, {
                        ...input,
                        body: { ...body, messages: updatedMessages },
                        depth: depth + 1
                    });
                }

                return { kind: "json", response };
            }

            // Streaming path with tool-call interception.
            // Buffer chunks while assembling tool calls (matching the original's
            // behavior); if an interceptable search call is found, discard the
            // buffered chunks and yield the follow-up stream instead.
            async function* interceptingStream(): AsyncGenerator<
                ChatCompletionChunk,
                void,
                void
            > {
                const buffered: ChatCompletionChunk[] = [];
                const toolCallsMap = new Map<
                    number,
                    { id: string; name: string; arguments: string }
                >();
                let assistantContent = "";

                for await (const chunk of committed()) {
                    const delta = chunk.choices?.[0]?.delta;
                    if (typeof delta?.content === "string") {
                        assistantContent += delta.content;
                    }
                    if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index ?? toolCallsMap.size;
                            const existing = toolCallsMap.get(idx) || {
                                id: tc.id || `call_${Date.now()}_${idx}`,
                                name: "",
                                arguments: ""
                            };
                            if (tc.id) existing.id = tc.id;
                            if (tc.function?.name) existing.name = tc.function.name;
                            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                            toolCallsMap.set(idx, existing);
                        }
                    }
                    buffered.push(chunk);
                }

                const assembled = Array.from(toolCallsMap.values());
                if (
                    depth < MAX_INTERCEPT_DEPTH &&
                    hasInterceptableSearchCall(assembled, body.tools)
                ) {
                    const assistantToolCalls: ToolCall[] = assembled.map((tc) => ({
                        id: tc.id,
                        type: "function",
                        function: { name: tc.name, arguments: tc.arguments }
                    }));
                    const assistantMessage: ChatMessage = {
                        role: "assistant",
                        content: assistantContent || null,
                        tool_calls: assistantToolCalls
                    };
                    const updatedMessages = await buildFollowUpSearchMessages(
                        body.messages,
                        assistantMessage,
                        assembled,
                        body.tools,
                        searchOpts
                    );
                    const followUp = await executeCompletion(env, executionCtx, {
                        ...input,
                        body: { ...body, messages: updatedMessages },
                        depth: depth + 1
                    });
                    if (followUp.kind === "stream") {
                        yield* followUp.chunks;
                    } else if (followUp.kind === "json") {
                        // Follow-up resolved without streaming (should not happen
                        // when body.stream is true, but handle gracefully).
                        yield {
                            id: followUp.response.id,
                            object: "chat.completion.chunk",
                            created: followUp.response.created,
                            model: followUp.response.model,
                            choices: [
                                {
                                    index: 0,
                                    delta: {
                                        role: "assistant",
                                        content:
                                            followUp.response.choices?.[0]?.message?.content ?? ""
                                    },
                                    finish_reason: "stop"
                                }
                            ]
                        } as ChatCompletionChunk;
                    } else {
                        throw new Error(followUp.message);
                    }
                    return;
                }

                for (const chunk of buffered) {
                    yield chunk;
                }
            }

            // When interception is impossible (max depth reached, or no search
            // backend configured), stream chunks straight through instead of
            // buffering the whole response. Buffering exists only to assemble
            // tool calls for interception; when the intercept branch can never
            // trigger, interceptingStream() would just replay committed()
            // verbatim — at O(response) memory cost on the 128MB isolate.
            const canIntercept = (input.depth ?? 0) < MAX_INTERCEPT_DEPTH && searchBackendConfigured;
            return {
                kind: "stream",
                chunks: canIntercept ? interceptingStream() : committed(),
                providerType: account.providerType,
                accountId: account.id
            };
        }
    }

    // Terminal failure: all candidates/accounts exhausted (or model unknown).
    // In "errors" (default) and "all" modes, log one error row for
    // investigation. Per-attempt failover failures are already tracked in the
    // DO circuit breaker via reportLater(); only the terminal outcome is logged
    // here to avoid a D1 write per failed attempt during outages. When the
    // attempt cap stopped failover early, say so — otherwise an operator
    // can't tell "10 accounts all failed" from "183 accounts, gave up at 10".
    const capNote =
        attemptCapHit && lastStatus === 502
            ? ` [attempt_cap_reached: attempted ${attemptedAccounts} of ${totalCandidateAccounts} candidate accounts]`
            : "";
    const finalErrorMsg = lastErrorMsg + capNote;
    logTerminalError(lastStatus, finalErrorMsg, tracker, body.model);

    return {
        kind: "error",
        status: lastStatus,
        message:
            lastStatus === 404
                ? lastErrorMsg
                : `Upstream request failed: ${finalErrorMsg.slice(0, 300)}`,
        errorType: lastStatus === 404 ? "invalid_request_error" : "server_error",
        code: lastStatus === 404 ? "model_not_found" : "upstream_error"
    };
}
