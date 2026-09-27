import { calculateCostBreakdownFromTokens, calculateCostFromTokens, getPricingForModel } from "../pricing.js";
const EMPTY_BREAKDOWN = {
    prompt_tokens: 0,
    completion_tokens: 0,
    cached_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0
};
function ExtractNumber(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}
function ReadRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
export function ExtractUsageBreakdown(provider, usage) {
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
        return EMPTY_BREAKDOWN;
    }
    const raw_usage = ReadRecord(usage);
    const provider_key = provider?.toLowerCase() ?? "";
    const usage_metadata = ReadRecord(raw_usage.usage_metadata ?? raw_usage.usageMetadata);
    if (provider_key.includes("anthropic")) {
        const input_tokens = ExtractNumber(raw_usage.input_tokens);
        const output_tokens = ExtractNumber(raw_usage.output_tokens);
        const cached_tokens = ExtractNumber(raw_usage.cache_read_input_tokens);
        const cache_creation_tokens = ExtractNumber(raw_usage.cache_creation_input_tokens);
        const reasoning_obj = raw_usage.reasoning;
        return {
            prompt_tokens: input_tokens,
            completion_tokens: output_tokens,
            cached_tokens,
            cache_creation_tokens,
            reasoning_tokens: ExtractNumber(reasoning_obj?.reasoning_tokens),
            total_tokens: input_tokens + output_tokens
        };
    }
    const prompt_details = ReadRecord(raw_usage.prompt_tokens_details);
    const completion_details = ReadRecord(raw_usage.completion_tokens_details);
    const prompt_tokens = ExtractNumber(raw_usage.prompt_tokens ?? raw_usage.input_tokens ?? usage_metadata.promptTokenCount);
    const completion_tokens = ExtractNumber(raw_usage.completion_tokens ?? raw_usage.output_tokens ?? usage_metadata.candidatesTokenCount);
    const cached_tokens = ExtractNumber(prompt_details.cached_tokens ??
        raw_usage.cache_read_input_tokens ??
        usage_metadata.cachedContentTokenCount ??
        usage_metadata.cached_tokens);
    const cache_creation_tokens = ExtractNumber(raw_usage.cache_creation_input_tokens ?? usage_metadata.cacheCreationInputTokenCount);
    const total_tokens = ExtractNumber(raw_usage.total_tokens ?? usage_metadata.totalTokenCount);
    return {
        prompt_tokens,
        completion_tokens,
        cached_tokens,
        cache_creation_tokens,
        reasoning_tokens: ExtractNumber(completion_details.reasoning_tokens ?? raw_usage.reasoning_tokens),
        total_tokens: total_tokens || prompt_tokens + completion_tokens
    };
}
export function EstimateCostForUsage(provider, model, breakdown) {
    const pricing = getPricingForModel(provider, model);
    return calculateCostFromTokens({
        prompt_tokens: breakdown.prompt_tokens,
        completion_tokens: breakdown.completion_tokens,
        cached_tokens: breakdown.cached_tokens,
        cache_creation_input_tokens: breakdown.cache_creation_tokens,
        reasoning_tokens: breakdown.reasoning_tokens
    }, pricing);
}
export function EstimateCostBreakdownForUsage(provider, model, breakdown) {
    const pricing = getPricingForModel(provider, model);
    return calculateCostBreakdownFromTokens({
        prompt_tokens: breakdown.prompt_tokens,
        completion_tokens: breakdown.completion_tokens,
        cached_tokens: breakdown.cached_tokens,
        cache_creation_input_tokens: breakdown.cache_creation_tokens,
        reasoning_tokens: breakdown.reasoning_tokens
    }, pricing);
}
export const extractUsageBreakdown = ExtractUsageBreakdown;
export const estimateCostForUsage = EstimateCostForUsage;
export const estimateCostBreakdownForUsage = EstimateCostBreakdownForUsage;
