// POST /v1/messages — Anthropic-compatible messages endpoint.
//
// Mirrors SRouter's MessagesController 1:1:
//   1. apiKeyAuth middleware (auth + quota + model allow-list checks)
//   2. rateLimit middleware (per-key requests/minute)
//   3. Validate the Anthropic request body
//   4. AnthropicToOpenAIRequest → run the shared completion engine
//      (src/router/completion.ts — same routing/failover/logging as
//      /v1/chat/completions)
//   5. Translate the OpenAI response/chunks back via
//      OpenAIToAnthropicResponse / OpenAIToAnthropicStream
//
// Errors use the Anthropic error envelope:
//   { "type": "error", "error": { "type": "<type>", "message": "<message>" } }

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { AppHonoEnv } from "../../hono-env.js";
import { apiKeyAuth, type ApiKeyRow } from "../../middleware/apiKeyAuth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { executeCompletion } from "../../router/completion.js";
import {
    AnthropicToOpenAIRequest,
    OpenAIToAnthropicResponse,
    OpenAIToAnthropicStream
} from "../../vendor/translator/anthropic.js";
import type {
    AnthropicContentBlock,
    AnthropicMessageRequest
} from "../../vendor/types/index.js";

export const messagesRoutes = new Hono<AppHonoEnv>();

/** Mirrors SRouter's MAX_BODY_BYTES (apps/api BodyLimit middleware). */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

// --- Request validation (ported from @srouter/types schemas/anthropic.ts) ---

const AnthropicCacheControlSchema = z.object({ type: z.literal("ephemeral") });

const AnthropicContentBlockSchema: z.ZodType<AnthropicContentBlock> = z.object({
    type: z.enum(["text", "image", "tool_use", "tool_result", "thinking", "redacted_thinking"]),
    text: z.string().optional(),
    thinking: z.string().optional(),
    signature: z.string().optional(),
    data: z.string().optional(),
    source: z
        .object({
            type: z.literal("base64"),
            media_type: z.string(),
            data: z.string()
        })
        .optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    tool_use_id: z.string().optional(),
    content: z.union([z.string(), z.lazy(() => z.array(AnthropicContentBlockSchema))]).optional(),
    is_error: z.boolean().optional(),
    cache_control: AnthropicCacheControlSchema.optional()
});

const AnthropicMessageSchema = z.object({
    role: z.enum(["user", "assistant", "system"]),
    content: z.union([z.string(), z.array(AnthropicContentBlockSchema).max(200)])
});

const AnthropicToolSchema = z.object({
    name: z.string().min(1).max(300),
    description: z.string().max(10_000).optional(),
    input_schema: z
        .object({
            type: z.string().optional(),
            properties: z.record(z.string(), z.unknown()).optional(),
            required: z.array(z.string()).optional()
        })
        .passthrough(),
    cache_control: AnthropicCacheControlSchema.optional()
});

const AnthropicMessageRequestSchema = z.object({
    model: z.string().min(1, "Missing required field 'model'").max(300),
    messages: z
        .array(AnthropicMessageSchema)
        .min(1, "Parameter 'messages' cannot be empty")
        .max(1000, "Parameter 'messages' exceeds the maximum of 1000 entries"),
    system: z.union([z.string(), z.array(AnthropicContentBlockSchema).max(200)]).optional(),
    max_tokens: z
        .number()
        .int()
        .positive()
        .max(1_000_000, "Parameter 'max_tokens' exceeds the gateway maximum")
        .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    stop_sequences: z.array(z.string().max(1000)).max(100).optional(),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(1).optional(),
    top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().int().positive().optional(),
    tools: z.array(AnthropicToolSchema).max(128).optional(),
    tool_choice: z
        .object({
            type: z.enum(["auto", "any", "tool"]),
            name: z.string().optional(),
            disable_parallel_tool_use: z.boolean().optional()
        })
        .optional(),
    thinking: z
        .object({
            type: z.enum(["enabled", "disabled", "adaptive"]),
            budget_tokens: z.number().int().positive().max(1_000_000).optional()
        })
        .optional()
});

// --- Anthropic error envelope (ported from apps/api utils/response.ts) ---

function anthropicErrorType(status: number): string {
    switch (status) {
        case 400:
        case 404:
        case 409:
        case 422:
            return "invalid_request_error";
        case 401:
            return "authentication_error";
        case 403:
            return "permission_error";
        case 429:
            return "rate_limit_error";
        default:
            return "api_error";
    }
}

