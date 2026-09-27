// Thin provider executors ported 1:1 from @srouter/executors.
// Atria, B.AI, OpenCode Zen, TokenRouter, Experiential Labs, MiniMax,
// Neosantara — OpenAI-compatible with custom listModels.

import type { ModelObject } from "../types/index.js";
import { OpenAIExecutor, type OpenAIExecutorOptions } from "./openai.js";

// ---------------------------------------------------------------------------
// Atria
// ---------------------------------------------------------------------------

export interface AtriaExecutorOptions extends OpenAIExecutorOptions {}

export class AtriaExecutor extends OpenAIExecutor {
    constructor(options: AtriaExecutorOptions = {}) {
        super({
            id: options.id ?? "atria",
            name: options.name ?? "Atria",
            alias: options.alias ?? "atria",
            baseUrl: options.baseUrl ?? "https://api.atria-asi.ai/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken
        });
    }

    override async listModels(): Promise<ModelObject[]> {
        return [{ id: "atria/Atria-Dawn-Preview", object: "model", owned_by: "atria" }];
    }
}

// ---------------------------------------------------------------------------
// B.AI
// ---------------------------------------------------------------------------

const BAI_DEFAULT_MODELS = [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (Free)" },
    { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision Exp (Free)" },
    { id: "mimo-v2.5", name: "MiMo V2.5 (Free)" },
    { id: "qwen3.8-flash", name: "Qwen 3.8 Flash (Free/Low-tier)" }
];

export interface BAIExecutorOptions extends OpenAIExecutorOptions {}

export class BAIExecutor extends OpenAIExecutor {
    constructor(options: BAIExecutorOptions = {}) {
        super({
            id: options.id ?? "bai",
            name: options.name ?? "B.AI",
            baseUrl: options.baseUrl ?? "https://api.b.ai/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken
        });
    }

    override async listModels(): Promise<ModelObject[]> {
        const liveModels = await super.listModels();
        if (liveModels && liveModels.length > 0) {
            return liveModels;
        }
        const baseId = this.id.split("_")[0]?.split("-")[0] ?? this.id;
        return BAI_DEFAULT_MODELS.map((m) => ({
            id: `${baseId}/${m.id}`,
            object: "model" as const,
            owned_by: baseId
        }));
    }
}

// ---------------------------------------------------------------------------
// OpenCode Zen
// ---------------------------------------------------------------------------

export const OPENCODE_ZEN_MODELS = [
    { id: "big-pickle", name: "Big Pickle (Free)" },
    { id: "laguna-s-2.1-free", name: "Poolside Laguna S 2.1 (Free)" },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning (Free)" },
    { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra (Free)" },
    { id: "mimo-v2.5-free", name: "Xiaomi MiMo V2.5 (Free)" }
];

export interface OpenCodeZenExecutorOptions extends OpenAIExecutorOptions {}

export class OpenCodeZenExecutor extends OpenAIExecutor {
    constructor(options: OpenCodeZenExecutorOptions = {}) {
        super({
            id: options.id ?? "opencode_zen",
            name: options.name ?? "OpenCode Zen (Free)",
            baseUrl: options.baseUrl ?? "https://opencode.ai/zen/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken ?? ""
        });
    }

    override async listModels(): Promise<ModelObject[]> {
        const baseId = this.id.split("_")[0]?.split("-")[0] ?? this.id;
        return OPENCODE_ZEN_MODELS.map((m) => ({
            id: `${baseId}/${m.id}`,
            object: "model" as const,
            owned_by: baseId
        }));
    }
}

// ---------------------------------------------------------------------------
// TokenRouter
// ---------------------------------------------------------------------------

export interface TokenRouterExecutorOptions extends OpenAIExecutorOptions {}

export class TokenRouterExecutor extends OpenAIExecutor {
    constructor(options: TokenRouterExecutorOptions = {}) {
        super({
            id: options.id ?? "tokenrouter",
            name: options.name ?? "TokenRouter",
            baseUrl: options.baseUrl ?? "https://api.tokenrouter.com/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken
        });
    }
}

// ---------------------------------------------------------------------------
// Experiential Labs
// ---------------------------------------------------------------------------

export interface ExperientialLabsExecutorOptions extends OpenAIExecutorOptions {}

export class ExperientialLabsExecutor extends OpenAIExecutor {
    constructor(options: ExperientialLabsExecutorOptions = {}) {
        super({
            id: options.id ?? "experientiallabs",
            name: options.name ?? "Experiential Labs",
            baseUrl: options.baseUrl ?? "https://api.experientiallabs.ai/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken
        });
    }
}

// ---------------------------------------------------------------------------
// MiniMax
// ---------------------------------------------------------------------------

export interface MiniMaxExecutorOptions extends OpenAIExecutorOptions {}

export class MiniMaxExecutor extends OpenAIExecutor {
    constructor(options: MiniMaxExecutorOptions = {}) {
        super({
            id: options.id ?? "minimax",
            name: options.name ?? "MiniMax",
            baseUrl: options.baseUrl ?? "https://api.minimax.io/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken
        });
    }
}

// ---------------------------------------------------------------------------
// Neosantara
// ---------------------------------------------------------------------------

export interface NeosantaraExecutorOptions extends OpenAIExecutorOptions {}

export class NeosantaraExecutor extends OpenAIExecutor {
    constructor(options: NeosantaraExecutorOptions = {}) {
        super({
            id: options.id ?? "neosantara",
            name: options.name ?? "Neosantara",
            baseUrl: options.baseUrl ?? "https://api.neosantara.xyz/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken
        });
    }
}
