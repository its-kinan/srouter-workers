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
import { ensureFreshToken } from "../providers/oauth-refresh.js";
import { encryptSecretsObject } from "../crypto/secretbox.js";
import { buildAdapter, candidateAccountsForPrefix, listAllModels, loadAccounts, providerAlias, stripRoutingPrefix } from "../providers/registry.js";
import { accumulateChunks } from "../vendor/translator/index.js";
import { calculateCostFromTokens, getPricingForModel } from "../vendor/pricing.js";
import { estimateTokens } from "./tokens.js";
import { runCandidateAttempts } from "../routing/fallback.js";
import { buildFollowUpSearchMessages, hasInterceptableSearchCall, MAX_INTERCEPT_DEPTH } from "../services/toolInterceptor.js";
/** Build web-search options from Worker secrets. */
function searchOptionsFromEnv(env) {
    return {
        braveApiKey: env.BRAVE_API_KEY,
        tavilyApiKey: env.TAVILY_API_KEY,
        serperApiKey: env.SERPER_API_KEY,
        searxngUrl: env.SEARXNG_URL
    };
}
function routerStub(env) {
    return env.ROUTER_STATE.getByName("router");
}
async function report(env, accountId, ok, error) {
    try {
        await routerStub(env).fetch(new Request("https://do/report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId, ok, error })
        }));
    }
    catch {
        // Router-state reporting must never fail the request itself.
    }
}
async function orderedCandidates(env, accounts) {
    const refs = accounts.map((a) => ({ id: a.id, base: a.providerType }));
    try {
        const res = await routerStub(env).fetch(new Request("https://do/route", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accounts: refs })
        }));
        const data = (await res.json());
        const byId = new Map(accounts.map((a) => [a.id, a]));
        const ordered = (data.orderedIds ?? [])
            .map((id) => byId.get(id))
            .filter((a) => !!a);
        for (const a of accounts)
            if (!ordered.includes(a))
                ordered.push(a);
        return ordered;
    }
    catch {
        return accounts;
    }
}
async function resolveModel(env, model, accounts) {
    const prefixed = candidateAccountsForPrefix(model, accounts);
    if (prefixed.length > 0) {
        return {
            candidates: prefixed,
            upstreamByAccount: new Map(prefixed.map((a) => [a.id, stripRoutingPrefix(model, a)]))
        };
    }
    // Bare model id: look it up in the aggregated catalog.
    let catalog = null;
    try {
        const res = await routerStub(env).fetch(new Request("https://do/models"));
        catalog = (await res.json()).models;
    }
    catch {
        catalog = null;
    }
    if (!catalog || catalog.length === 0) {
        catalog = await listAllModels(accounts);
        // Never cache an empty aggregation — see getMergedModels.
        // An empty catalog matches nothing, so resolve to null (unknown model).
        if (catalog.length === 0)
            return null;
        routerStub(env)
            .fetch(new Request("https://do/models", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ models: catalog })
        }))
            .catch(() => { });
    }
    const wanted = model.toLowerCase();
    const matched = new Set();
    for (const m of catalog ?? []) {
        if (m.id.toLowerCase() === wanted) {
            matched.add(m.id);
            continue;
        }
        const bare = m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.id;
        if (bare.toLowerCase() === wanted)
            matched.add(m.id);
    }
    if (matched.size === 0)
        return null;
    const candidates = [];
    const upstreamByAccount = new Map();
    for (const a of accounts) {
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
function tallyChunk(tally, chunk) {
    if (chunk.usage) {
        if (chunk.usage.prompt_tokens)
            tally.promptTokens = chunk.usage.prompt_tokens;
        if (chunk.usage.completion_tokens) {
            tally.completionTokens = chunk.usage.completion_tokens;
        }
    }
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === "string")
        tally.completionText += delta;
}
export async function executeCompletion(env, executionCtx, input) {
    const { body, apiKeyRow, startedAt, ip, userAgent } = input;
    const accounts = await loadAccounts(env.DB, env.MASTER_KEY);
    if (accounts.length === 0) {
        return {
            kind: "error",
            status: 503,
            message: "No enabled provider accounts configured.",
            errorType: "server_error",
            code: "no_providers"
        };
    }
    const logAttempt = (candidateResolved, account, tally, consumed, currentModel, tracker) => {
        executionCtx.waitUntil(consumed
            .then(async () => {
            let { promptTokens, completionTokens } = tally;
            if (!promptTokens) {
                promptTokens = estimateTokens(JSON.stringify(body.messages));
            }
            if (!completionTokens && tally.completionText) {
                completionTokens = estimateTokens(tally.completionText);
            }
            const totalTokens = promptTokens + completionTokens;
            const cost = calculateCostFromTokens({ prompt_tokens: promptTokens, completion_tokens: completionTokens }, getPricingForModel(account.providerType, currentModel));
            const latencyMs = Date.now() - startedAt;
            try {
                await env.DB.prepare(`INSERT INTO request_logs
                             (id, api_key_id, ip_address, user_agent, provider_id, account_id, model,
                              prompt_tokens, completion_tokens, total_tokens, status_code, latency_ms,
                              estimated_cost, resolved_model, fallback_occurred, fallback_path,
                              fallback_reason, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 200, ?, ?, ?, ?, ?, ?, ?)`)
                    .bind(crypto.randomUUID(), apiKeyRow?.id ?? null, ip, userAgent, account.providerType, account.id, currentModel, promptTokens, completionTokens, totalTokens, latencyMs, cost, candidateResolved.upstreamByAccount.get(account.id) ?? currentModel, tracker.fallbackOccurred ? 1 : 0, tracker.fallbackOccurred ? tracker.fallbackPath.join(" -> ") : null, tracker.fallbackReason ?? null, Date.now())
                    .run();
                if (apiKeyRow) {
                    await env.DB.prepare(`UPDATE api_keys
                                 SET usage_tokens = usage_tokens + ?, usage_cost = usage_cost + ?
                                 WHERE id = ?`)
                        .bind(totalTokens, cost, apiKeyRow.id)
                        .run();
                }
            }
            catch (err) {
                console.error("request log write failed", err);
            }
        })
            .catch((err) => console.error("request log write failed", err)));
    };
    // Fallback combos: [{model: original}] + matching fallback_rules targets.
    // Each candidate resolves its own accounts and is tried in order; a fallback
    // candidate is skipped unless the previous error triggers its rule.
    const tracker = {
        fallbackPath: [body.model],
        fallbackOccurred: false,
        fallbackReason: undefined,
        lastError: null
    };
    let lastErrorMsg = "all providers failed";
    let lastStatus = 502;
    for await (const attempt of runCandidateAttempts(env.DB, body.model, tracker)) {
        const { currentModel, isFallbackAttempt } = attempt;
        const candidateResolved = await resolveModel(env, currentModel, accounts);
        if (!candidateResolved) {
            const msg = `Model "${currentModel}" not found.`;
            tracker.lastError = new Error(msg);
            if (!tracker.fallbackReason)
                tracker.fallbackReason = msg;
            lastErrorMsg = msg;
            lastStatus = 404;
            continue;
        }
        const candidateOrdered = await orderedCandidates(env, candidateResolved.candidates);
        const candidateUpstreamReq = (accountId) => ({
            ...body,
            model: candidateResolved.upstreamByAccount.get(accountId) ?? currentModel,
            stream: true
        });
        for (const account of candidateOrdered) {
            // Lazy token refresh (SRouter parity): ensure OAuth tokens are fresh
            // before routing. If refresh fails, continue with the current token;
            // the upstream 401 will trigger failover to the next account.
            if (account.category === "oauth" && account.refreshToken) {
                try {
                    const freshToken = await ensureFreshToken(env, account.id, account.providerType, account.accessToken, account.refreshToken, account.tokenExpiresAt ?? null, account.lastRefreshedAt ?? null, (secrets) => encryptSecretsObject(secrets, env.MASTER_KEY));
                    if (freshToken && freshToken !== account.accessToken) {
                        account.accessToken = freshToken;
                    }
                }
                catch (err) {
                    // Refresh failure is non-fatal; try with current token.
                    console.error(`Lazy refresh failed for ${account.id}:`, err instanceof Error ? err.message : err);
                }
            }
            const adapter = buildAdapter(account);
            const gen = adapter.chatCompletionStream(candidateUpstreamReq(account.id));
            let first;
            try {
                first = await gen.next();
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                await report(env, account.id, false, msg);
                tracker.lastError = err instanceof Error ? err : msg;
                if (!tracker.fallbackReason)
                    tracker.fallbackReason = msg;
                lastErrorMsg = msg;
                lastStatus = 502;
                continue; // failover: nothing was sent to the client yet
            }
            if (first.done) {
                await report(env, account.id, false, "empty response stream");
                tracker.lastError = new Error("empty response stream");
                if (!tracker.fallbackReason)
                    tracker.fallbackReason = "empty response stream";
                lastErrorMsg = "empty response stream";
                lastStatus = 502;
                continue;
            }
            // First chunk arrived: committed to this provider.
            await report(env, account.id, true);
            if (isFallbackAttempt) {
                tracker.fallbackOccurred = true;
                tracker.fallbackPath.push(currentModel);
            }
            const tally = { promptTokens: 0, completionTokens: 0, completionText: "" };
            let resolveConsumed;
            const consumed = new Promise((resolve) => {
                resolveConsumed = resolve;
            });
            logAttempt(candidateResolved, account, tally, consumed, currentModel, tracker);
            async function* committed() {
                try {
                    tallyChunk(tally, first.value);
                    yield first.value;
                    for await (const chunk of gen) {
                        tallyChunk(tally, chunk);
                        yield chunk;
                    }
                }
                finally {
                    resolveConsumed();
                }
            }
            const depth = input.depth ?? 0;
            const searchOpts = searchOptionsFromEnv(env);
            if (body.stream === false || body.stream === undefined) {
                const chunks = [];
                for await (const chunk of committed())
                    chunks.push(chunk);
                const response = accumulateChunks(chunks, candidateResolved.upstreamByAccount.get(account.id) ?? currentModel);
                // Server-side web-search tool interception (SRouter parity).
                // If the model emitted a search tool call for a tool the client
                // did not define, execute it locally and follow up.
                const toolCalls = response.choices?.[0]?.message?.tool_calls;
                if (depth < MAX_INTERCEPT_DEPTH &&
                    Array.isArray(toolCalls) &&
                    toolCalls.length > 0 &&
                    hasInterceptableSearchCall(toolCalls.map((tc) => ({ name: tc.function.name })), body.tools)) {
                    const assistantMessage = response.choices[0].message;
                    const assembled = toolCalls.map((tc) => ({
                        id: tc.id,
                        name: tc.function.name,
                        arguments: tc.function.arguments
                    }));
                    const updatedMessages = await buildFollowUpSearchMessages(body.messages, assistantMessage, assembled, body.tools, searchOpts);
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
            async function* interceptingStream() {
                const buffered = [];
                const toolCallsMap = new Map();
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
                            if (tc.id)
                                existing.id = tc.id;
                            if (tc.function?.name)
                                existing.name = tc.function.name;
                            if (tc.function?.arguments)
                                existing.arguments += tc.function.arguments;
                            toolCallsMap.set(idx, existing);
                        }
                    }
                    buffered.push(chunk);
                }
                const assembled = Array.from(toolCallsMap.values());
                if (depth < MAX_INTERCEPT_DEPTH &&
                    hasInterceptableSearchCall(assembled, body.tools)) {
                    const assistantToolCalls = assembled.map((tc) => ({
                        id: tc.id,
                        type: "function",
                        function: { name: tc.name, arguments: tc.arguments }
                    }));
                    const assistantMessage = {
                        role: "assistant",
                        content: assistantContent || null,
                        tool_calls: assistantToolCalls
                    };
                    const updatedMessages = await buildFollowUpSearchMessages(body.messages, assistantMessage, assembled, body.tools, searchOpts);
                    const followUp = await executeCompletion(env, executionCtx, {
                        ...input,
                        body: { ...body, messages: updatedMessages },
                        depth: depth + 1
                    });
                    if (followUp.kind === "stream") {
                        yield* followUp.chunks;
                    }
                    else if (followUp.kind === "json") {
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
                                        content: followUp.response.choices?.[0]?.message?.content ?? ""
                                    },
                                    finish_reason: "stop"
                                }
                            ]
                        };
                    }
                    else {
                        throw new Error(followUp.message);
                    }
                    return;
                }
                for (const chunk of buffered) {
                    yield chunk;
                }
            }
            return {
                kind: "stream",
                chunks: interceptingStream(),
                providerType: account.providerType,
                accountId: account.id
            };
        }
    }
    return {
        kind: "error",
        status: lastStatus,
        message: lastStatus === 404
            ? lastErrorMsg
            : `Upstream request failed: ${lastErrorMsg.slice(0, 300)}`,
        errorType: lastStatus === 404 ? "invalid_request_error" : "server_error",
        code: lastStatus === 404 ? "model_not_found" : "upstream_error"
    };
}
