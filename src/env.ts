// Worker environment bindings (see wrangler.toml).
export interface Env {
    /** D1 database: accounts, keys, logs, settings, admin. */
    DB: D1Database;
    /** R2 bucket: request-log archive, config snapshots (Phase 2+). */
    R2: R2Bucket;
    /** Durable Object holding router state (round-robin, circuit breaker). */
    ROUTER_STATE: DurableObjectNamespace;
    /** Static assets binding. Unused in Phase 1 (dashboard shell is inlined
        into the bundle via scripts/inline-dashboard.mjs); reserved for the
        full React dashboard in Phase 2. */
    ASSETS?: Fetcher;
    /** Base64 32-byte key for AES-GCM credential encryption. `wrangler secret put MASTER_KEY`. */
    MASTER_KEY: string;
    /** Google OAuth client secret for Antigravity token refresh. Optional Worker secret. */
    ANTIGRAVITY_OAUTH_CLIENT_SECRET?: string;
    /** App environment label, e.g. "production". */
    ENVIRONMENT?: string;
}