function formatAnthropicError(message: string, status: number, type?: string) {
    return {
        type: "error",
        error: {
            type: type ?? anthropicErrorType(status),
            message
        }
    };
}

function toContentfulStatus(status: number): ContentfulStatusCode {
    return (status >= 400 && status <= 599 ? status : 500) as ContentfulStatusCode;
}

/** Mirrors the controller's catch-block status resolution. */
function resolveErrorStatus(error: unknown): number {
    const withStatus = error as { status?: unknown; statusCode?: unknown };
    const s = withStatus.status ?? withStatus.statusCode;
    if (typeof s === "number" && s >= 400 && s <= 599) return s;
    const msg = error instanceof Error ? error.message : String(error);
    return /no active provider connection|not found/i.test(msg) ? 404 : 500;
}

messagesRoutes.post("/", apiKeyAuth, rateLimit, async (c) => {
    const startedAt = Date.now();

    // Body-size guard (SRouter's BodyLimit middleware equivalent).
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (contentLength > MAX_BODY_BYTES) {
        return c.json(
            formatAnthropicError("Request body too large", 413, "invalid_request_error"),
            413
        );
    }

    const rawBody =
        (c.get("parsedBody") as unknown) ?? (await c.req.json().catch(() => null));
    if (!rawBody || typeof rawBody !== "object") {
        return c.json(formatAnthropicError("Invalid JSON request body", 400), 400);
    }

    const parsed = AnthropicMessageRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
        return c.json(
            formatAnthropicError(parsed.error.issues[0]?.message || "Validation failed", 400),
            400
        );
    }
    const body = parsed.data as AnthropicMessageRequest;

    const openAIReq = AnthropicToOpenAIRequest(body);
    const isThinkingEnabled =
        body.thinking !== undefined && body.thinking.type !== "disabled";

    const completionInput = {
        body: openAIReq,
        apiKeyRow: c.get("apiKeyRow") as ApiKeyRow | undefined,
        startedAt,
        ip: c.req.header("cf-connecting-ip") ?? null,
        userAgent: (c.req.header("user-agent") ?? "").slice(0, 255) || null
    };

    if (body.stream) {
        const sseStream = new ReadableStream<Uint8Array>({
            async start(controller) {
                const enc = new TextEncoder();
                const writeEvent = (event: string, data: string): void => {
                    controller.enqueue(enc.encode(`event: ${event}\ndata: ${data}\n\n`));
                };
                const writeErrorEvent = (message: string, status: number): void => {
                    writeEvent("error", JSON.stringify(formatAnthropicError(message, status)));
                };
                try {
                    const outcome = await executeCompletion(c.env, c.executionCtx, completionInput);
                    if (outcome.kind === "error") {
                        writeErrorEvent(outcome.message, outcome.status);
                        return;
                    }
                    if (outcome.kind !== "stream") {
                        // Unreachable: the translated request always has stream=true.
                        return;
                    }
                    const anthropicStream = OpenAIToAnthropicStream(
                        outcome.chunks,
                        body.model,
                        { allowThinking: isThinkingEnabled }
                    );
                    for await (const event of anthropicStream) {
                        writeEvent(event.type, JSON.stringify(event));
                    }
                } catch (error) {
                    const status = resolveErrorStatus(error);
                    const message =
                        error instanceof Error ? error.message : "Error occurred during streaming";
                    writeErrorEvent(message, status);
                } finally {
                    controller.close();
                }
            }
        });
        return new Response(sseStream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no"
            }
        });
    }

    try {
        const outcome = await executeCompletion(c.env, c.executionCtx, completionInput);
        if (outcome.kind === "error") {
            return c.json(
                formatAnthropicError(outcome.message, outcome.status),
                toContentfulStatus(outcome.status)
            );
        }
        if (outcome.kind !== "json") {
            // Unreachable: the translated request always has stream=false.
            return c.json(
                formatAnthropicError("Internal server error", 500),
                500
            );
        }
        const anthropicRes = OpenAIToAnthropicResponse(outcome.response, body.model, {
            allowThinking: isThinkingEnabled
        });
        return c.json(anthropicRes);
    } catch (error) {
        const status = resolveErrorStatus(error);
        const message = error instanceof Error ? error.message : "Internal server error";
        return c.json(formatAnthropicError(message, status), toContentfulStatus(status));
    }
});
