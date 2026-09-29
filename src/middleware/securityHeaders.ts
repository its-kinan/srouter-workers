// Baseline security headers for every Worker response, plus a
// Content-Security-Policy for the dashboard HTML shell.
//
// The dashboard is a prebuilt React SPA (no source in this repo), so headers
// are the practical hardening lever: they apply to the inlined HTML shell
// (served by the notFound handler) and to all API responses. Static chunks
// are served directly by Workers Static Assets, but the page-level CSP
// delivered with the HTML document still governs them.
//
// CSP notes:
// - `script-src 'unsafe-inline'` is required by the shell's inline
//   theme-detection script (web-dist/index.html). It still blocks the
//   dangerous vectors: external script injection, plugins, framing.
// - Google Fonts are allowlisted (stylesheet + font files); everything else
//   is same-origin.

import type { Context, Next } from "hono";

export const BASELINE_HEADERS: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin"
};

export const DASHBOARD_CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'"
].join("; ");

export async function securityHeaders(c: Context, next: Next) {
    await next();
    const res = c.res;
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(BASELINE_HEADERS)) {
        if (!headers.has(k)) headers.set(k, v);
    }
    const contentType = headers.get("content-type") ?? "";
    if (contentType.includes("text/html") && !headers.has("content-security-policy")) {
        headers.set("Content-Security-Policy", DASHBOARD_CSP);
    }
    c.res = new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers
    });
}
