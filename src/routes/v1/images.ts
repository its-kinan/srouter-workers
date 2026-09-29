// POST /v1/images/generations — OpenAI-compatible image generation.
//
// Ported from SRouter's apps/api/src/routes/v1/images.ts +
// controllers/images.controller.ts + logic/images.logic.ts.
//
// Flow:
//   1. apiKeyAuth middleware (auth + quota checks, incl. model allow-list)
//   2. rateLimit middleware (per-key requests/minute)
//   3. Validate body; default model to "dall-e-3"
//   4. Check isImageGenerationSupported (pricing modalities)
//   5. Try fallback candidates in order (src/routing/fallback.ts); each
//      candidate resolves its accounts and tries generateImage
//   6. Log to request_logs with fallback fields; bump key usage.

import { Hono } from "hono";
import { z } from "zod";
import type { AppHonoEnv } from "../../hono-env.js";
import { apiKeyAuth, type ApiKeyRow } from "../../middleware/apiKeyAuth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import {
    accountMatchesPin,
    buildAdapter,
    candidateAccountsForPrefix,
    decryptAccountSecrets,
    loadAccountMetas,
    parseAccountPin,
    stripRoutingPrefix,
    supportsImageGeneration,
    type AccountMeta
} from "../../providers/registry.js";
import type { DecryptedAccount } from "../../providers/types.js";
import type {
    ImageGenerationRequest,
    ImageGenerationResponse
} from "../../vendor/types/index.js";
import { pricingForModel } from "../../lib/pricing-data.js";
import {
    extractStatusCode,
    runCandidateAttempts,
    type AttemptTracker
} from "../../routing/fallback.js";
import { apiError } from "../../lib/api-error.js";

export const imagesRoutes = new Hono<AppHonoEnv>();

const ImageBodySchema = z.object({
    prompt: z.string().min(1),
    model: z.string().optional(),
    image: z.union([z.string(), z.array(z.string())]).optional(),
    images: z.array(z.string()).optional(),
    mask: z.string().optional(),
    n: z.number().int().positive().optional(),
    quality: z.enum(["standard", "hd", "low", "medium", "high", "auto"]).optional(),
    response_format: z.enum(["url", "b64_json"]).optional(),
    size: z.string().optional(),
    style: z.enum(["vivid", "natural"]).optional(),
    user: z.string().optional(),
    partial_images: z.number().int().optional()
});

/**
 * Ported from @srouter/pricing isImageGenerationSupported: checks the
 * pricing dataset's modalities for image output (and image input when an
 * input image is provided).
 */
function isImageGenerationSupported(model: string, hasInputImage: boolean): boolean {
    if (!model) return false;
    const meta = pricingForModel(model);
    const output = meta?.modalities?.output;
    if (!output || !output.includes("image")) return false;
    if (hasInputImage) {
        return meta?.modalities?.input?.includes("image") ?? false;
    }
    return true;
}

function notSupportedError(model: string, hasInputImage: boolean) {
    const reason = hasInputImage
        ? `Model '${model}' does not support image editing / image-to-image input.`
        : `Model '${model}' does not support image generation. Output modalities do not include 'image'.`;
    return { reason };
}

