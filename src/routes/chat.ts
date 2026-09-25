// POST /v1/chat/completions — OpenAI-compatible chat endpoint.
//
// Flow (mirrors SRouter's chat controller):
//   1. apiKeyAuth middleware (auth + quota checks)
//   2. Validate body; resolve candidate accounts by model prefix (or bare id
//      via the DO-cached model catalog)
//   3. Ask the RouterState DO for health-ordered candidates (round-robin +
//      circuit breaker)
//   4. Try candidates in order; FAILOVER ONLY BEFORE THE FIRST CHUNK — once
//      bytes flow to the client we are committed to that provider
//   5. Report success/failure back to the DO; log the request via waitUntil;
//      atomically bump the virtual key's token/cost usage.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env.js";
import type { AppHonoEnv } from "../hono-env.js";
import { apiKeyAuth, type ApiKeyRow } from "../middleware/apiKeyAuth.js";
import {
    buildAdapter,
    candidateAccountsForPrefix,
    listAllModels,
    loadAccounts,
    providerAlias,
    stripRoutingPrefix,
} from "../providers/registry.js";
import type { DecryptedAccount } from "../providers/types.js";
import type {
    ChatCompletionChunk,
    ChatCompletionRequest,
    ModelObject
} from "../vendor/types/index.js";
import { accumulateChunks } from "../vendor/translator/index.js";
import { calculateCostFromTokens, getPricingForModel } from "../vendor/pricing.js";
import { estimateTokens } from "../router/tokens.js";

export const chatRoutes = new Hono<AppHonoEnv>();

const ChatBodySchema = z.object({
    model: z.string().min(1),
    messages: z.array(z.unknown()).min(1),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().optional(),
    max_completion_tokens: z.number().optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    response_format: z.unknown().optional(),
    stop: z.unknown().optional(),
    seed: z.number().optional(),
    user: z.string().optional()
});

type ChatBody = z.infer<typeof ChatBodySchema>;

function routerStub(env: Env): DurableObjectStub {
    return env.ROUTER_STATE.getByName("router");
}

async function report(
    env: Env,
    accountId: string,
    ok: boolean,
    error?: string
): Promise<void> {
    try {
        await routerStub(env).fetch(
            new Request("https://do/report", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ accountId, ok, error })
            })
        );
    } catch {
        // Router-state reporting must never fail the request itself.
    }
}

async function orderedCandidates(
    env: Env,
    accounts: DecryptedAccount[]
): Promise<DecryptedAccount[]> {
    const refs = accounts.map((a) => ({ id: a.id, base: a.providerType }));
    try {
        const res = await routerStub(env).fetch(
            new Request("https://do/route", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ accounts: refs })
            })
        );
        const data = (await res.json()) as { orderedIds: string[] };
        const byId = new Map(accounts.map((a) => [a.id, a]));
        const ordered = (data.orderedIds ?? [])
            .map((id) => byId.get(id))
            .filter((a): a is DecryptedAccount => !!a);
        for (const a of accounts) if (!ordered.includes(a)) ordered.push(a);
        return ordered;
    } catch {
        return accounts;
    }
}

interface ResolvedModel {
    candidates: DecryptedAccount[];
    /** Model id to send upstream for each candidate id. */
    upstreamByAccount: Map<string, string>;
}

async function resolveModel(
    env: Env,
    model: string,
    accounts: DecryptedAccount[]
): Promise<ResolvedModel | null> {
    const prefixed = candidateAccountsForPrefix(model, accounts);
    if (prefixed.length > 0) {
        return {
            candidates: prefixed,
            upstreamByAccount: new Map(
                prefixed.map((a) => [a.id, stripRoutingPrefix(model, a)] as [string, string])
            )
        };
    }
    // Bare model id: look it up in the aggregated catalog.
    let catalog: ModelObject[] | null = null;
    try {
        const res = await routerStub(env).fetch(new Request("https://do/models"));
        catalog = ((await res.json()) as { models: ModelObject[] | null }).models;
    } catch {
        catalog = null;
    }
    if (!catalog) {
        catalog = await listAllModels(accounts);
        routerStub(env)
            .fetch(
                new Request("https://do/models", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ models: catalog })
                })
            )
            .catch(() => {});
    }
    const wanted = model.toLowerCase();
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

