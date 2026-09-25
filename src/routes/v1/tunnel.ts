// Cloudflare Tunnel management (mounted at /v1/tunnel).
//
// The original SRouter spawns and supervises a `cloudflared` subprocess.
// A Worker is already publicly reachable, so tunnel lifecycle management is
// meaningless here: GET /status returns the static "not running" shape the
// dashboard renders, and every other endpoint returns 501.

import { Hono } from "hono";
import type { AppHonoEnv } from "../../hono-env.js";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { apiError } from "../../lib/api-error.js";

export const tunnelRoutes = new Hono<AppHonoEnv>();

const TUNNEL_UNAVAILABLE =
    "Cloudflare Tunnel management is not available on the Workers port \u2014 the Worker is already publicly reachable.";

tunnelRoutes.get("/status", requireAdmin, (c) =>
    c.json({
        running: false,
        startedAt: null,
        error: null,
        domain: null,
        desired: false,
        restartAttempts: 0,
        maxRestartAttempts: 0,
        autostart: false,
        mode: "quick",
        tokenConfigured: false
    })
);

tunnelRoutes.get("/events", requireAdmin, (c) =>
    apiError(c, 501, TUNNEL_UNAVAILABLE, "tunnel_not_supported")
);
tunnelRoutes.post("/start", requireAdmin, (c) =>
    apiError(c, 501, TUNNEL_UNAVAILABLE, "tunnel_not_supported")
);
tunnelRoutes.post("/stop", requireAdmin, (c) =>
    apiError(c, 501, TUNNEL_UNAVAILABLE, "tunnel_not_supported")
);
tunnelRoutes.post("/install", requireAdmin, (c) =>
    apiError(c, 501, TUNNEL_UNAVAILABLE, "tunnel_not_supported")
);
tunnelRoutes.put("/config", requireAdmin, (c) =>
    apiError(c, 501, TUNNEL_UNAVAILABLE, "tunnel_not_supported")
);
