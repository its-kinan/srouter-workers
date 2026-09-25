// Gemini CLI adapter — SCAFFOLD (Phase 1).
//
// Gap: SRouter has no gemini-cli provider; this adapter is mapped from
// 9router's gemini-cli provider (open-sse/providers/registry/gemini-cli.js):
//   - OAuth: Google OAuth (same Google cloud-platform scope family as Antigravity)
//   - Project discovery: POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
//   - Chat: Gemini API protocol against https://cloudcode-pa.googleapis.com/v1internal
//     (generateContent / streamGenerateContent with a cloud project id)
//
// This is the same Cloud Code protocol family SRouter's Antigravity executor
// already speaks (daily-cloudcode-pa.googleapis.com), so Phase 2 can share the
// vendored Gemini translator plumbing (buildAntigravityContents,
// geminiStreamToOpenAIChunks) with a cloudcode-pa transport.
//
// Phase 1 status: registered in the provider factory so accounts can be stored
// and listed; chat requests return a clear error until the transport lands.

import type {
    ChatCompletionChunk,
    ChatCompletionRequest,
    ChatCompletionResponse,
    ModelObject,
    RequestAttemptBudget
} from "../vendor/types/index.js";

export const GEMINI_CLI_BASE_URL = "https://cloudcode-pa.googleapis.com/v1internal";

const FALLBACK_MODELS: ModelObject[] = [
    { id: "gemini-3.5-flash", object: "model", owned_by: "gemini-cli" },
    { id: "gemini-3.1-pro", object: "model", owned_by: "gemini-cli" }
];

const NOT_READY =
    "gemini-cli transport not implemented in Phase 1 (see src/providers/geminicli.ts). " +
    "Tracked for Phase 2: cloudcode-pa Gemini transport sharing the Antigravity translator plumbing.";

export interface GeminiCliAdapterOptions {
    id?: string;
    name?: string;
    baseUrl?: string;
    accessToken?: string;
    refreshToken?: string;
    projectId?: string;
}

export class GeminiCliAdapter {
    id: string;
    name: string;
    category = "oauth" as const;
    protocol = "gemini" as const;

    constructor(options: GeminiCliAdapterOptions = {}) {
        this.id = options.id ?? "gemini-cli";
        this.name = options.name ?? "Gemini CLI";
    }

    async listModels(): Promise<ModelObject[]> {
        return FALLBACK_MODELS;
    }

    async chatCompletion(
        _req: ChatCompletionRequest,
        _budget?: RequestAttemptBudget
    ): Promise<ChatCompletionResponse> {
        throw new Error(NOT_READY);
    }

    async *chatCompletionStream(
        _req: ChatCompletionRequest,
        _budget?: RequestAttemptBudget
    ): AsyncGenerator<ChatCompletionChunk, void, void> {
        throw new Error(NOT_READY);
    }
}
