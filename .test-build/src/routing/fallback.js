// Fallback combo routing, ported from SRouter's apps/api/src/logic/fallbackRunner.ts
// and fallback.policy.ts.
//
// resolveCandidates(db, model): [{model: original}] + fallback targets from
// enabled fallback_rules matching the model, ordered by priority.
// shouldTriggerFallback(rule, error): whether a failed attempt should trigger
// the fallback rule, based on the rule's trigger_on_status and error matching.
function toFallbackRule(row) {
    let triggerOnStatus;
    if (row.trigger_on_status) {
        try {
            const parsed = JSON.parse(row.trigger_on_status);
            if (Array.isArray(parsed)) {
                triggerOnStatus = parsed.filter((n) => typeof n === "number");
            }
        }
        catch {
            triggerOnStatus = undefined;
        }
    }
    return {
        id: row.id,
        sourceModel: row.source_model,
        targetModel: row.target_model,
        priority: row.priority,
        enabled: row.enabled === 1,
        ...(triggerOnStatus !== undefined ? { triggerOnStatus } : {}),
        maxRetries: row.max_retries ?? 1
    };
}
export function extractStatusCode(err) {
    if (!err)
        return undefined;
    if (typeof err === "object") {
        if ("status" in err && typeof err.status === "number")
            return err.status;
        if ("statusCode" in err && typeof err.statusCode === "number")
            return err.statusCode;
    }
    const msg = typeof err === "string" ? err : err.message || String(err);
    if (/no active provider connection|not found|unknown model|invalid model|no provider found/i.test(msg)) {
        return 404;
    }
    const match = msg.match(/\b(400|401|402|403|404|408|409|422|429|500|502|503|504)\b/);
    if (match)
        return parseInt(match[1], 10);
    return undefined;
}
export function shouldTriggerFallback(rule, err) {
    if (!rule.enabled)
        return false;
    if (!rule.triggerOnStatus || rule.triggerOnStatus.length === 0)
        return true;
    const status = extractStatusCode(err);
    if (status && rule.triggerOnStatus.includes(status))
        return true;
    const msg = typeof err === "string" ? err : err ? err.message || String(err) : "";
    if (/rate\s*limit|too\s+many\s+requests|quota|exhausted|capacity|high\s+traffic|overloaded|no active provider connection|not found|unknown model|invalid model|no provider found|insufficient tokens|insufficient_quota|billing_error/i.test(msg)) {
        return true;
    }
    return status === undefined;
}
/**
 * Find enabled fallback rules matching a source model, mirroring the original's
 * findMatchingFallbackRulesDB: exact match (score 1), "prefix/*" wildcard
 * (score 2), "*" catch-all (score 3); sorted by priority then match score.
 */
export async function resolveCandidates(db, originalModel) {
    const rows = await db
        .prepare("SELECT * FROM fallback_rules WHERE enabled = 1")
        .all();
    const rules = (rows.results ?? []).map(toFallbackRule);
    const normalizedSource = originalModel.toLowerCase().trim();
    const prefix = originalModel.includes("/") ? originalModel.split("/")[0] : undefined;
    const normalizedPrefix = prefix?.toLowerCase().trim();
    const matches = [];
    for (const rule of rules) {
        const ruleSourceNormalized = rule.sourceModel.toLowerCase().trim();
        const ruleTargetNormalized = rule.targetModel.toLowerCase().trim();
        if (ruleTargetNormalized === normalizedSource)
            continue;
        if (rule.sourceModel === originalModel || ruleSourceNormalized === normalizedSource) {
            matches.push({ rule, matchScore: 1 });
        }
        else if (ruleSourceNormalized.endsWith("/*")) {
            const rulePrefix = ruleSourceNormalized.slice(0, -2);
            if (normalizedPrefix &&
                (normalizedPrefix === rulePrefix ||
                    normalizedSource.startsWith(`${rulePrefix}/`))) {
                matches.push({ rule, matchScore: 2 });
            }
        }
        else if (rule.sourceModel === "*") {
            matches.push({ rule, matchScore: 3 });
        }
    }
    matches.sort((a, b) => {
        if (a.rule.priority !== b.rule.priority)
            return a.rule.priority - b.rule.priority;
        return a.matchScore - b.matchScore;
    });
    const candidates = [{ model: originalModel }];
    const visited = new Set([normalizedSource]);
    for (const { rule } of matches) {
        const targetNormalized = rule.targetModel.toLowerCase().trim();
        if (!visited.has(targetNormalized)) {
            visited.add(targetNormalized);
            candidates.push({ model: rule.targetModel, rule });
        }
    }
    return candidates;
}
/**
 * Async generator over fallback candidates. For fallback attempts (index > 0),
 * the candidate is skipped unless shouldTriggerFallback(rule, tracker.lastError).
 * Mirrors the original's RunCandidateAttempts (minus token-refresh, which the
 * worker handles in its OAuth refresh cron).
 */
export async function* runCandidateAttempts(db, originalModel, tracker) {
    const candidates = await resolveCandidates(db, originalModel);
    for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        if (!candidate)
            continue;
        const isFallbackAttempt = index > 0;
        if (isFallbackAttempt && candidate.rule && tracker.lastError) {
            if (!shouldTriggerFallback(candidate.rule, tracker.lastError))
                continue;
        }
        yield { candidate, currentModel: candidate.model, isFallbackAttempt };
    }
}
