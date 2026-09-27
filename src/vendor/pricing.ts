// Pricing stub for Phase 1. The full per-model pricing tables
// (packages/pricing + pricing.jsonc in SRouter) move to D1/R2 in a later phase.
// Signatures mirror @srouter/pricing so vendored translator code compiles;
// costs record 0 until real tables land. Token usage is still logged.
import type { JSONValue } from "./types/index.js";

export interface ModelPrice {
    id?: string;
    name?: string;
    input: number;
    output: number;
    cached?: number;
    reasoning?: number;
    cache_creation?: number;
}

export interface TokenCounts {
    prompt_tokens?: number;
    input_tokens?: number;
    completion_tokens?: number;
    output_tokens?: number;
    cached_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    reasoning_tokens?: number;
}

const ZERO_PRICING: ModelPrice = { input: 0, output: 0 };

export function getPricingForModel(
    _provider: string | undefined,
    _model: string
): ModelPrice {
    return ZERO_PRICING;
}

export function calculateCostFromTokens(
    _tokens: TokenCounts,
    _pricing: ModelPrice
): number {
    return 0;
}

export function calculateCostBreakdownFromTokens(
    _tokens: TokenCounts,
    _pricing: ModelPrice
): {
    inputCost: number;
    outputCost: number;
    cacheReadCost: number;
    cacheCreationCost: number;
    totalCost: number;
} {
    return {
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheCreationCost: 0,
        totalCost: 0
    };
}

// Re-export kept for API compatibility with translator/usage.ts consumers.
export type { JSONValue };