function sseEncode(chunk: ChatCompletionChunk): string {
    return `data: ${JSON.stringify(chunk)}\n\n`;
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

chatRoutes.post("/chat/completions", apiKeyAuth, async (c) => {
    const env = c.env;
    const rawBody =
        (c.get("parsedBody") as unknown) ?? (await c.req.json().catch(() => null));
    const parsed = ChatBodySchema.safeParse(rawBody);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return c.json(
            {
                error: {
                    message: `Invalid request: ${(issue?.path.join(".") || "body") + " " + (issue?.message || "")}`.trim(),
                    type: "invalid_request_error",
                    code: "invalid_request"
                }
            },
            400
        );
    }
    const body = parsed.data;
    const startedAt = Date.now();

    const accounts = await loadAccounts(env.DB, env.MASTER_KEY);
    if (accounts.length === 0) {
        return c.json(
            {
                error: {
                    message: "No enabled provider accounts configured.",
                    type: "server_error",
                    code: "no_providers"
                }
            },
            503
        );
    }

    const resolved = await resolveModel(env, body.model, accounts);
    if (!resolved) {
        return c.json(
            {
                error: {
                    message: `Model "${body.model}" not found.`,
                    type: "invalid_request_error",
                    code: "model_not_found"
                }
            },
            404
        );
    }

    const ordered = await orderedCandidates(env, resolved.candidates);
    const apiKeyRow = c.get("apiKeyRow") as ApiKeyRow | undefined;

    const upstreamReq = (accountId: string): ChatCompletionRequest =>
        ({
            ...(body as unknown as Record<string, unknown>),
            model: resolved.upstreamByAccount.get(accountId) ?? body.model,
            stream: true
        }) as ChatCompletionRequest;

    const logAttempt = (
        account: DecryptedAccount,
        tally: UsageTally,
        consumed: Promise<void>
    ): void => {
        c.executionCtx.waitUntil(
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
                        getPricingForModel(account.providerType, body.model)
                    );
                    const latencyMs = Date.now() - startedAt;
                    try {
                        await env.DB.prepare(
                            `INSERT INTO request_logs
                             (id, api_key_id, ip_address, user_agent, provider_id, account_id, model,
                              prompt_tokens, completion_tokens, total_tokens, status_code, latency_ms,
                              estimated_cost, resolved_model, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 200, ?, ?, ?, ?)`
                        )
                            .bind(
                                crypto.randomUUID(),
                                apiKeyRow?.id ?? null,
                                c.req.header("cf-connecting-ip") ?? null,
                                (c.req.header("user-agent") ?? "").slice(0, 255) || null,
                                account.providerType,
                                account.id,
                                body.model,
                                promptTokens,
                                completionTokens,
                                totalTokens,
                                latencyMs,
                                cost,
                                resolved.upstreamByAccount.get(account.id) ?? body.model,
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

    let lastError = "all providers failed";

    for (const account of ordered) {
        const adapter = buildAdapter(account);
        const gen = adapter.chatCompletionStream(upstreamReq(account.id));

        let first: IteratorResult<ChatCompletionChunk>;
        try {
            first = await gen.next();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await report(env, account.id, false, msg);
            lastError = msg;
            continue; // failover: nothing was sent to the client yet
        }
        if (first.done) {
            await report(env, account.id, false, "empty response stream");
            lastError = "empty response stream";
            continue;
        }

        // First chunk arrived: committed to this provider.
        await report(env, account.id, true);

        const tally: UsageTally = { promptTokens: 0, completionTokens: 0, completionText: "" };
        let resolveConsumed!: () => void;
        const consumed = new Promise<void>((resolve) => {
            resolveConsumed = resolve;
        });
        logAttempt(account, tally, consumed);

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

        if (body.stream === false || body.stream === undefined) {
            const chunks: ChatCompletionChunk[] = [];
            for await (const chunk of committed()) chunks.push(chunk);
            const response = accumulateChunks(
                chunks,
                resolved.upstreamByAccount.get(account.id) ?? body.model
            );
            return c.json(response);
        }

        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                const enc = new TextEncoder();
                try {
                    for await (const chunk of committed()) {
                        controller.enqueue(enc.encode(sseEncode(chunk)));
                    }
                    controller.enqueue(enc.encode("data: [DONE]\n\n"));
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    controller.enqueue(
                        enc.encode(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`)
                    );
                } finally {
                    controller.close();
                }
            }
        });
        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "X-Provider": account.providerType,
                "X-Account-Id": account.id
            }
        });
    }

    return c.json(
        {
            error: {
                message: `Upstream request failed: ${lastError.slice(0, 300)}`,
                type: "server_error",
                code: "upstream_error"
            }
        },
        502
    );
});
