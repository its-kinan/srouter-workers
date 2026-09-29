// Worker environment bindings (see wrangler.toml).
export interface Env {
    /** D1 database: accounts, keys, logs, settings, admin. */
    DB: D1Database;
    /** R2 bucket: request-log archive, config snapshots (Phase 2+). */
    R2: R2Bucket;
    /** Durable Object holding router state (round-robin, circuit breaker). */
    SWITCH_STATE: DurableObjectNamespace;
    /** Static assets binding. Unused in Phase 1 (dashboard shell is inlined
        into the bundle via scripts/inline-dashboard.mjs); reserved for the
        full React dashboard in Phase 2. */
    ASSETS?: Fetcher;
    /** Base64 32-byte key for AES-GCM credential encryption. `wrangler secret put MASTER_KEY`. */
    MASTER_KEY: string;
    /** Google OAuth client secret for Antigravity token refresh. Optional Worker secret. */
    ANTIGRAVITY_OAUTH_CLIENT_SECRET?: string;
    /** Bring-your-own OAuth client overrides. When set, these take precedence over the
        hardcoded SRouter client IDs and the origin-derived callback URI, so the user can
        register their own OAuth app (e.g. in Google Cloud Console) with the Worker callback
        URL `https://<worker>/v1/auth/<provider>/callback`. All optional Worker secrets/vars. */
    ANTIGRAVITY_OAUTH_CLIENT_ID?: string;
    ANTIGRAVITY_OAUTH_REDIRECT_URI?: string;
    CLAUDE_OAUTH_CLIENT_ID?: string;
    CLAUDE_OAUTH_REDIRECT_URI?: string;
    CODEX_OAUTH_CLIENT_ID?: string;
    CODEX_OAUTH_REDIRECT_URI?: string;
    /** Comma-separated list of allowed CORS origins (loopback always allowed). */
    SROUTER_CORS_ORIGINS?: string;
    /**
     * Request-logging mode for the `request_logs` table:
     * - SROUTER_DISABLE_REQUEST_LOGS=1 → no request_logs writes at all.
     * - SROUTER_LOG_ALL_REQUESTS=1 → log every completed request (success + errors).
     * - Default (neither set) → log terminal errors only (4xx/5xx), skip successes.
     * The table holds metadata only (token counts, latency, model, status,
     * cost estimate) — never prompt/response content. The /v1/logs/*
     * dashboard endpoints keep working regardless. Usage accounting for
     * virtual keys is unaffected (batched separately via the SwitchState DO).
     */
    SROUTER_DISABLE_REQUEST_LOGS?: string;
    /** Set to "1" to restore full request logging (successes + errors). */
    SROUTER_LOG_ALL_REQUESTS?: string;
    /**
     * Retention for `request_logs` rows, in days. The cron prunes rows older
     * than this once a day. Default 30. Non-numeric/empty values fall back
     * to the default; <= 0 disables pruning.
     */
    SROUTER_LOG_RETENTION_DAYS?: string;
    /**
     * Max upstream attempts per model candidate in the chat-completions
     * failover loop. Bounds worst-case subrequest burn when many accounts
     * are dead (Cloudflare kills the invocation at ~50 subrequests).
     * Default 10. Missing, non-numeric, or <= 0 values fall back to the
     * default. Cooldown-filtered candidates don't count — only real
     * upstream attempts.
     */
    SROUTER_MAX_ATTEMPTS?: string;
    /**
     * Delayed hedging for time-to-first-byte, in ms. When the fastest
     * candidate account produces no first response byte within this delay,
     * a second attempt fires at the next-fastest candidate; whichever
     * yields first byte wins and the loser is abandoned. Default 2000.
     * 0 or negative disables hedging. Never hedges pinned (single-account)
     * requests. Each hedged attempt counts against SROUTER_MAX_ATTEMPTS.
     */
    SROUTER_HEDGE_DELAY_MS?: string;
    /** Web search API keys for server-side search tool interception. Optional Worker secrets. */
    BRAVE_API_KEY?: string;
    TAVILY_API_KEY?: string;
    SERPER_API_KEY?: string;
    /** Self-hosted SearXNG instance URL for web search. Optional Worker secret. */
    SEARXNG_URL?: string;
    /** App environment label, e.g. "production". */
    ENVIRONMENT?: string;
    /** Optional JSON for operator-level stealth header overrides.
     * Shape: { "<providerType>": { "Header": "value" }, ... } or flat
     * { "Header": "value" } applied to all providers. Never logged. */
    STEALTH_HEADER_OVERRIDES?: string;
}
