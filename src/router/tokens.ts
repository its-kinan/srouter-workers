// Token estimation fallback (chars/4 heuristic).
// Upstream-reported usage is preferred; this only fills gaps so quota
// accounting and request logs stay meaningful.
export function estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
}
