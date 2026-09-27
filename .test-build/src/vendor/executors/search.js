// Web search executor — ported from SRouter packages/executors/src/search.ts.
//
// Workers adaptations:
// - `process.env.X` replaced by explicit options (callers pass Worker secrets).
// - `Buffer.from(b64, "base64")` replaced by `atob()` (available in Workers).
function decodeBase64Url(b64) {
    try {
        // Bing wraps the target URL in a base64 "u=a1..." tracking parameter.
        // atob handles standard base64; normalize URL-safe alphabet first.
        const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
        return atob(padded);
    }
    catch {
        return null;
    }
}
function stripTags(html) {
    return html
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&nbsp;/g, " ")
        .replace(/&#183;/g, "·")
        .replace(/&#228;/g, "ä")
        .replace(/&#252;/g, "ü")
        .trim();
}
/**
 * Perform a web search across available search providers with fallback.
 * 1. Tavily / Brave / Serper / SearXNG if API keys are provided.
 * 2. Zero-config Bing HTML scraping with base64 URL resolution.
 * 3. Zero-config Wikipedia API as fallback.
 */
export async function performWebSearch(query, limit = 5, options = {}) {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
        return { query: "", results: [] };
    }
    const braveKey = options.braveApiKey;
    const tavilyKey = options.tavilyApiKey;
    const serperKey = options.serperApiKey;
    const searxngUrl = options.searxngUrl;
    // 1. Tavily API if configured
    if (tavilyKey) {
        try {
            const res = await fetch("https://api.tavily.com/search", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${tavilyKey}`
                },
                body: JSON.stringify({ query: trimmedQuery, max_results: limit }),
                signal: AbortSignal.timeout(5000)
            });
            if (res.ok) {
                const data = (await res.json());
                if (Array.isArray(data.results) && data.results.length > 0) {
                    return {
                        query: trimmedQuery,
                        source: "tavily",
                        results: data.results.slice(0, limit).map((r) => ({
                            title: r.title || "",
                            url: r.url || "",
                            snippet: r.content || ""
                        }))
                    };
                }
            }
        }
        catch {
            // Fall through to next provider
        }
    }
    // 2. Brave Search API if configured
    if (braveKey) {
        try {
            const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(trimmedQuery)}&count=${limit}`, {
                headers: {
                    Accept: "application/json",
                    "X-Subscription-Token": braveKey
                },
                signal: AbortSignal.timeout(5000)
            });
            if (res.ok) {
                const data = (await res.json());
                if (Array.isArray(data.web?.results) && data.web.results.length > 0) {
                    return {
                        query: trimmedQuery,
                        source: "brave",
                        results: data.web.results.slice(0, limit).map((r) => ({
                            title: r.title || "",
                            url: r.url || "",
                            snippet: r.description || ""
                        }))
                    };
                }
            }
        }
        catch {
            // Fall through to next provider
        }
    }
    // 3. Serper API if configured
    if (serperKey) {
        try {
            const res = await fetch("https://google.serper.dev/search", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-API-KEY": serperKey
                },
                body: JSON.stringify({ q: trimmedQuery, num: limit }),
                signal: AbortSignal.timeout(5000)
            });
            if (res.ok) {
                const data = (await res.json());
                if (Array.isArray(data.organic) && data.organic.length > 0) {
                    return {
                        query: trimmedQuery,
                        source: "serper",
                        results: data.organic.slice(0, limit).map((r) => ({
                            title: r.title || "",
                            url: r.link || "",
                            snippet: r.snippet || ""
                        }))
                    };
                }
            }
        }
        catch {
            // Fall through to next provider
        }
    }
    // 4. SearXNG if configured
    if (searxngUrl) {
        try {
            const res = await fetch(`${searxngUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(trimmedQuery)}&format=json`, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                },
                signal: AbortSignal.timeout(5000)
            });
            if (res.ok) {
                const data = (await res.json());
                if (Array.isArray(data.results) && data.results.length > 0) {
                    return {
                        query: trimmedQuery,
                        source: "searxng",
                        results: data.results.slice(0, limit).map((r) => ({
                            title: r.title || "",
                            url: r.url || "",
                            snippet: r.content || ""
                        }))
                    };
                }
            }
        }
        catch {
            // Fall through to next provider
        }
    }
    // 5. Zero-config Bing Web Scraper (fast, reliable, global)
    try {
        const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(trimmedQuery)}`, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept-Language": "en-US,en;q=0.9"
            },
            signal: AbortSignal.timeout(5000)
        });
        if (res.ok) {
            const html = await res.text();
            const results = [];
            const liMatches = [...html.matchAll(/<li class="b_algo"[^>]*>(.*?)<\/li>/gs)];
            for (const match of liMatches.slice(0, limit)) {
                const liContent = match[1];
                const aMatch = liContent.match(/<h2[^>]*>\s*<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/s);
                const pMatch = liContent.match(/<p[^>]*>(.*?)<\/p>/s);
                if (aMatch) {
                    let url = aMatch[1].replace(/&amp;/g, "&");
                    const title = stripTags(aMatch[2]);
                    const snippet = pMatch ? stripTags(pMatch[1]) : "";
                    // Decode Bing tracking base64 parameter u=a1...
                    const uParam = url.match(/[?&]u=a1([^&]+)/);
                    if (uParam) {
                        const decoded = decodeBase64Url(uParam[1]);
                        if (decoded)
                            url = decoded;
                    }
                    results.push({ title, url, snippet });
                }
            }
            if (results.length > 0) {
                return {
                    query: trimmedQuery,
                    source: "bing",
                    results
                };
            }
        }
    }
    catch {
        // Fall through to Wikipedia
    }
    // 6. Zero-config Wikipedia API fallback
    try {
        const wikiRes = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(trimmedQuery)}&format=json`, {
            headers: { "User-Agent": "SRouter/1.0" },
            signal: AbortSignal.timeout(4000)
        });
        if (wikiRes.ok) {
            const data = (await wikiRes.json());
            const searchList = data.query?.search || [];
            if (searchList.length > 0) {
                return {
                    query: trimmedQuery,
                    source: "wikipedia",
                    results: searchList.slice(0, limit).map((item) => ({
                        title: item.title || "",
                        url: `https://en.wikipedia.org/wiki/${encodeURIComponent((item.title || "").replace(/ /g, "_"))}`,
                        snippet: stripTags(item.snippet || "")
                    }))
                };
            }
        }
    }
    catch {
        // All providers failed
    }
    return {
        query: trimmedQuery,
        results: []
    };
}
