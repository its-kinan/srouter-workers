const ZERO_PRICING = { input: 0, output: 0 };
export function getPricingForModel(_provider, _model) {
    return ZERO_PRICING;
}
export function calculateCostFromTokens(_tokens, _pricing) {
    return 0;
}
export function calculateCostBreakdownFromTokens(_tokens, _pricing) {
    return {
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheCreationCost: 0,
        totalCost: 0
    };
}
