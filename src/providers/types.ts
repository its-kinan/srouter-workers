// Provider adapter contracts for the Workers port.
//
// The vendored SRouter executors already implement the AIProvider shape
// (listModels / chatCompletion / chatCompletionStream). This module defines
// the decrypted account record handed to them and the factory table that maps
// a provider type to its executor.

import type {
    AIProvider,
    ChatCompletionChunk,
    ChatCompletionRequest,
    ChatCompletionResponse,
    ImageGenerationRequest,
    ImageGenerationResponse,
    ModelObject,
    RequestAttemptBudget
} from "../vendor/types/index.js";

/** A provider account row from D1 with secrets decrypted. Never logged. */
export interface DecryptedAccount {
    /** providers.id — unique per account, e.g. "antigravity_1727443200". */
    id: string;
    /** Base provider type, e.g. "antigravity", "qoder", "grok-cli". */
    providerType: string;
    name: string;
    alias?: string;
    category: "api_key" | "oauth";
    protocol: string;
    baseUrl?: string;
    apiKey?: string;
    accessToken?: string;
    refreshToken?: string;
    accountId?: string;
    organizationId?: string;
    /** Decrypted provider_specific_data JSON (project ids, user ids, ...). */
    extra: Record<string, unknown>;
    customHeaders?: Record<string, string>;
    enabled: boolean;
    /** Token expiry timestamp (ms) for OAuth accounts, null if unknown. */
    tokenExpiresAt?: number | null;
    /** Last refresh timestamp (ms) for OAuth accounts, null if never. */
    lastRefreshedAt?: number | null;
    /**
     * The encrypted secrets envelope this was decrypted from. Carried so a
     * DecryptedAccount stays structurally assignable to AccountMeta
     * (selection helpers accept either).
     */
    secretsEnc?: string | null;
}

/** Narrower than AIProvider: what the router actually calls. */
export interface ProviderAdapter {
    readonly adapterId: string;
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
}

export function asAdapter(executor: AIProvider, adapterId: string): ProviderAdapter {
    return {
        adapterId,
        listModels: () => executor.listModels(),
        chatCompletion: (req, budget) => executor.chatCompletion(req, budget),
        chatCompletionStream: (req, budget) => executor.chatCompletionStream(req, budget),
        generateImage: executor.generateImage
            ? (req, budget) => executor.generateImage!(req, budget)
            : undefined
    };
}

/** Routing prefixes for a provider type: "<type>/" and "<alias>/" model prefixes. */
export function routingPrefixes(providerType: string, alias?: string): string[] {
    const prefixes = [providerType];
    if (alias && alias !== providerType) prefixes.push(alias);
    return prefixes;
}
