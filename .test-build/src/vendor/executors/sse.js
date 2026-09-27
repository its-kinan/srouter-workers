// Shared SSE error-extraction helpers for executors.
export const MODEL_CAPACITY_MESSAGE = "Selected model is at capacity. Please try a different model.";
function findNestedMessage(value, depth = 0) {
    if (!value || depth > 6 || typeof value === "string")
        return null;
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findNestedMessage(item, depth + 1);
            if (found)
                return found;
        }
        return null;
    }
    if (typeof value !== "object")
        return null;
    const obj = value;
    if (typeof obj.message === "string" && obj.message.trim())
        return obj.message;
    if (typeof obj.error?.message === "string" &&
        obj.error.message.trim()) {
        return obj.error.message;
    }
    if (typeof obj.response?.error?.message === "string" &&
        obj.response.error.message.trim()) {
        return obj.response.error.message;
    }
    for (const child of Object.values(obj)) {
        const found = findNestedMessage(child, depth + 1);
        if (found)
            return found;
    }
    return null;
}
/**
 * Extract a human-readable error message from an SSE body that returned 200-OK
 * but carries an upstream error. Falls back to the capacity message.
 */
export function extractSseErrorMessage(text, fallback) {
    const exact = text?.match(/Selected model is at capacity\. Please try a different model\./i)?.[0];
    if (exact)
        return exact;
    for (const line of String(text || "").split(/\r?\n/)) {
        if (!line.startsWith("data:"))
            continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]")
            continue;
        try {
            const message = findNestedMessage(JSON.parse(data));
            if (message)
                return message;
        }
        catch {
            // ignore
        }
    }
    return fallback || MODEL_CAPACITY_MESSAGE;
}
