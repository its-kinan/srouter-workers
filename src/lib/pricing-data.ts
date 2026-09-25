// Pricing dataset helpers (models.dev snapshot, see src/lib/pricing-data.json).
// Used for log cost enrichment (costBreakdown) and GET /v1/pricing/models.

import pricingRaw from "./pricing-data.json" with { type: "json" };

export interface ModelPricing {
    id: string;
    name: string;
    description?: string;
    family?: string;
    attachment?: boolean;
    reasoning?: boolean;
    tool_call?: boolean;
    temperature?: boolean;
    structured_output?: boolean;
    open_weights?: boolean;
    knowledge?: string;
    release_date?: string;
    last_updated?: string;
    cost?: {
        input?: number;
        output?: number;
        cache_read?: number;
        cache_write?: number;
        reasoning?: number;
        input_audio?: number;
        output_audio?: number;
    };
    limit?: { context?: number; output?: number };
    modalities?: { input?: string[]; output?: string[] };
}

const PRICING: Record<string, ModelPricing> = pricingRaw as Record<string, ModelPricing>;

/** Find pricing for a model id. Tries exact match, then strips a "provider/" prefix. */
export function pricingForModel(modelId: string): ModelPricing | null {
    if (!modelId) return null;
    const direct = PRICING[modelId];
    if (direct) return direct;
    const slash = modelId.indexOf("/");
    if (slash > 0) {
        const stripped = PRICING[modelId.slice(slash + 1)];
        if (stripped) return stripped;
    }
    // last resort: match on the part after the final "/"
    const tail = modelId.split("/").pop()!;
    for (const key of Object.keys(PRICING)) {
        if (key === tail || key.endsWith("/" + tail)) return PRICING[key];
    }
    return null;
}

/**
 * Estimate cost in USD for token usage. Costs in the dataset are per 1M tokens.
 * Returns null when the model has no pricing data.
 */
export function estimateCost(
    modelId: string,
    promptTokens: number,
    completionTokens: number,
    cachedTokens = 0
): { inputCost: number; outputCost: number; cacheReadCost: number; totalCost: number } | null {
    const p = pricingForModel(modelId);
    const cost = p?.cost;
    if (!cost || (cost.input == null && cost.output == null)) return null;
    const inputRate = (cost.input ?? 0) / 1_000_000;
    const outputRate = (cost.output ?? 0) / 1_000_000;
    const cacheReadRate = (cost.cache_read ?? cost.input ?? 0) / 1_000_000;
    const nonCached = Math.max(0, promptTokens - cachedTokens);
    const inputCost = nonCached * inputRate;
    const cacheReadCost = cachedTokens * cacheReadRate;
    const outputCost = completionTokens * outputRate;
    return { inputCost, outputCost, cacheReadCost, totalCost: inputCost + cacheReadCost + outputCost };
}

/** All pricing entries, sorted by provider then name (matches SRouter's /v1/pricing/models). */
export function allPricing(): ModelPricing[] {
    return Object.values(PRICING).sort((a, b) => {
        const pa = providerOf(a.id);
        const pb = providerOf(b.id);
        if (pa !== pb) return pa.localeCompare(pb);
        return (a.name || a.id).localeCompare(b.name || b.id);
    });
}

export function providerOf(modelId: string): string {
    const slash = modelId.indexOf("/");
    return slash > 0 ? modelId.slice(0, slash) : "unknown";
}

export function pricingCount(): number {
    return Object.keys(PRICING).length;
}
