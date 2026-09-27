/**
 * Converts OpenAI ChatCompletionRequest into Anthropic MessageRequest format
 */
export function OpenAIToAnthropicRequest(req) {
    let systemPrompt = undefined;
    const anthropicMessages = [];
    for (const msg of req.messages) {
        if (msg.role === "system") {
            systemPrompt =
                typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        }
        else if (msg.role === "user" || msg.role === "assistant") {
            anthropicMessages.push({
                role: msg.role,
                content: (typeof msg.content === "string"
                    ? msg.content
                    : msg.content) ?? ""
            });
        }
    }
    return {
        model: req.model,
        messages: anthropicMessages,
        system: systemPrompt,
        max_tokens: req.max_tokens ?? 4096,
        temperature: req.temperature,
        top_p: req.top_p,
        stream: req.stream
    };
}
/**
 * Converts Anthropic MessageResponse into OpenAI ChatCompletionResponse format
 */
export function AnthropicToOpenAIResponse(res, requestedModel) {
    const textContent = res.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
    return {
        id: res.id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: textContent
                },
                finish_reason: res.stop_reason === "max_tokens" ? "length" : "stop"
            }
        ],
        usage: {
            prompt_tokens: res.usage.input_tokens,
            completion_tokens: res.usage.output_tokens,
            total_tokens: res.usage.input_tokens + res.usage.output_tokens
        }
    };
}
/**
 * Converts an Anthropic stream SSE line or chunk into an OpenAI ChatCompletionChunk
 */
export function AnthropicEventToOpenAIChunk(event, dataJson, requestedModel) {
    const completionId = dataJson?.message?.id || `chatcmpl-${dataJson?.index ?? 0}`;
    const created = Math.floor(Date.now() / 1000);
    if (event === "content_block_delta") {
        const deltaText = dataJson?.delta?.text ?? "";
        return {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: requestedModel,
            choices: [
                {
                    index: 0,
                    delta: { content: deltaText },
                    finish_reason: null
                }
            ]
        };
    }
    if (event === "message_stop") {
        return {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: requestedModel,
            choices: [
                {
                    index: 0,
                    delta: {},
                    finish_reason: "stop"
                }
            ]
        };
    }
    return null;
}
