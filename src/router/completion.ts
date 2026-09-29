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
//   3. orderedCandidates (RouterState DO: round-robin + circuit breaker)
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
import { routerShardName } from "./durable.js";
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

function routerShard(env: Env, providerType: string): DurableObjectStub {
    return env.ROUTER_STATE.getByName(routerShardName(providerType));
}

// --- Isolate-local routing state ---
// /route and /report used to be awaited inline on the request path, funneling
// every request through the single RouterState DO instance. Under load that
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

/** Order candidates without touching the DO: skip cooling accounts, round-robin the rest. */
function orderCandidatesLocally(candidates: DecryptedAccount[]): DecryptedAccount[] {
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
    const base = pool[0]!.providerType;
    const idx = (localRoundRobin.get(base) ?? 0) % pool.length;
    localRoundRobin.set(base, idx + 1);
    return [...pool.slice(idx), ...pool.slice(0, idx)];
}

/** Fire-and-forget circuit report to the provider's DO shard. Never blocks. */
function reportLater(
    ctx: { waitUntil(p: Promise<unknown>): void },
    env: Env,
    account: DecryptedAccount,
    ok: boolean,
    error?: string
): void {
    if (ok) localCooldownUntil.delete(account.id);
    else localCooldownUntil.set(account.id, Date.now() + LOCAL_COOLDOWN_MS);
    ctx.waitUntil(
        (async () => {
            try {
                await routerShard(env, account.providerType).fetch(
                    new Request("https://do/report", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ accountId: account.id, ok, error })
                    })
                );
            } catch {
                // Router-state reporting must never fail the request itself.
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
    completionText: string;
}

function tallyChunk(tally: UsageTally, chunk: ChatCompletionChunk): void {
    if (chunk.usage) {
        if (chunk.usage.prompt_tokens) tally.promptTokens = chunk.usage.prompt_tokens;
        if (chunk.usage.completion_tokens) {
            tally.completionTokens = chunk.usage.completion_tokens;
        }
    }
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === "string") tally.completionText += delta;
}

