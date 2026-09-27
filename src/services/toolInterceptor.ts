// Web-search tool-call interception — ported from
// SRouter apps/api/src/services/toolInterceptor.ts.
//
// When an upstream model emits a tool call for a known search tool
// (web_search, google_search, brave_search, ...), the gateway executes the
// search locally via performWebSearch instead of passing the call through to
// the client. Search API keys come from Worker secrets (see Env).

import { performWebSearch, type WebSearchOptions, type WebSearchResponse } from "../vendor/executors/search.js";
import type { ChatMessage, ToolCall, ToolDefinition } from "../vendor/types/index.js";

export const INTERCEPTED_SEARCH_TOOLS = new Set([
    "web_search",
    "web_search_preview",
    "search",
    "google_search",
    "duckduckgo_search",
    "brave_search",
    "bing_search"
]);

/** Maximum follow-up recursion depth (matches the original). */
export const MAX_INTERCEPT_DEPTH = 3;

/**
 * Check if the client explicitly provided a tool in their request `tools` array.
 * Client-defined tools are never intercepted — only model-emitted calls for
 * tools the client did not define.
 */
export function isToolProvidedByClient(tools: unknown, toolName: string): boolean {
    if (!Array.isArray(tools) || tools.length === 0) return false;
    return tools.some((t) => {
        if (t && typeof t === "object") {
            const fnName = (t as { function?: { name?: string } }).function?.name;
            const name = (t as { name?: string }).name;
            return fnName === toolName || name === toolName;
        }
        return false;
    });
}

/**
 * Check if a tool call should be intercepted server-side.
 * It is intercepted if:
 * 1. The tool name is a known search tool (e.g. web_search, google_search).
 * 2. The client did NOT define this tool in their request `tools` parameter.
 */
export function shouldInterceptToolCall(toolName: string, clientTools?: unknown): boolean {
    const normalized = toolName.toLowerCase().trim();
    if (!INTERCEPTED_SEARCH_TOOLS.has(normalized)) return false;
    return !isToolProvidedByClient(clientTools, toolName);
}

/**
 * Safely parse the query string from tool call arguments (JSON or raw text).
 */
export function extractSearchQuery(argsString?: string): string {
    if (!argsString) return "";
    try {
        const parsed = JSON.parse(argsString);
        if (typeof parsed === "string") return parsed;
        if (parsed && typeof parsed === "object") {
            const val =
                parsed.query ??
                parsed.q ??
                parsed.search_query ??
                parsed.searchTerm ??
                parsed.search ??
                parsed.keyword ??
                parsed.text;
            if (typeof val === "string") return val;
            return JSON.stringify(parsed);
        }
    } catch {
        return argsString.trim();
    }
    return String(argsString).trim();
}

/**
 * Execute web search for a given tool call and format the response payload.
 */
export async function executeInterceptedSearch(
    toolCall: ToolCall | { id?: string; function: { name: string; arguments?: string } },
    searchOptions: WebSearchOptions = {}
): Promise<{ toolCallId: string; result: WebSearchResponse }> {
    const toolCallId = toolCall.id || `call_search_${Date.now()}`;
    const query = extractSearchQuery(toolCall.function.arguments);
    const searchResponse = await performWebSearch(query, 5, searchOptions);
    return {
        toolCallId,
        result: searchResponse
    };
}

export interface AssembledSearchToolCall {
    id: string;
    name: string;
    arguments: string;
}

/**
 * Build follow-up messages after intercepting search tool calls:
 * [original messages..., assistant message with tool_calls, tool result messages...]
 * Only tool calls that should be intercepted get a synthesized tool response;
 * anything else is left for the client to handle (no interception).
 */
export async function buildFollowUpSearchMessages(
    baseMessages: ChatMessage[],
    assistantMessage: ChatMessage,
    toolCalls: AssembledSearchToolCall[],
    clientTools?: ToolDefinition[],
    searchOptions: WebSearchOptions = {}
): Promise<ChatMessage[]> {
    const updatedMessages: ChatMessage[] = [...baseMessages, assistantMessage];
    for (const tc of toolCalls) {
        if (shouldInterceptToolCall(tc.name, clientTools)) {
            const { toolCallId, result } = await executeInterceptedSearch(
                {
                    id: tc.id,
                    function: { name: tc.name, arguments: tc.arguments }
                },
                searchOptions
            );
            updatedMessages.push({
                role: "tool",
                tool_call_id: toolCallId,
                content: JSON.stringify(result)
            } as ChatMessage);
        }
    }
    return updatedMessages;
}

/**
 * True when any of the given tool calls should be intercepted server-side.
 */
export function hasInterceptableSearchCall(
    toolCalls: Array<{ name: string }>,
    clientTools?: unknown
): boolean {
    return toolCalls.some((tc) => shouldInterceptToolCall(tc.name, clientTools));
}
