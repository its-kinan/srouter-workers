// Pricing dataset helpers (models.dev snapshot, see src/lib/pricing-data.json).
// Used for log cost enrichment (costBreakdown) and GET /v1/pricing/models.
import pricingRaw from "./pricing-data.json" with { type: "json" };
const PRICING = pricingRaw;
/** Find pricing for a model id. Tries exact match, then strips a "provider/" prefix. */
export function pricingForModel(modelId) {
    if (!modelId)
        return null;
    const direct = PRICING[modelId];
    if (direct)
        return direct;
    const slash = modelId.indexOf("/");
    if (slash > 0) {
        const stripped = PRICING[modelId.slice(slash + 1)];
        if (stripped)
            return stripped;
    }
    // last resort: match on the part after the final "/"
    const tail = modelId.split("/").pop();
    for (const key of Object.keys(PRICING)) {
        if (key === tail || key.endsWith("/" + tail))
            return PRICING[key];
    }
    return null;
}
/**
 * Estimate cost in USD for token usage. Costs in the dataset are per 1M tokens.
 * Returns null when the model has no pricing data.
 */
export function estimateCost(modelId, promptTokens, completionTokens, cachedTokens = 0) {
    const p = pricingForModel(modelId);
    const cost = p?.cost;
    if (!cost || (cost.input == null && cost.output == null))
        return null;
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
export function allPricing() {
    return Object.values(PRICING).sort((a, b) => {
        const pa = providerOf(a.id);
        const pb = providerOf(b.id);
        if (pa !== pb)
            return pa.localeCompare(pb);
        return (a.name || a.id).localeCompare(b.name || b.id);
    });
}
export function providerOf(modelId) {
    const slash = modelId.indexOf("/");
    return slash > 0 ? modelId.slice(0, slash) : "unknown";
}
export function pricingCount() {
    return Object.keys(PRICING).length;
}
