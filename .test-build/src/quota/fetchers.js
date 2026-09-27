// Live OAuth quota fetchers, ported 1:1 from @srouter/providers (quota/).
// Antigravity, CodeBuddy CN, OpenAI Codex fetch live quota from their upstreams.
// Other providers fall back to usage_logged.
export function formatResetIn(resetTimeStr) {
    if (!resetTimeStr)
        return "24h 0m";
    const resetTime = new Date(resetTimeStr).getTime();
    const now = Date.now();
    const diffMs = resetTime - now;
    if (diffMs <= 0)
        return "0m";
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    if (days > 0)
        return `${days}d ${hours - days * 24}h`;
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 0)
        return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}
function createQuotaItem(name, fraction, resetTime) {
    const percentageValue = Math.round(fraction * 100);
    const limit = 1000;
    const used = Math.round((1 - fraction) * limit);
    const resetIn = formatResetIn(resetTime);
    let status = "ok";
    if (percentageValue <= 5)
        status = "exhausted";
    else if (percentageValue <= 20)
        status = "warning";
    return { name, used, limit, percentage: `${percentageValue}%`, percentageValue, resetIn, resetTime, status };
}
async function fetchAntigravityQuota(ctx) {
    const accessToken = ctx.accessToken || "";
    if (!accessToken || !(accessToken.startsWith("ya29.") || accessToken.length > 20)) {
        throw new Error("Antigravity quota requires a valid access token");
    }
    const res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": "Antigravity/1.0 (VSCode)",
            "x-goog-api-client": "gl-node/18.0.0 gd/1.0.0"
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15000)
    });
    if (!res.ok)
        throw new Error(`Antigravity quota fetch failed: HTTP ${res.status}`);
    const data = (await res.json());
    if (!data.models || Object.keys(data.models).length === 0) {
        throw new Error("Antigravity quota fetch returned no models");
    }
    let geminiMinRemaining = 1.0;
    let geminiResetTime;
    let geminiHasModel = false;
    let otherMinRemaining = 1.0;
    let otherResetTime;
    let otherHasModel = false;
    for (const [modelId, item] of Object.entries(data.models)) {
        const rawName = (item.displayName || modelId).toLowerCase();
        if (rawName.startsWith("tab_") || rawName.startsWith("chat_"))
            continue;
        const rem = item.quotaInfo?.remainingFraction ?? 1.0;
        const rTime = item.quotaInfo?.resetTime;
        if (rawName.includes("gemini")) {
            geminiHasModel = true;
            if (rem < geminiMinRemaining)
                geminiMinRemaining = rem;
            if (rTime && (!geminiResetTime || new Date(rTime) > new Date(geminiResetTime)))
                geminiResetTime = rTime;
        }
        else if (rawName.includes("claude") || rawName.includes("gpt")) {
            otherHasModel = true;
            if (rem < otherMinRemaining)
                otherMinRemaining = rem;
            if (rTime && (!otherResetTime || new Date(rTime) > new Date(otherResetTime)))
                otherResetTime = rTime;
        }
    }
    const quotas = [];
    if (geminiHasModel)
        quotas.push(createQuotaItem("Quota Gemini", geminiMinRemaining, geminiResetTime));
    if (otherHasModel)
        quotas.push(createQuotaItem("Quota Other (Claude & GPT)", otherMinRemaining, otherResetTime));
    if (quotas.length === 0) {
        for (const [modelId, item] of Object.entries(data.models)) {
            quotas.push(createQuotaItem(item.displayName || modelId, item.quotaInfo?.remainingFraction ?? 1.0, item.quotaInfo?.resetTime));
        }
    }
    return {
        id: ctx.id, provider: "Antigravity", account: ctx.name || "Antigravity Account",
        enabled: ctx.enabled, quotaType: "live_provider_quota",
        totalQuotas: quotas.length, quotas
    };
}
function parseNum(precise, plain) {
    if (precise !== undefined && precise !== null && precise !== "") {
        const parsed = Number(precise);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return plain !== undefined && plain !== null && Number.isFinite(plain) ? plain : 0;
}
async function fetchCodeBuddyCNQuota(ctx) {
    const accessToken = ctx.accessToken || "";
    if (!accessToken)
        throw new Error("CodeBuddy CN quota requires an access token");
    const res = await fetch("https://copilot.tencent.com/v2/billing/meter/get-user-resource", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": "CodeBuddy/1.0",
            "X-Product": "SaaS",
            "X-IDE-Type": "CLI",
            "X-IDE-Name": "CLI",
            "x-requested-with": "XMLHttpRequest",
            "x-codebuddy-request": "1"
        },
        body: "{}",
        signal: AbortSignal.timeout(15000)
    });
    if (!res.ok)
        throw new Error(`CodeBuddy CN quota fetch failed: HTTP ${res.status}`);
    const json = (await res.json());
    if (json.code !== 0)
        throw new Error(`CodeBuddy CN quota error: ${json.msg || "unknown"}`);
    const accounts = json.data?.Response?.Data?.Accounts ?? [];
    if (accounts.length === 0)
        throw new Error("CodeBuddy CN quota fetch returned no credit packages");
    const quotas = accounts.map((acc) => {
        const size = parseNum(acc.CycleCapacitySizePrecise, acc.CycleCapacitySize) || parseNum(acc.CapacitySizePrecise, acc.CapacitySize) || 1;
        const used = parseNum(acc.CycleCapacityUsedPrecise, acc.CycleCapacityUsed) || parseNum(acc.CapacityUsedPrecise, acc.CapacityUsed);
        const fraction = Math.max(0, Math.min(1, 1 - used / size));
        const name = acc.PackageName || acc.SubProductName || "CodeBuddy Package";
        return createQuotaItem(name, fraction, acc.CycleEndTime);
    });
    return {
        id: ctx.id, provider: "CodeBuddy CN", account: ctx.name || "CodeBuddy CN Account",
        enabled: ctx.enabled, quotaType: "live_provider_quota",
        totalQuotas: quotas.length, quotas
    };
}
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function readNumber(r, ...keys) {
    for (const k of keys) {
        const v = r[k];
        if (typeof v === "number" && Number.isFinite(v))
            return v;
        if (typeof v === "string" && v.trim() !== "") {
            const p = Number(v);
            if (Number.isFinite(p))
                return p;
        }
    }
    return undefined;
}
function readWindow(value, name) {
    if (!isRecord(value))
        return undefined;
    const usedPercent = readNumber(value, "used_percent", "usedPercent");
    if (usedPercent === undefined)
        return undefined;
    const resetAt = readNumber(value, "reset_at", "resets_at", "resetAt", "resetsAt");
    const durationSeconds = readNumber(value, "limit_window_seconds", "limitWindowSeconds", "window_duration_seconds", "windowDurationSeconds") ?? (() => {
        const m = readNumber(value, "window_minutes", "window_duration_mins", "windowDurationMins");
        return m === undefined ? undefined : m * 60;
    })();
    return { usedPercent: Math.max(0, Math.min(100, usedPercent)), resetAt, durationSeconds, name };
}
function getWindowLabel(w) {
    if (w.durationSeconds === undefined || w.durationSeconds <= 0)
        return w.name;
    const hours = w.durationSeconds / 3600;
    if (hours >= 4 && hours <= 6)
        return "5-hour";
    const days = w.durationSeconds / 86400;
    if (days >= 6 && days <= 8)
        return "Weekly";
    if (days >= 27 && days <= 31)
        return "Monthly";
    if (days >= 1 && Number.isInteger(days))
        return `${days}-day`;
    if (hours >= 1 && Number.isInteger(hours))
        return `${hours}-hour`;
    return `${Math.max(1, Math.round(w.durationSeconds / 60))}-minute`;
}
function getWindows(payload) {
    const result = [];
    const candidates = [];
    const rl = payload.rate_limit ?? payload.rateLimits;
    if (isRecord(rl)) {
        candidates.push(["5-hour", rl.primary_window ?? rl.primary]);
        candidates.push(["Weekly", rl.secondary_window ?? rl.secondary]);
    }
    const byId = payload.rate_limits_by_limit_id ?? payload.rateLimitsByLimitId;
    if (isRecord(byId)) {
        for (const [limitId, value] of Object.entries(byId)) {
            if (!isRecord(value))
                continue;
            candidates.push([limitId, value.primary_window ?? value.primary]);
        }
    }
    for (const [name, value] of candidates) {
        const w = readWindow(value, name);
        if (w && !result.some((i) => i.name === w.name))
            result.push(w);
    }
    return result;
}
async function fetchOpenAICodexQuota(ctx) {
    const accessToken = ctx.accessToken || "";
    if (!accessToken)
        throw new Error("OpenAI Codex quota requires an access token");
    const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
            "User-Agent": "codex_cli_rs/0.136.0",
            originator: "codex_cli_rs",
            ...(ctx.accountId ? { "ChatGPT-Account-ID": ctx.accountId } : {})
        },
        signal: AbortSignal.timeout(15000)
    });
    if (!res.ok)
        throw new Error(`OpenAI Codex quota fetch failed: HTTP ${res.status}`);
    const payload = await res.json();
    if (!isRecord(payload))
        throw new Error("OpenAI Codex quota returned an invalid response");
    const windows = getWindows(payload);
    if (windows.length === 0)
        throw new Error("OpenAI Codex quota returned no rate limits");
    const quotas = windows.map((w) => {
        const remaining = 100 - w.usedPercent;
        const resetTime = w.resetAt ? new Date(w.resetAt * 1000).toISOString() : undefined;
        const percentageValue = Math.round(remaining);
        let status = "ok";
        if (percentageValue <= 5)
            status = "exhausted";
        else if (percentageValue <= 20)
            status = "warning";
        return {
            name: `Codex ${getWindowLabel(w)}`,
            used: Math.round(w.usedPercent), limit: 100,
            percentage: `${percentageValue}%`, percentageValue,
            resetIn: formatResetIn(resetTime), resetTime, status
        };
    });
    return {
        id: ctx.id, provider: "OpenAI Codex", account: ctx.name || "Codex Account",
        enabled: ctx.enabled, quotaType: "live_provider_quota",
        totalQuotas: quotas.length, quotas
    };
}
// ---------------------------------------------------------------------------
// Dispatcher (1:1 with original: only these three providers have live quota)
// ---------------------------------------------------------------------------
export function isLiveQuotaSupported(providerId) {
    const base = providerId.toLowerCase();
    return base === "antigravity" || base.startsWith("antigravity_") || base.startsWith("antigravity-")
        || base === "codebuddy-cn" || base.startsWith("codebuddy-cn_") || base.startsWith("codebuddy-cn-")
        || base === "openai_codex" || base.startsWith("openai_codex_") || base.startsWith("openai_codex-");
}
export async function fetchLiveQuota(ctx) {
    const base = ctx.providerId.toLowerCase();
    try {
        if (base === "antigravity" || base.startsWith("antigravity_") || base.startsWith("antigravity-")) {
            return await fetchAntigravityQuota(ctx);
        }
        if (base === "codebuddy-cn" || base.startsWith("codebuddy-cn_") || base.startsWith("codebuddy-cn-")) {
            return await fetchCodeBuddyCNQuota(ctx);
        }
        if (base === "openai_codex" || base.startsWith("openai_codex_") || base.startsWith("openai_codex-")) {
            return await fetchOpenAICodexQuota(ctx);
        }
    }
    catch {
        return null; // swallow, like the original (skip failed providers)
    }
    return null;
}
