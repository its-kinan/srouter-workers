// GET /v1/models — aggregated OpenAI-compatible model list.
// Served from the RouterState DO cache (5-min TTL), refreshed on demand from
// each account's listModels(). Same auth as chat.

import { Hono } from "hono";
import type { AppHonoEnv } from "../hono-env.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { listAllModels, loadAccounts } from "../providers/registry.js";

export const modelsRoutes = new Hono<AppHonoEnv>();

modelsRoutes.get("/models", apiKeyAuth, async (c) => {
    const env = c.env;
    const stub = env.ROUTER_STATE.getByName("router");

    try {
        const cached = await stub.fetch(new Request("https://do/models"));
        const data = (await cached.json()) as { models: unknown[] | null };
        if (data.models) {
            return c.json({ object: "list", data: data.models });
        }
    } catch {
        // fall through to refresh
    }

    const accounts = await loadAccounts(env.DB, env.MASTER_KEY);
    const models = await listAllModels(accounts);
    stub
        .fetch(
            new Request("https://do/models", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ models })
            })
        )
        .catch(() => {});
    return c.json({ object: "list", data: models });
});
