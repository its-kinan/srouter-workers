// POST /v1/chat/completions — OpenAI-compatible chat endpoint.
//
// Flow (mirrors SRouter's chat controller):
//   1. apiKeyAuth middleware (auth + quota checks)
//   2. rateLimit middleware (per-key requests/minute)
//   3. Validate body, then run the shared completion engine
//      (src/router/completion.ts): model resolution, RouterState
//      round-robin + circuit breaker, failover before the first chunk,
//      request logging and key usage accounting.

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppHonoEnv } from "../hono-env.js";
import { apiKeyAuth, type ApiKeyRow } from "../middleware/apiKeyAuth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { executeCompletion } from "../router/completion.js";
import { accountCacheStats } from "../providers/registry.js";
import type { ChatCompletionChunk, ChatCompletionRequest } from "../vendor/types/index.js";

/** "hits=N misses=M" for the isolate that served the request. */
function cacheHeader(): string {
    return `hits=${accountCacheStats.hits} misses=${accountCacheStats.misses}`;
}

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

function sseEncode(chunk: ChatCompletionChunk): string {
    return `data: ${JSON.stringify(chunk)}\n\n`;
}

async function handleChatCompletion(c: Context<AppHonoEnv>) {
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

    const outcome = await executeCompletion(env, c.executionCtx, {
        body: parsed.data as unknown as ChatCompletionRequest,
        apiKeyRow: c.get("apiKeyRow") as ApiKeyRow | undefined,
        startedAt: Date.now(),
        ip: c.req.header("cf-connecting-ip") ?? null,
        userAgent: (c.req.header("user-agent") ?? "").slice(0, 255) || null
    });

    if (outcome.kind === "error") {
        return c.json(
            {
                error: {
                    message: outcome.message,
                    type: outcome.errorType,
                    code: outcome.code
                }
            },
            outcome.status,
            // Per-isolate cache observability: the counters belong to the
            // isolate that served this request.
            { "X-Account-Cache": cacheHeader() }
        );
    }

    if (outcome.kind === "json") {
        return c.json(outcome.response, 200, { "X-Account-Cache": cacheHeader() });
    }

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const enc = new TextEncoder();
            try {
                for await (const chunk of outcome.chunks) {
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
            "X-Provider": outcome.providerType,
            "X-Account-Id": outcome.accountId,
            "X-Account-Cache": cacheHeader()
        }
    });
}

// SRouter's ChatRouter registers both the plural and singular paths with the
// same middleware chain and controller.
chatRoutes.post("/chat/completions", apiKeyAuth, rateLimit, handleChatCompletion);
chatRoutes.post("/chat/completion", apiKeyAuth, rateLimit, handleChatCompletion);
