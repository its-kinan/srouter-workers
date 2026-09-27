// GET /v1/pricing/models — models.dev pricing dataset (Phase 2).
// Mounted at /v1/pricing by src/index.ts. Data is bundled at build time
// (src/lib/pricing-data.json); no database involved, like SRouter.

import { Hono } from "hono";
import type { AppHonoEnv } from "../../hono-env.js";
import { apiKeyAuth } from "../../middleware/apiKeyAuth.js";
import { allPricing } from "../../lib/pricing-data.js";

export const pricingRoutes = new Hono<AppHonoEnv>();

pricingRoutes.get("/models", apiKeyAuth, async (c) => {
    const data = allPricing();
    c.header("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
    return c.json({
        object: "list",
        total: data.length,
        updated_at: new Date().toISOString(),
        data
    });
});
