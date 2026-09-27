// Grok CLI executor — NEW adapter (no SRouter equivalent).
//
// Mapping derived from 9router's grok-cli provider (open-sse/providers/registry/grok-cli.js),
// which was itself captured from the official @xai-official/grok CLI wire traffic:
//   - Transport: OpenAI Responses API
//   - Base:      https://cli-chat-proxy.grok.com/v1
//   - Chat:      POST {base}/responses   (streaming)
//   - Models:    GET  {base}/models
//   - Auth:      Authorization: Bearer <oauth access token>
//                x-xai-token-auth: xai-grok-cli
//                x-grok-client-version: 0.2.99
//                x-grok-client-identifier: grok-shell
//   - OAuth:     device-code flow at https://auth.x.ai/oauth2/device/code
//                (Phase 2; Phase 1 consumes pre-provisioned accounts migrated
//                from 9router, whose tokens refresh via the cron sweeper then)

import type {
    ChatCompletionChunk,
    ChatCompletionRequest,
    ChatCompletionResponse,
    ModelObject,
    RequestAttemptBudget
} from "../vendor/types/index.js";
import {
    accumulateChunks,
    ChatToResponsesBody,
    CreateResponsesStreamState,
    NormalizeResponsesInput,
    ResponsesEventToChunk,
    type ResponsesRequestBody,
    type ResponsesStreamEventData
} from "../vendor/translator/index.js";
import { parseDataLine, streamLines } from "../vendor/executors/base.js";

export const GROK_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const GROK_CLI_VERSION = "0.2.99";
const GROK_CLI_USER_AGENT = `grok-shell/${GROK_CLI_VERSION} (linux; x86_64)`;

// Fallback catalog (mirrors 9router's registry) when /models is unreachable.
const FALLBACK_MODELS: ModelObject[] = [
    { id: "grok-build", object: "model", owned_by: "grok-cli" },
    { id: "grok-4.5", object: "model", owned_by: "grok-cli" },
    { id: "grok-4.5-high", object: "model", owned_by: "grok-cli" },
    { id: "grok-4.5-medium", object: "model", owned_by: "grok-cli" },
    { id: "grok-4.5-low", object: "model", owned_by: "grok-cli" }
];

export interface GrokCliExecutorOptions {
    id?: string;
    name?: string;
    baseUrl?: string;
    accessToken?: string;
    apiKey?: string;
    refreshToken?: string;
}

export class GrokCliExecutor {
    id: string;
    name: string;
    category = "oauth" as const;
    protocol = "openai" as const;
    private baseUrl: string;
    private accessToken: string;
    private apiKey: string;
    private refreshToken?: string;

    constructor(options: GrokCliExecutorOptions = {}) {
        this.id = options.id ?? "grok-cli";
        this.name = options.name ?? "Grok CLI";
        this.baseUrl = (options.baseUrl ?? GROK_CLI_BASE_URL).replace(/\/$/, "");
        this.accessToken = options.accessToken ?? "";
        this.apiKey = options.apiKey ?? "";
        this.refreshToken = options.refreshToken;
    }

    updateToken(accessToken: string, refreshToken?: string): void {
        if (accessToken) this.accessToken = accessToken;
        if (refreshToken) this.refreshToken = refreshToken;
    }

    private getHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": GROK_CLI_USER_AGENT,
            "x-xai-token-auth": "xai-grok-cli",
            "x-grok-client-version": GROK_CLI_VERSION,
            "x-grok-client-identifier": "grok-shell"
        };
        const token = this.accessToken || this.apiKey;
        if (token) headers["Authorization"] = `Bearer ${token}`;
        return headers;
    }

    async listModels(): Promise<ModelObject[]> {
        const token = this.accessToken || this.apiKey;
        if (!token) return FALLBACK_MODELS;
        try {
            const res = await fetch(`${this.baseUrl}/models`, {
                method: "GET",
                headers: this.getHeaders()
            });
            if (!res.ok) return FALLBACK_MODELS;
            const json = (await res.json()) as {
                data?: Array<{ id?: string; name?: string }>;
            };
            if (!Array.isArray(json.data) || json.data.length === 0) return FALLBACK_MODELS;
            return json.data
                .filter((m) => m.id)
                .map((m) => ({ id: m.id!, object: "model" as const, owned_by: "grok-cli" }));
        } catch {
            return FALLBACK_MODELS;
        }
    }

    async chatCompletion(
        req: ChatCompletionRequest,
        budget?: RequestAttemptBudget
    ): Promise<ChatCompletionResponse> {
        const chunks: ChatCompletionChunk[] = [];
        for await (const chunk of this.chatCompletionStream(req, budget)) {
            chunks.push(chunk);
        }
        return accumulateChunks(chunks, req.model);
    }

    async *chatCompletionStream(
        req: ChatCompletionRequest,
        _budget?: RequestAttemptBudget
    ): AsyncGenerator<ChatCompletionChunk, void, void> {
        const body = this.transformRequest(req);
        const res = await fetch(`${this.baseUrl}/responses`, {
            method: "POST",
            headers: this.getHeaders(),
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Grok CLI Provider Error (${res.status}): ${text.slice(0, 500)}`);
        }
        if (!res.body) throw new Error("No response body received for streaming");

        const state = CreateResponsesStreamState(req.model);
        let pendingEvent = "";
        for await (const line of streamLines(res.body)) {
            if (line.startsWith("event:")) {
                pendingEvent = line.slice(6).trim();
                continue;
            }
            const jsonStr = parseDataLine(line);
            if (jsonStr === null) continue;
            try {
                const parsed = JSON.parse(jsonStr) as ResponsesStreamEventData;
                const eventType =
                    (parsed.type as string) || pendingEvent || "response.output_text.delta";
                const chunk = ResponsesEventToChunk(eventType, parsed, state);
                if (chunk) yield chunk;
            } catch {
                // ignore malformed lines
            }
        }
    }

    private transformRequest(req: ChatCompletionRequest): ResponsesRequestBody {
        const body = ChatToResponsesBody(req);
        const bare = req.model.includes("/")
            ? (req.model.split("/").pop() ?? req.model)
            : req.model;
        body.model = bare;
        body.stream = true;
        body.store = false;
        const normalized = NormalizeResponsesInput(body.input);
        if (normalized) body.input = normalized;
        // Drop params the proxy rejects
        for (const k of [
            "temperature",
            "top_p",
            "frequency_penalty",
            "presence_penalty",
            "logprobs",
            "top_logprobs",
            "n",
            "seed",
            "max_tokens",
            "max_completion_tokens",
            "max_output_tokens",
            "user",
            "metadata",
            "stream_options",
            "safety_identifier",
            "previous_response_id"
        ]) {
            delete (body as Record<string, unknown>)[k];
        }
        return body;
    }
}
