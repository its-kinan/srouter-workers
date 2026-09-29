import type {
    ChatCompletionChunk,
    ChatCompletionRequest,
    ChatCompletionResponse,
    ModelObject
} from "./openai.js";
import type { RequestAttemptBudget } from "./attemptBudget.js";
import type { ImageGenerationRequest, ImageGenerationResponse } from "./images.js";

// --- Provider Spectrum & Catalog Types ---
export type ProviderCategory = "oauth" | "free_tier" | "api_key" | "custom_provider";

export type ProviderProtocol = "openai" | "anthropic" | "gemini" | "custom";

export type ProviderStatusState =
    "connected" | "disconnected" | "ready" | "no_connections" | "error";

export interface ProviderStatus {
    state: ProviderStatusState;
    message?: string;
    connectedCount?: number;
}

export interface ProviderDefinition {
    id: string;
    name: string;
    category: ProviderCategory;
    protocol: ProviderProtocol;
    description?: string;
    icon?: string;
    default_base_url?: string;
    base_url?: string;
    requires_api_key: boolean;
    requires_oauth?: boolean;
    supports_custom_url?: boolean;
    roundRobin?: boolean;
    enabled?: boolean;
    status: ProviderStatus;
    models: ModelObject[];
    connections?: ProviderConfig[];
}

export interface ProviderConfig {
    id: string;
    providerId: string;
    name: string;
    alias?: string;
    category?: ProviderCategory;
    protocol?: ProviderProtocol;
    base_url?: string;
    apiKey?: string;
    accessToken?: string;
    refreshToken?: string;
    accountId?: string;
    tokenExpiresAt?: number;
    lastRefreshedAt?: number;
    organizationId?: string;
    customHeaders?: Record<string, string>;
    providerSpecificData?: Record<string, string>;
    enabled: boolean;
    createdAt: number;
}

/**
 * Symbol-keyed channel for a pre-serialized upstream request body.
 * The router serializes the translated chat payload ONCE per request and
 * attaches the string here; executors that understand it skip their own
 * JSON.stringify (saves ~ms per failover/hedge attempt on large prompts —
 * real 1102 budget on the Free plan). Executors that don't understand it
 * ignore the symbol and serialize as before.
 */
export const PRE_SERIALIZED_BODY: unique symbol = Symbol.for("switch.preSerializedBody");

export interface AIProvider {
    id: string;
    name: string;
    alias?: string;
    category?: ProviderCategory;
    protocol?: ProviderProtocol;
    listModels(): Promise<ModelObject[]>;
    chatCompletion(
        req: ChatCompletionRequest,
        budget?: RequestAttemptBudget
    ): Promise<ChatCompletionResponse>;
    chatCompletionStream(
        req: ChatCompletionRequest,
        budget?: RequestAttemptBudget
    ): AsyncGenerator<ChatCompletionChunk, void, void>;
    generateImage?(
        req: ImageGenerationRequest,
        budget?: RequestAttemptBudget
    ): Promise<ImageGenerationResponse>;
    /**
     * Build the exact serialized upstream payload for a chat request.
     * Optional: executors that implement it let the router serialize once
     * per request and reuse the string across failover/hedge attempts
     * (via PRE_SERIALIZED_BODY) instead of re-stringifying per attempt.
     */
    serializeChatPayload?(req: ChatCompletionRequest, stream: boolean): string | undefined;
}
