import { randomUUID } from "node:crypto";
const DEFAULT_MAX_TOKENS = 4096;
function flattenText(content) {
    if (content == null)
        return "";
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .map((p) => typeof p === "string"
            ? p
            : p && typeof p === "object" && "text" in p && typeof p.text === "string"
                ? p.text
                : "")
            .filter(Boolean)
            .join("\n");
    }
    return String(content);
}
function toContentBlocks(content) {
    if (content == null)
        return [{ type: "text", text: "" }];
    if (typeof content === "string")
        return [{ type: "text", text: content }];
    if (Array.isArray(content)) {
        const blocks = [];
        for (const part of content) {
            if (typeof part === "string") {
                blocks.push({ type: "text", text: part });
            }
            else if (part && typeof part === "object") {
                const p = part;
                if (p.type === "image_url" || p.type === "image") {
                    blocks.push({ type: "text", text: "[image omitted]" });
                }
                else if (typeof p.text === "string") {
                    blocks.push({ type: "text", text: p.text });
                }
            }
        }
        return blocks.length ? blocks : [{ type: "text", text: "" }];
    }
    return [{ type: "text", text: String(content) }];
}
function parseJsonArguments(args) {
    if (!args)
        return {};
    try {
        return JSON.parse(args);
    }
    catch {
        return {};
    }
}
function mapAssistantMessage(m) {
    const blocks = [];
    const text = flattenText(m.content);
    if (text)
        blocks.push({ type: "text", text });
    if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
            blocks.push({
                type: "tool-call",
                toolCallId: tc.id || "",
                toolName: tc.function?.name || "",
                input: parseJsonArguments(tc.function?.arguments)
            });
        }
    }
    return {
        role: "assistant",
        content: blocks.length ? blocks : [{ type: "text", text: "" }]
    };
}
function mapToolMessage(m) {
    const value = typeof m.content === "string" ? m.content : flattenText(m.content);
    return {
        role: "tool",
        content: [
            {
                type: "tool-result",
                toolCallId: m.tool_call_id || "",
                toolName: m.name || "",
                output: { type: "text", value }
            }
        ]
    };
}
function mapMessages(messages) {
    const out = [];
    const systemTexts = [];
    for (const m of messages) {
        if (!m)
            continue;
        if (m.role === "system") {
            const t = flattenText(m.content);
            if (t)
                systemTexts.push(t);
            continue;
        }
        if (m.role === "tool") {
            out.push(mapToolMessage(m));
            continue;
        }
        if (m.role === "assistant") {
            out.push(mapAssistantMessage(m));
            continue;
        }
        out.push({ role: "user", content: toContentBlocks(m.content) });
    }
    return { messages: out, system: systemTexts.join("\n\n") };
}
function mapTools(tools) {
    if (!Array.isArray(tools) || tools.length === 0)
        return undefined;
    const result = [];
    for (const t of tools) {
        if (!t || t.type !== "function" || !t.function)
            continue;
        result.push({
            name: t.function.name,
            description: t.function.description,
            input_schema: t.function.parameters || { type: "object" }
        });
    }
    return result.length ? result : undefined;
}
export function buildRequestBody(req) {
    const { messages, system } = mapMessages(req.messages);
    const model = req.model.includes("/") ? req.model.slice(req.model.indexOf("/") + 1) : req.model;
    const params = {
        model,
        messages,
        stream: true,
        max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
        temperature: req.temperature ?? 0.3
    };
    if (system)
        params.system = system;
    const tools = mapTools(req.tools);
    if (tools)
        params.tools = tools;
    if (req.top_p != null)
        params.top_p = req.top_p;
    return {
        threadId: randomUUID(),
        memory: "",
        config: {
            workingDir: process.cwd(),
            date: new Date().toISOString().slice(0, 10),
            environment: process.platform,
            structure: [],
            isGitRepo: false,
            currentBranch: "",
            mainBranch: "",
            gitStatus: "",
            recentCommits: []
        },
        params
    };
}
export function createCommandCodeStreamState() {
    return {
        responseId: "",
        created: 0,
        model: "",
        chunkIndex: 0,
        toolIndex: 0,
        toolIndexById: new Map(),
        openTools: new Set(),
        finishReason: null,
        usage: null
    };
}
function ensureState(state, model) {
    if (!state.responseId) {
        state.responseId = `chatcmpl-${Date.now()}`;
        state.created = Math.floor(Date.now() / 1000);
        state.model = model || "commandcode";
        state.chunkIndex = 0;
        state.toolIndex = 0;
        state.toolIndexById = new Map();
        state.openTools = new Set();
        state.finishReason = null;
        state.usage = null;
    }
}
function makeChunk(state, delta, finishReason = null) {
    return {
        id: state.responseId,
        object: "chat.completion.chunk",
        created: state.created,
        model: state.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }]
    };
}
function mapFinishReason(reason) {
    switch (reason) {
        case "stop":
            return "stop";
        case "length":
            return "length";
        case "tool-calls":
        case "tool_use":
            return "tool_calls";
        case "content-filter":
            return "content_filter";
        case "error":
            return "stop";
        default:
            return reason || "stop";
    }
}
function fallbackToolCallId(index) {
    return `call_${index}_${Date.now()}`;
}
export function commandCodeEventToOpenAIChunk(event, state) {
    if (!event || typeof event !== "object" || !event.type)
        return [];
    ensureState(state, event.model ?? "");
    const out = [];
    switch (event.type) {
        case "text-delta": {
            const text = event.text || event.delta || "";
            if (!text)
                break;
            const delta = state.chunkIndex === 0 ? { role: "assistant", content: text } : { content: text };
            state.chunkIndex++;
            out.push(makeChunk(state, delta));
            break;
        }
        case "reasoning-delta": {
            const text = event.text || "";
            if (!text)
                break;
            const delta = state.chunkIndex === 0
                ? { role: "assistant", reasoning_content: text }
                : { reasoning_content: text };
            state.chunkIndex++;
            out.push(makeChunk(state, delta));
            break;
        }
        case "tool-input-start": {
            const id = event.id || event.toolCallId || fallbackToolCallId(state.toolIndex);
            let idx = state.toolIndexById.get(id);
            if (idx == null) {
                idx = state.toolIndex++;
                state.toolIndexById.set(id, idx);
            }
            state.openTools.add(id);
            const delta = {
                ...(state.chunkIndex === 0 ? { role: "assistant" } : {}),
                tool_calls: [
                    {
                        index: idx,
                        id,
                        type: "function",
                        function: { name: event.toolName || "", arguments: "" }
                    }
                ]
            };
            state.chunkIndex++;
            out.push(makeChunk(state, delta));
            break;
        }
        case "tool-input-delta": {
            const id = event.id || event.toolCallId;
            if (!id)
                break;
            const idx = state.toolIndexById.get(id);
            if (idx == null)
                break;
            const delta = {
                tool_calls: [
                    {
                        index: idx,
                        function: { arguments: event.delta || event.inputTextDelta || "" }
                    }
                ]
            };
            out.push(makeChunk(state, delta));
            break;
        }
        case "tool-call": {
            const id = event.toolCallId;
            if (!id || state.toolIndexById.has(id))
                break;
            const idx = state.toolIndex++;
            state.toolIndexById.set(id, idx);
            const argsStr = typeof event.input === "string" ? event.input : JSON.stringify(event.input ?? {});
            const delta = {
                ...(state.chunkIndex === 0 ? { role: "assistant" } : {}),
                tool_calls: [
                    {
                        index: idx,
                        id,
                        type: "function",
                        function: { name: event.toolName || "", arguments: argsStr }
                    }
                ]
            };
            state.chunkIndex++;
            out.push(makeChunk(state, delta));
            break;
        }
        case "finish-step": {
            state.finishReason = mapFinishReason(event.finishReason);
            if (event.usage)
                state.usage = event.usage;
            break;
        }
        case "finish": {
            const finishReason = state.finishReason || mapFinishReason(event.finishReason || "stop");
            const finalChunk = makeChunk(state, {}, finishReason);
            const totalUsage = event.totalUsage || state.usage;
            const usage = mapOpenAIUsage(totalUsage);
            if (usage)
                finalChunk.usage = usage;
            out.push(finalChunk);
            break;
        }
        case "error": {
            const errVal = event.error ?? event.message ?? "unknown";
            const errStr = typeof errVal === "string" ? errVal : JSON.stringify(errVal);
            out.push(makeChunk(state, { content: `\n\n[CommandCode error: ${errStr}]` }));
            out.push(makeChunk(state, {}, "stop"));
            break;
        }
        default:
            break;
    }
    return out;
}
function mapOpenAIUsage(raw) {
    if (!raw)
        return null;
    const prompt_tokens = raw.inputTokens ?? 0;
    const completion_tokens = raw.outputTokens ?? 0;
    const total_tokens = raw.totalTokens ?? prompt_tokens + completion_tokens;
    return { prompt_tokens, completion_tokens, total_tokens };
}
export function accumulateChunks(chunks, model) {
    let content = "";
    let reasoningContent = "";
    const toolCalls = [];
    const toolCallMap = new Map();
    for (const chunk of chunks) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta)
            continue;
        if (typeof delta.content === "string")
            content += delta.content;
        const reasoning = delta.reasoning_content ||
            delta.reasoning;
        if (typeof reasoning === "string")
            reasoningContent += reasoning;
        if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const entry = toolCallMap.get(idx) || { id: "", name: "", args: "" };
                if (tc.id)
                    entry.id = tc.id;
                if (tc.function?.name)
                    entry.name = tc.function.name;
                if (tc.function?.arguments)
                    entry.args += tc.function.arguments;
                toolCallMap.set(idx, entry);
            }
        }
    }
    for (const entry of toolCallMap.values()) {
        toolCalls.push({
            id: entry.id,
            type: "function",
            function: { name: entry.name, arguments: entry.args }
        });
    }
    const finishReason = chunks.at(-1)?.choices?.[0]?.finish_reason ?? "stop";
    const usage = [...chunks].reverse().find((c) => c.usage)?.usage;
    // Fallback: If content is empty but reasoning_content exists (e.g. reasoning models like glm-5.3 / kimi-k3),
    // supply reasoning_content so downstream callers expecting text content don't crash with None/null.
    const effectiveContent = content || reasoningContent || null;
    return {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: effectiveContent,
                    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
                    ...(toolCalls.length ? { tool_calls: toolCalls } : {})
                },
                finish_reason: finishReason
            }
        ],
        ...(usage ? { usage } : {})
    };
}
