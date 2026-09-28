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
import { apiKeyAuth } from "../../middleware/apiKeyAuth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { accountMatchesPin, buildAdapter, candidateAccountsForPrefix, loadAccounts, parseAccountPin, stripRoutingPrefix } from "../../providers/registry.js";
import { pricingForModel } from "../../lib/pricing-data.js";
import { extractStatusCode, runCandidateAttempts } from "../../routing/fallback.js";
import { apiError } from "../../lib/api-error.js";
export const imagesRoutes = new Hono();
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
function isImageGenerationSupported(model, hasInputImage) {
    if (!model)
        return false;
    const meta = pricingForModel(model);
    const output = meta?.modalities?.output;
    if (!output || !output.includes("image"))
        return false;
    if (hasInputImage) {
        return meta?.modalities?.input?.includes("image") ?? false;
    }
    return true;
}
function notSupportedError(model, hasInputImage) {
    const reason = hasInputImage
        ? `Model '${model}' does not support image editing / image-to-image input.`
        : `Model '${model}' does not support image generation. Output modalities do not include 'image'.`;
    return { reason };
}
imagesRoutes.post("/generations", apiKeyAuth, rateLimit, async (c) => {
    const env = c.env;
    const rawBody = c.get("parsedBody") ?? (await c.req.json().catch(() => null));
    const parsed = ImageBodySchema.safeParse(rawBody);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return c.json({
            error: {
                message: `Invalid request: ${((issue?.path.join(".") || "body") + " " + (issue?.message || "")).trim()}`,
                type: "invalid_request_error",
                code: "invalid_payload"
            }
        }, 400);
    }
    const body = parsed.data;
    const model = body.model || "dall-e-3";
    const hasInputImage = Boolean(body.image || body.images);
    const startedAt = Date.now();
    const apiKeyRow = c.get("apiKeyRow");
    if (!isImageGenerationSupported(model, hasInputImage)) {
        const { reason } = notSupportedError(model, hasInputImage);
        return c.json({
            error: {
                message: reason,
                type: "invalid_request_error",
                param: "model",
                code: "model_not_supported"
            }
        }, 400);
    }
    const accounts = await loadAccounts(env.DB, env.MASTER_KEY);
    if (accounts.length === 0) {
        return c.json({
            error: {
                message: "No enabled provider accounts configured.",
                type: "server_error",
                code: "no_providers"
            }
        }, 503);
    }
    const tracker = {
        fallbackPath: [model],
        fallbackOccurred: false,
        fallbackReason: undefined,
        lastError: null
    };
    const logImage = (account, currentModel, statusCode) => {
        c.executionCtx.waitUntil((async () => {
            try {
                await env.DB.prepare(`INSERT INTO request_logs
                         (id, api_key_id, ip_address, user_agent, provider_id, account_id, model,
                          prompt_tokens, completion_tokens, total_tokens, status_code, latency_ms,
                          estimated_cost, resolved_model, fallback_occurred, fallback_path,
                          fallback_reason, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 0, ?, ?, ?, ?, ?)`)
                    .bind(crypto.randomUUID(), apiKeyRow?.id ?? null, c.req.header("cf-connecting-ip") ?? null, (c.req.header("user-agent") ?? "").slice(0, 255) || null, account.providerType, account.id, currentModel, statusCode, Date.now() - startedAt, currentModel, tracker.fallbackOccurred ? 1 : 0, tracker.fallbackOccurred ? tracker.fallbackPath.join(" -> ") : null, tracker.fallbackReason ?? null, Date.now())
                    .run();
                if (apiKeyRow && statusCode === 200) {
                    await env.DB.prepare(`UPDATE api_keys SET usage_tokens = usage_tokens + 1 WHERE id = ?`)
                        .bind(apiKeyRow.id)
                        .run();
                }
            }
            catch (err) {
                console.error("request log write failed", err);
            }
        })());
    };
    // Resolve accounts capable of image generation for a model id.
    // Supports account pinning ("provider/model#selector"): the pin restricts
    // candidates and never leaks upstream.
    const accountsForModel = (modelId) => {
        const { model: cleanModel, pin } = parseAccountPin(modelId);
        const prefixed = candidateAccountsForPrefix(cleanModel, accounts, pin);
        if (prefixed.length > 0) {
            return prefixed
                .map((a) => ({ account: a, upstreamModel: stripRoutingPrefix(cleanModel, a) }))
                .filter(({ account }) => buildAdapter(account).generateImage !== undefined);
        }
        if (pin && candidateAccountsForPrefix(cleanModel, accounts).length > 0)
            return [];
        // Bare model id: any account whose adapter supports generateImage.
        const out = [];
        for (const a of accounts) {
            if (pin && !accountMatchesPin(a, pin))
                continue;
            if (buildAdapter(a).generateImage !== undefined) {
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
            if (!tracker.fallbackReason)
                tracker.fallbackReason = reason;
            continue;
        }
        const candidates = accountsForModel(currentModel);
        if (candidates.length === 0) {
            const msg = `No provider account supports image generation for model "${currentModel}".`;
            tracker.lastError = new Error(msg);
            if (!tracker.fallbackReason)
                tracker.fallbackReason = msg;
            continue;
        }
        for (const { account, upstreamModel } of candidates) {
            const adapter = buildAdapter(account);
            if (!adapter.generateImage)
                continue;
            const req = {
                ...body,
                model: upstreamModel
            };
            try {
                const response = await adapter.generateImage(req);
                if (isFallbackAttempt) {
                    tracker.fallbackOccurred = true;
                    tracker.fallbackPath.push(currentModel);
                }
                logImage(account, currentModel, 200);
                return c.json(response);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                tracker.lastError = err instanceof Error ? err : msg;
                if (!tracker.fallbackReason)
                    tracker.fallbackReason = msg;
            }
        }
    }
    // All candidates exhausted: log the failure and rethrow the last error.
    const statusCode = extractStatusCode(tracker.lastError) ?? 500;
    const message = tracker.lastError instanceof Error
        ? tracker.lastError.message
        : String(tracker.lastError ?? "Failed to generate image");
    // Best-effort failure log (no specific account to attribute).
    c.executionCtx.waitUntil((async () => {
        try {
            await env.DB.prepare(`INSERT INTO request_logs
                     (id, api_key_id, ip_address, user_agent, provider_id, account_id, model,
                      prompt_tokens, completion_tokens, total_tokens, status_code, latency_ms,
                      estimated_cost, resolved_model, fallback_occurred, fallback_path,
                      fallback_reason, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 0, ?, ?, ?, ?, ?)`)
                .bind(crypto.randomUUID(), apiKeyRow?.id ?? null, c.req.header("cf-connecting-ip") ?? null, (c.req.header("user-agent") ?? "").slice(0, 255) || null, "images", null, model, statusCode, Date.now() - startedAt, model, tracker.fallbackOccurred ? 1 : 0, tracker.fallbackOccurred ? tracker.fallbackPath.join(" -> ") : null, tracker.fallbackReason ?? null, Date.now())
                .run();
        }
        catch {
            // logging must never fail the request
        }
    })());
    return apiError(c, (statusCode >= 400 && statusCode < 600 ? statusCode : 500), message, "image_generation_failed");
});
