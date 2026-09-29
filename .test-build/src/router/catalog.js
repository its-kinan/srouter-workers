// Model catalog with stale-while-revalidate + single-flight rebuilds.
//
// Previously, every RouterState model-cache miss (5-min TTL) made the
// request path fan out listModels() to ALL ~342 accounts inline — a cache
// stampede under load (342 subrequests x N concurrent requests). Now:
//   - the cron rebuilds the catalog when stale (single-flighted via the
//     existing DO refresh-lock);
//   - requests serve stale catalog data while a background rebuild runs;
//   - the request path NEVER fans out to upstreams, except for a true cold
//     start (single-flighted: one builder, the rest wait briefly).
import { MODEL_CACHE_TTL_MS, ROUTER_GLOBAL_NAME } from "./durable.js";
import { listAllModels, loadAccounts } from "../providers/registry.js";
/** DO refresh-lock id guarding catalog rebuilds (reuses /refresh/try). */
const CATALOG_BUILD_LOCK_ID = "__model_catalog__";
const CATALOG_BUILD_LOCK_TTL_MS = 120_000;
/** How long losers wait for an in-flight cold-start build. */
const COLD_START_WAIT_MS = 1_000;
function globalStub(env) {
    return env.ROUTER_STATE.getByName(ROUTER_GLOBAL_NAME);
}
async function readCatalog(env) {
    try {
        const res = await globalStub(env).fetch(new Request("https://do/models"));
        const data = (await res.json());
        return {
            models: Array.isArray(data.models) ? data.models : null,
            cachedAt: typeof data.cachedAt === "number" ? data.cachedAt : null
        };
    }
    catch {
        return { models: null, cachedAt: null };
    }
}
async function tryAcquireBuildLock(env) {
    try {
        const res = await globalStub(env).fetch(new Request("https://do/refresh/try", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                accountId: CATALOG_BUILD_LOCK_ID,
                ttlMs: CATALOG_BUILD_LOCK_TTL_MS
            })
        }));
        return (await res.json()).acquired === true;
    }
    catch {
        return false;
    }
}
/**
 * Rebuild the aggregated catalog from all accounts and publish it to the DO.
 * Single-flighted: concurrent callers (requests, cron) collapse onto one
 * builder via the DO refresh-lock.
 */
export async function rebuildModelCatalog(env) {
    if (!(await tryAcquireBuildLock(env)))
        return;
    try {
        const accounts = await loadAccounts(env.DB, env.MASTER_KEY);
        const models = await listAllModels(accounts);
        // Never cache an empty aggregation — a poisoned/empty cache would
        // make every bare-model lookup 404 until the next rebuild.
        if (models.length === 0)
            return;
        await globalStub(env).fetch(new Request("https://do/models", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ models })
        }));
    }
    catch (err) {
        console.error("model catalog rebuild failed:", err instanceof Error ? err.message : err);
    }
}
/** Cron entrypoint: rebuild only when the cached catalog is stale/missing. */
export async function refreshCatalogIfStale(env) {
    const { models, cachedAt } = await readCatalog(env);
    if (models &&
        models.length > 0 &&
        cachedAt !== null &&
        Date.now() - cachedAt < MODEL_CACHE_TTL_MS) {
        return;
    }
    await rebuildModelCatalog(env);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Stale-while-revalidate catalog read for the request path.
 *
 * - Fresh cache → returned immediately (no upstream fan-out, no writes).
 * - Stale cache → returned immediately + background rebuild via waitUntil.
 * - Cold start (never built) → single-flight inline build; the lock winner
 *   builds, losers wait up to COLD_START_WAIT_MS, then get null (404).
 */
export async function getModelCatalog(env, executionCtx) {
    const { models, cachedAt } = await readCatalog(env);
    const fresh = models !== null &&
        models.length > 0 &&
        cachedAt !== null &&
        Date.now() - cachedAt < MODEL_CACHE_TTL_MS;
    if (fresh)
        return models;
    if (models === null || models.length === 0) {
        // Cold start: no data at all. Single-flight one inline build so the
        // first bare-model requests still resolve instead of 404ing.
        if (await tryAcquireBuildLock(env)) {
            try {
                const accounts = await loadAccounts(env.DB, env.MASTER_KEY);
                const built = await listAllModels(accounts);
                if (built.length > 0) {
                    await globalStub(env).fetch(new Request("https://do/models", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ models: built })
                    }));
                    return built;
                }
            }
            catch (err) {
                console.error("cold model catalog build failed:", err instanceof Error ? err.message : err);
            }
            return null;
        }
        // Someone else is building: wait briefly, then fall through to null.
        const deadline = Date.now() + COLD_START_WAIT_MS;
        while (Date.now() < deadline) {
            await sleep(250);
            const retry = await readCatalog(env);
            if (retry.models && retry.models.length > 0)
                return retry.models;
        }
        return null;
    }
    // Stale: serve it, rebuild in the background (single-flighted inside).
    if (executionCtx) {
        executionCtx.waitUntil(rebuildModelCatalog(env));
    }
    else {
        await rebuildModelCatalog(env);
    }
    return models;
}
