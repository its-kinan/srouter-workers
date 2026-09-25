// Favorite models (SRouter-compatible dashboard surface). Mounted at /v1/favorites.
// Reads use ApiKeyAuth; mutations require an admin session.

import { Hono } from "hono";
import { z } from "zod";
import type { AppHonoEnv } from "../../hono-env.js";
import { apiKeyAuth } from "../../middleware/apiKeyAuth.js";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { apiError } from "../../lib/api-error.js";

export const v1FavoritesRoutes = new Hono<AppHonoEnv>();

v1FavoritesRoutes.get("/", apiKeyAuth, async (c) => {
    const rows = await c.env.DB.prepare(
        "SELECT model_id FROM favorite_models ORDER BY created_at ASC"
    ).all<{ model_id: string }>();
    return c.json({ models: (rows.results ?? []).map((r) => r.model_id) });
});

v1FavoritesRoutes.post("/", requireAdmin, async (c) => {
    const parsed = z
        .object({ model_id: z.string().min(1).max(200) })
        .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
        return apiError(c, 400, "model_id is required", "invalid_request");
    }
    // Idempotent: adding an existing favorite is a no-op.
    await c.env.DB.prepare(
        "INSERT INTO favorite_models (model_id, created_at) VALUES (?, ?) ON CONFLICT(model_id) DO NOTHING"
    )
        .bind(parsed.data.model_id, Date.now())
        .run();
    return c.json({ message: "Model added to favorites" }, 201);
});

// Model ids contain slashes (e.g. "openai/gpt-4"), so the param regex must match across them.
v1FavoritesRoutes.delete("/:modelId{.+}", requireAdmin, async (c) => {
    const modelId = c.req.param("modelId");
    const res = await c.env.DB.prepare("DELETE FROM favorite_models WHERE model_id = ?")
        .bind(modelId)
        .run();
    if ((res.meta.changes ?? 0) === 0) {
        return apiError(c, 404, "Favorite model not found", "not_found");
    }
    return c.json({ message: "Model removed from favorites" });
});