imagesRoutes.post("/generations", apiKeyAuth, rateLimit, async (c) => {
    const env = c.env;
    const rawBody =
        (c.get("parsedBody") as unknown) ?? (await c.req.json().catch(() => null));
    const parsed = ImageBodySchema.safeParse(rawBody);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return c.json(
            {
                error: {
                    message: `Invalid request: ${((issue?.path.join(".") || "body") + " " + (issue?.message || "")).trim()}`,
                    type: "invalid_request_error",
                    code: "invalid_payload"
                }
            },
            400
        );
    }

    const body = parsed.data;
    const model = body.model || "dall-e-3";
    const hasInputImage = Boolean(body.image || body.images);
    const startedAt = Date.now();
    const apiKeyRow = c.get("apiKeyRow") as ApiKeyRow | undefined;

    if (!isImageGenerationSupported(model, hasInputImage)) {
        const { reason } = notSupportedError(model, hasInputImage);
        return c.json(
            {
                error: {
                    message: reason,
                    type: "invalid_request_error",
                    param: "model",
                    code: "model_not_supported"
                }
            },
            400
        );
    }

    // Plaintext metadata only — secrets decrypt lazily per attempted account.
    const accounts = await loadAccountMetas(env.DB);
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

    const tracker: AttemptTracker = {
        fallbackPath: [model],
        fallbackOccurred: false,
        fallbackReason: undefined,
        lastError: null
    };

    const logImage = (
        account: AccountMeta,
        currentModel: string,
        statusCode: number
    ): void => {
        c.executionCtx.waitUntil(
            (async () => {
                try {
                    await env.DB.prepare(
                        `INSERT INTO request_logs
                         (id, api_key_id, ip_address, user_agent, provider_id, account_id, model,
                          prompt_tokens, completion_tokens, total_tokens, status_code, latency_ms,
                          estimated_cost, resolved_model, fallback_occurred, fallback_path,
                          fallback_reason, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 0, ?, ?, ?, ?, ?)`
                    )
                        .bind(
                            crypto.randomUUID(),
                            apiKeyRow?.id ?? null,
                            c.req.header("cf-connecting-ip") ?? null,
                            (c.req.header("user-agent") ?? "").slice(0, 255) || null,
                            account.providerType,
                            account.id,
                            currentModel,
                            statusCode,
                            Date.now() - startedAt,
                            currentModel,
                            tracker.fallbackOccurred ? 1 : 0,
                            tracker.fallbackOccurred ? tracker.fallbackPath.join(" -> ") : null,
                            tracker.fallbackReason ?? null,
                            Date.now()
                        )
                        .run();
                    if (apiKeyRow && statusCode === 200) {
                        await env.DB.prepare(
                            `UPDATE api_keys SET usage_tokens = usage_tokens + 1 WHERE id = ?`
                        )
                            .bind(apiKeyRow.id)
                            .run();
                    }
                } catch (err) {
                    console.error("request log write failed", err);
                }
            })()
        );
    };

    // Resolve accounts capable of image generation for a model id.
    // Supports account pinning ("provider/model#selector"): the pin restricts
    // candidates and never leaks upstream. Capability is a static provider
    // check — no adapter build (and no secret decrypt) needed to filter.
    const accountsForModel = (modelId: string): { account: AccountMeta; upstreamModel: string }[] => {
        const { model: cleanModel, pin } = parseAccountPin(modelId);
        const prefixed = candidateAccountsForPrefix(cleanModel, accounts, pin);
        if (prefixed.length > 0) {
            return prefixed
                .map((a) => ({ account: a, upstreamModel: stripRoutingPrefix(cleanModel, a) }))
                .filter(({ account }) => supportsImageGeneration(account));
        }
        if (pin && candidateAccountsForPrefix(cleanModel, accounts).length > 0) return [];
        // Bare model id: any account whose provider type supports generateImage.
        const out: { account: AccountMeta; upstreamModel: string }[] = [];
        for (const a of accounts) {
            if (pin && !accountMatchesPin(a, pin)) continue;
            if (supportsImageGeneration(a)) {
                out.push({ account: a, upstreamModel: cleanModel });
            }
        }
        return out;
    };

    for await (const attempt of runCandidateAttempts(env.DB, model, tracker)) {
        const { currentModel, isFallbackAttempt } = attempt;

        if (!isImageGenerationSupported(currentModel, hasInputImage)) {
            const { reason } = notSupportedError(currentModel, hasInputImage);
            tracker.lastError = new Error(reason);
            if (!tracker.fallbackReason) tracker.fallbackReason = reason;
            continue;
        }

        const candidates = accountsForModel(currentModel);
        if (candidates.length === 0) {
            const msg = `No provider account supports image generation for model "${currentModel}".`;
            tracker.lastError = new Error(msg);
            if (!tracker.fallbackReason) tracker.fallbackReason = msg;
            continue;
        }

        for (const { account, upstreamModel } of candidates) {
            // Secrets decrypt lazily here — one account per attempt, not all
            // rows up front.
            let fullAccount: DecryptedAccount;
            try {
                fullAccount = await decryptAccountSecrets(account, env.MASTER_KEY);
            } catch {
                console.error(`Skipping account ${account.id}: failed to decrypt secrets`);
                continue;
            }
            const adapter = buildAdapter(fullAccount);
            if (!adapter.generateImage) continue;
            const req: ImageGenerationRequest = {
                ...(body as ImageGenerationRequest),
                model: upstreamModel
            };
            try {
                const response: ImageGenerationResponse = await adapter.generateImage(req);
                if (isFallbackAttempt) {
                    tracker.fallbackOccurred = true;
                    tracker.fallbackPath.push(currentModel);
                }
                logImage(account, currentModel, 200);
                return c.json(response);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                tracker.lastError = err instanceof Error ? err : msg;
                if (!tracker.fallbackReason) tracker.fallbackReason = msg;
            }
        }
    }

    // All candidates exhausted: log the failure and rethrow the last error.
    const statusCode = extractStatusCode(tracker.lastError) ?? 500;
    const message =
        tracker.lastError instanceof Error
            ? tracker.lastError.message
            : String(tracker.lastError ?? "Failed to generate image");

    // Best-effort failure log (no specific account to attribute).
    c.executionCtx.waitUntil(
        (async () => {
            try {
                await env.DB.prepare(
                    `INSERT INTO request_logs
                     (id, api_key_id, ip_address, user_agent, provider_id, account_id, model,
                      prompt_tokens, completion_tokens, total_tokens, status_code, latency_ms,
                      estimated_cost, resolved_model, fallback_occurred, fallback_path,
                      fallback_reason, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 0, ?, ?, ?, ?, ?)`
                )
                    .bind(
                        crypto.randomUUID(),
                        apiKeyRow?.id ?? null,
                        c.req.header("cf-connecting-ip") ?? null,
                        (c.req.header("user-agent") ?? "").slice(0, 255) || null,
                        "images",
                        null,
                        model,
                        statusCode,
                        Date.now() - startedAt,
                        model,
                        tracker.fallbackOccurred ? 1 : 0,
                        tracker.fallbackOccurred ? tracker.fallbackPath.join(" -> ") : null,
                        tracker.fallbackReason ?? null,
                        Date.now()
                    )
                    .run();
            } catch {
                // logging must never fail the request
            }
        })()
    );

    return apiError(
        c,
        (statusCode >= 400 && statusCode < 600 ? statusCode : 500) as
            | 400
            | 401
            | 402
            | 403
            | 404
            | 409
            | 422
            | 429
            | 500
            | 501,
        message,
        "image_generation_failed"
    );
});
