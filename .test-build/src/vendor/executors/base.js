// Shared helpers for executors.
/**
 * Renders an upstream error payload as a single human-readable line so thrown
 * executor errors surface the provider's message instead of "[object Object]".
 */
export function DescribeErrorPayload(payload) {
    if (typeof payload === "string")
        return payload || "Unknown upstream error";
    if (payload) {
        const message = payload.message || JSON.stringify(payload);
        return payload.code ? `${message} (${payload.code})` : message;
    }
    return "Unknown upstream error";
}
// Async iterator over the non-empty trimmed lines of a fetch Response body.
// Handles both OpenAI-style "data: ..." framing and raw NDJSON lines.
export async function* streamLines(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed)
                yield trimmed;
        }
    }
}
// Strips the SSE "data:" prefix from a line, returning null for comments/[DONE].
export function parseDataLine(line) {
    if (!line.startsWith("data:"))
        return line;
    const rest = line.slice(5).trim();
    if (!rest || rest === "[DONE]")
        return null;
    return rest;
}