export async function executeCompletion(
    env: Env,
    executionCtx: { waitUntil(promise: Promise<unknown>): void },
    input: CompletionInput
): Promise<CompletionOutcome> {
    const { body, apiKeyRow, startedAt, ip, userAgent } = input;

    // Decrypt only the providers this request (and its fallback targets)
    // can touch — the isolate cache makes repeat requests ~free.
    const accounts = await loadAccountsForModel(env.DB, env.MASTER_KEY, body.model);
    if (accounts.length === 0) {
        return {
            kind: "error",
            status: 503 as const,
            message: "No enabled provider accounts configured.",
            errorType: "server_error",
            code: "no_providers"
        };
    }

    // Aggregated model catalog for bare-model resolution, served
    // stale-while-revalidate (fetched once per request, never inline fan-out).
    const catalog = await getModelCatalog(env, executionCtx);

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
                    if (!completionTokens && tally.completionText) {
                        completionTokens = estimateTokens(tally.completionText);
                    }
                    const totalTokens = promptTokens + completionTokens;
                    const cost = calculateCostFromTokens(
                        { prompt_tokens: promptTokens, completion_tokens: completionTokens },
                        getPricingForModel(account.providerType, currentModel)
                    );
                    const latencyMs = Date.now() - startedAt;
                    try {
                        await env.DB.prepare(
                            `INSERT INTO request_logs
                             (id, api_key_id, ip_address, user_agent, provider_id, account_id, model,
                              prompt_tokens, completion_tokens, total_tokens, status_code, latency_ms,
                              estimated_cost, resolved_model, fallback_occurred, fallback_path,
                              fallback_reason, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 200, ?, ?, ?, ?, ?, ?, ?)`
                        )
                            .bind(
                                crypto.randomUUID(),
                                apiKeyRow?.id ?? null,
                                ip,
                                userAgent,
                                account.providerType,
                                account.id,
                                currentModel,
                                promptTokens,
                                completionTokens,
                                totalTokens,
                                latencyMs,
                                cost,
                                candidateResolved.upstreamByAccount.get(account.id) ?? currentModel,
                                tracker.fallbackOccurred ? 1 : 0,
                                tracker.fallbackOccurred ? tracker.fallbackPath.join(" -> ") : null,
                                tracker.fallbackReason ?? null,
                                Date.now()
                            )
                            .run();
                        if (apiKeyRow) {
                            await env.DB.prepare(
                                `UPDATE api_keys
                                 SET usage_tokens = usage_tokens + ?, usage_cost = usage_cost + ?
                                 WHERE id = ?`
                            )
                                .bind(totalTokens, cost, apiKeyRow.id)
                                .run();
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

        const candidateOrdered = orderCandidatesLocally(candidateResolved.candidates);
        const candidateUpstreamReq = (accountId: string): ChatCompletionRequest =>
            ({
                ...(body as unknown as Record<string, unknown>),
                model: candidateResolved.upstreamByAccount.get(accountId) ?? currentModel,
                stream: true
            }) as ChatCompletionRequest;

        for (const account of candidateOrdered) {
            // Lazy token refresh (SRouter parity): ensure OAuth tokens are fresh
            // before routing. If refresh fails, continue with the current token;
            // the upstream 401 will trigger failover to the next account.
            if (account.category === "oauth" && account.refreshToken) {
                try {
                    const freshToken = await ensureFreshToken(
                        env,
                        account.id,
                        account.providerType,
                        account.accessToken,
                        account.refreshToken,
                        account.tokenExpiresAt ?? null,
                        account.lastRefreshedAt ?? null,
                        (secrets: Record<string, unknown>) => encryptSecretsObject(secrets, env.MASTER_KEY)
                    );
                    if (freshToken && freshToken !== account.accessToken) {
                        account.accessToken = freshToken;
                    }
                } catch (err) {
                    // Refresh failure is non-fatal; try with current token.
                    console.error(`Lazy refresh failed for ${account.id}:`, err instanceof Error ? err.message : err);
                }
            }

            const adapter = buildAdapter(account);
            const gen = adapter.chatCompletionStream(candidateUpstreamReq(account.id));

            let first: IteratorResult<ChatCompletionChunk>;
            try {
                first = await gen.next();
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                reportLater(executionCtx, env, account, false, msg);
                tracker.lastError = err instanceof Error ? err : msg;
                if (!tracker.fallbackReason) tracker.fallbackReason = msg;
                lastErrorMsg = msg;
                lastStatus = 502;
                continue; // failover: nothing was sent to the client yet
            }
            if (first.done) {
                reportLater(executionCtx, env, account, false, "empty response stream");
                tracker.lastError = new Error("empty response stream");
                if (!tracker.fallbackReason) tracker.fallbackReason = "empty response stream";
                lastErrorMsg = "empty response stream";
                lastStatus = 502;
                continue;
            }

            // First chunk arrived: committed to this provider.
            reportLater(executionCtx, env, account, true);
            if (isFallbackAttempt) {
                tracker.fallbackOccurred = true;
                tracker.fallbackPath.push(currentModel);
            }

            const tally: UsageTally = { promptTokens: 0, completionTokens: 0, completionText: "" };
            let resolveConsumed!: () => void;
            const consumed = new Promise<void>((resolve) => {
                resolveConsumed = resolve;
            });
            logAttempt(candidateResolved, account, tally, consumed, currentModel, tracker);

            async function* committed(): AsyncGenerator<ChatCompletionChunk, void, void> {
                try {
                    tallyChunk(tally, first.value);
                    yield first.value;
                    for await (const chunk of gen) {
                        tallyChunk(tally, chunk);
                        yield chunk;
                    }
                } finally {
                    resolveConsumed();
                }
            }

            const depth = input.depth ?? 0;
            const searchOpts = searchOptionsFromEnv(env);

            if (body.stream === false || body.stream === undefined) {
                const chunks: ChatCompletionChunk[] = [];
                for await (const chunk of committed()) chunks.push(chunk);
                const response = accumulateChunks(
                    chunks,
                    candidateResolved.upstreamByAccount.get(account.id) ?? currentModel
                );

                // Server-side web-search tool interception (SRouter parity).
                // If the model emitted a search tool call for a tool the client
                // did not define, execute it locally and follow up.
                const toolCalls = response.choices?.[0]?.message?.tool_calls;
                if (
                    depth < MAX_INTERCEPT_DEPTH &&
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

            // When interception is impossible (max depth reached), stream chunks
            // straight through instead of buffering the whole response.
            // Buffering exists only to assemble tool calls for interception;
            // at max depth the intercept branch can never trigger, so
            // interceptingStream() would just replay committed() verbatim.
            const canIntercept = (input.depth ?? 0) < MAX_INTERCEPT_DEPTH;
            return {
                kind: "stream",
                chunks: canIntercept ? interceptingStream() : committed(),
                providerType: account.providerType,
                accountId: account.id
            };
        }
    }

    return {
        kind: "error",
        status: lastStatus,
        message:
            lastStatus === 404
                ? lastErrorMsg
                : `Upstream request failed: ${lastErrorMsg.slice(0, 300)}`,
        errorType: lastStatus === 404 ? "invalid_request_error" : "server_error",
        code: lastStatus === 404 ? "model_not_found" : "upstream_error"
    };
}
