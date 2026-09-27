// Database export/import (mounted at /v1/admin/database).
//
// The original transfers the raw SQLite file (VACUUM INTO snapshot + whole-file
// replace via node:fs). That cannot work on Workers; D1 backups / R2 snapshots
// are the replacement. Both endpoints return 400 unsupported_storage, matching
// the original's error code for non-SQLite backends.

import { Hono } from "hono";
import type { AppHonoEnv } from "../../hono-env.js";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { apiError } from "../../lib/api-error.js";

export const databaseRoutes = new Hono<AppHonoEnv>();

const UNSUPPORTED =
    "Database transfer is not supported on the Cloudflare Workers port (SQLite file operations). Use D1 backups / R2 snapshots instead.";

databaseRoutes.get("/export", requireAdmin, (c) =>
    apiError(c, 400, UNSUPPORTED, "unsupported_storage")
);
databaseRoutes.post("/import", requireAdmin, (c) =>
    apiError(c, 400, UNSUPPORTED, "unsupported_storage")
);
